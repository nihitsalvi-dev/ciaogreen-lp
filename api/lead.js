// Vercel serverless function — POST /api/lead
// Handles: validation → Zoho CRM Lead create → GA4 server event → Meta CAPI Lead → fallback Sheet
// Deploys automatically on Vercel when this folder is connected to GitHub.

import crypto from 'node:crypto';

const ZOHO_DC = process.env.ZOHO_DC || 'in'; // 'in' | 'com' | 'eu' | 'au'
const ZOHO_API = `https://www.zohoapis.${ZOHO_DC}/crm/v6/Leads`;
const ZOHO_TOKEN_URL = `https://accounts.zoho.${ZOHO_DC}/oauth/v2/token`;

// Simple in-memory cache for the Zoho access token (per warm Lambda)
let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

async function getZohoAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }
  const body = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token'
  });
  const r = await fetch(ZOHO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!r.ok) throw new Error('Zoho token refresh failed: ' + r.status);
  const j = await r.json();
  cachedAccessToken = j.access_token;
  cachedAccessTokenExpiresAt = Date.now() + (j.expires_in || 3600) * 1000;
  return cachedAccessToken;
}

async function createZohoLead(payload) {
  const token = await getZohoAccessToken();
  const data = {
    data: [{
      Last_Name: payload.fullName || 'Unknown',
      Company: payload.company || 'Unknown',
      Phone: '+91' + (payload.phone || '').replace(/\D/g, ''),
      Email: payload.email || null,
      City: payload.city || null,
      Description: [
        payload.message ? 'Message: ' + payload.message : '',
        payload.spaceSize ? 'Space: ' + payload.spaceSize : '',
        payload.source ? 'Source: ' + payload.source : ''
      ].filter(Boolean).join('\n'),
      Lead_Source: 'Website - Landing Page',
      Lead_Status: 'Not Contacted',
      // Custom fields (create these in Zoho if you want them):
      // Space_Size:  payload.spaceSize,
      // UTM_Source:  payload.utm?.utm_source,
      // UTM_Medium:  payload.utm?.utm_medium,
      // UTM_Campaign:payload.utm?.utm_campaign
    }],
    trigger: ['workflow']
  };
  const r = await fetch(ZOHO_API, {
    method: 'POST',
    headers: {
      'Authorization': 'Zoho-oauthtoken ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(data)
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok || out?.data?.[0]?.status !== 'success') {
    throw new Error('Zoho lead create failed: ' + JSON.stringify(out));
  }
  return out.data[0].details.id;
}

async function sendGA4Event(payload, eventId) {
  if (!process.env.GA4_MEASUREMENT_ID || !process.env.GA4_API_SECRET) return;
  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${process.env.GA4_MEASUREMENT_ID}&api_secret=${process.env.GA4_API_SECRET}`;
  // Anonymous client_id — use a stable hash of phone for server-side stitching
  const client_id = crypto.createHash('sha256').update((payload.phone || '') + (payload.email || '')).digest('hex').slice(0, 16) + '.' + Math.floor(Date.now() / 1000);
  const body = {
    client_id,
    events: [{
      name: 'generate_lead',
      params: {
        engagement_time_msec: '100',
        event_id: eventId,
        currency: 'INR',
        value: 1,
        source: payload.source,
        city: payload.city,
        space_size: payload.spaceSize
      }
    }]
  };
  await fetch(url, { method: 'POST', body: JSON.stringify(body) }).catch(() => {});
}

async function sendMetaCAPI(payload, eventId, ip, ua) {
  if (!process.env.META_PIXEL_ID || !process.env.META_CAPI_ACCESS_TOKEN) return;
  const sha = (s) => crypto.createHash('sha256').update((s || '').toString().trim().toLowerCase()).digest('hex');
  const phoneE164 = '91' + (payload.phone || '').replace(/\D/g, '');
  const url = `https://graph.facebook.com/v19.0/${process.env.META_PIXEL_ID}/events?access_token=${process.env.META_CAPI_ACCESS_TOKEN}`;
  const body = {
    data: [{
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      event_source_url: payload.pageUrl,
      action_source: 'website',
      user_data: {
        em: payload.email ? [sha(payload.email)] : undefined,
        ph: [sha(phoneE164)],
        client_ip_address: ip,
        client_user_agent: ua,
        fbc: payload.utm?.fbclid ? `fb.1.${Math.floor(Date.now() / 1000)}.${payload.utm.fbclid}` : undefined
      },
      custom_data: {
        currency: 'INR',
        value: 1,
        city: payload.city,
        space_size: payload.spaceSize
      }
    }],
    test_event_code: process.env.META_TEST_EVENT_CODE || undefined
  };
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(() => {});
}

async function sendNotificationEmail(payload, leadId, zohoFailed, ip) {
  if (!process.env.RESEND_API_KEY || !process.env.NOTIFICATION_EMAIL_TO) return;

  const utm = payload.utm || {};
  const fmt = (v) => v ? String(v) : '—';
  const phone = (payload.phone || '').replace(/\D/g, '');
  const subjectName = payload.fullName || 'Unknown';
  const subjectCompany = payload.company ? ' / ' + payload.company : '';
  const subject = `New lead: ${subjectName}${subjectCompany}${zohoFailed ? ' (Zoho FAILED — check fallback)' : ''}`;

  const row = (label, value) => `
    <tr>
      <td style="padding:6px 12px;color:#666;font-size:13px;border-bottom:1px solid #eee;white-space:nowrap;">${label}</td>
      <td style="padding:6px 12px;color:#111;font-size:14px;border-bottom:1px solid #eee;">${value}</td>
    </tr>`;

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:620px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    <div style="background:#0f4d2e;color:#fff;padding:18px 24px;">
      <div style="font-size:13px;opacity:.8;letter-spacing:1px;">CIAO GREEN — NEW LEAD</div>
      <div style="font-size:22px;font-weight:700;margin-top:4px;">${subjectName}${subjectCompany}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      ${row('Phone', `<a href="tel:+91${phone}" style="color:#0f4d2e;font-weight:600;">+91 ${phone}</a>`)}
      ${row('Email', payload.email ? `<a href="mailto:${payload.email}" style="color:#0f4d2e;">${payload.email}</a>` : '—')}
      ${row('Company', fmt(payload.company))}
      ${row('City', fmt(payload.city))}
      ${row('Space size', fmt(payload.spaceSize))}
      ${row('Message', fmt(payload.message).replace(/\n/g, '<br>'))}
    </table>
    <div style="padding:14px 24px 6px;font-size:12px;color:#888;letter-spacing:.5px;">SOURCE</div>
    <table style="width:100%;border-collapse:collapse;">
      ${row('UTM source', fmt(utm.utm_source))}
      ${row('UTM medium', fmt(utm.utm_medium))}
      ${row('UTM campaign', fmt(utm.utm_campaign))}
      ${row('UTM term', fmt(utm.utm_term))}
      ${row('UTM content', fmt(utm.utm_content))}
      ${row('Google click ID', fmt(utm.gclid))}
      ${row('Meta click ID', fmt(utm.fbclid))}
      ${row('Landing URL', fmt(payload.pageUrl))}
      ${row('Referrer', fmt(payload.referrer))}
    </table>
    <div style="padding:14px 24px 6px;font-size:12px;color:#888;letter-spacing:.5px;">SYSTEM</div>
    <table style="width:100%;border-collapse:collapse;">
      ${row('Zoho Lead ID', leadId ? `<a href="https://crm.zoho.in/crm/org/tab/Leads/${leadId}" style="color:#0f4d2e;">${leadId}</a>` : '— (failed, queued to fallback)')}
      ${row('Zoho status', zohoFailed ? '<span style="color:#b00;">Failed — check fallback sheet</span>' : '<span style="color:#0a0;">Success</span>')}
      ${row('IP', fmt(ip))}
      ${row('Submitted at', new Date().toISOString())}
    </table>
    <div style="padding:18px 24px;background:#f9fafb;color:#555;font-size:12px;text-align:center;">
      Sent automatically by quote.ciaogreen.com
    </div>
  </div>`;

  const to = process.env.NOTIFICATION_EMAIL_TO.split(',').map(s => s.trim()).filter(Boolean);

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'Ciao Green LP <onboarding@resend.dev>',
        to,
        subject,
        html,
        reply_to: payload.email || undefined
      })
    });
  } catch (e) {
    console.error('Resend email failed', e);
  }
}

async function sendFallbackSheet(payload, err) {
  if (!process.env.FALLBACK_SHEET_WEBHOOK_URL) return;
  await fetch(process.env.FALLBACK_SHEET_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, error: err?.message || String(err), at: new Date().toISOString() })
  }).catch(() => {});
}

function validate(p) {
  if (!p || typeof p !== 'object') return 'Invalid payload';
  if (!p.fullName || p.fullName.length < 2) return 'Name required';
  if (!p.company || p.company.length < 2) return 'Company required';
  if (!/^[6-9]\d{9}$/.test((p.phone || '').replace(/\D/g, ''))) return 'Valid Indian mobile required';
  if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) return 'Invalid email';
  if (!p.consent) return 'Consent required';
  if (p.company_website) return 'Spam detected'; // honeypot
  return null;
}

export default async function handler(req, res) {
  // CORS — same-origin so this is mostly a no-op, but allows future subdomain hosting
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let payload;
  try { payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Bad JSON' }); }

  const err = validate(payload);
  if (err) return res.status(400).json({ error: err });

  const eventId = payload.eventId || crypto.randomUUID();
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress;
  const ua = req.headers['user-agent'] || '';

  // Try Zoho first; if it fails we still report success to the user and queue to fallback sheet.
  let leadId = null;
  let zohoFailed = false;
  try {
    leadId = await createZohoLead(payload);
  } catch (e) {
    zohoFailed = true;
    console.error('Zoho create failed', e);
    await sendFallbackSheet(payload, e);
  }

  // Fire analytics + ads + notification email in parallel — never penalise ad spend for CRM downtime
  await Promise.all([
    sendGA4Event(payload, eventId),
    sendMetaCAPI(payload, eventId, ip, ua),
    sendNotificationEmail(payload, leadId, zohoFailed, ip)
  ]);

  return res.status(200).json({
    ok: true,
    leadId: leadId || ('fallback-' + eventId.slice(0, 8)),
    zohoFailed
  });
}
