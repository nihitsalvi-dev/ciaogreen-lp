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
  if (p.company_website) return 'Spam detected';
  return null;
}

export default async function handler(req, res) {
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

  let leadId = null;
  let zohoFailed = false;
  try {
    leadId = await createZohoLead(payload);
  } catch (e) {
    zohoFailed = true;
    console.error('Zoho create failed', e);
    await sendFallbackSheet(payload, e);
  }

  await Promise.all([
    sendGA4Event(payload, eventId),
    sendMetaCAPI(payload, eventId, ip, ua)
  ]);

  return res.status(200).json({
    ok: true,
    leadId: leadId || ('fallback-' + eventId.slice(0, 8)),
    zohoFailed
  });
}
