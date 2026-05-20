# Ciao Green — Commercial Landing Page

A production-ready landing page for Ciao Green's commercial interior business. Static HTML + Tailwind on the front-end, one Vercel serverless function on the back-end that connects to Zoho CRM (India DC), Google Analytics 4, Google Ads (via GTM), and Meta Ads (Pixel + Conversions API).

You own everything. The repo lives in your GitHub. The deploy lives in your Vercel. The CRM is your Zoho. No agency, no developer, no third party can lock you out.

---

## What's in this folder

```
ciaogreen-lp/
├── index.html         # The landing page
├── thank-you.html     # Post-submit page (noindex)
├── privacy.html       # DPDP-compliant privacy policy
├── api/
│   └── lead.js        # Serverless form handler (Zoho + GA4 + Meta CAPI + fallback)
├── robots.txt
├── sitemap.xml
├── vercel.json        # Deploy + security headers
├── package.json
└── .env.example       # Template for environment variables
```

## Preview locally (right now)

You don't need anything installed to see what it looks like:

1. Double-click `index.html` — it opens in your browser. The form won't submit (no backend running locally), but you can preview the whole page.
2. To preview the full thing including the form handler, install Node.js, then run:
   ```bash
   npm install -g vercel
   vercel dev
   ```
   The site comes up at http://localhost:3000.

---

## Deployment in 7 steps (about 30 minutes)

### Step 1 — Create the GitHub repo (5 min)

1. Sign in to GitHub with your personal email.
2. Click **New repository** → name it `ciaogreen-lp` → keep it Private.
3. Upload the contents of this folder via the GitHub web UI (drag and drop is fine), or use `git push`.

You now own the code.

### Step 2 — Create the Vercel account (5 min)

1. Go to **vercel.com**, sign up with your personal email.
2. Click **Add New → Project** → **Import Git Repository** → pick `ciaogreen-lp`.
3. On the deploy screen, leave everything default (it auto-detects).
4. Click **Deploy**. Two minutes later you'll have a live URL like `ciaogreen-lp.vercel.app`.

You now own the hosting.

### Step 3 — Generate Zoho CRM credentials (5 min)

1. Log in to **Zoho CRM**.
2. **Setup → Developer Space → APIs → Self Client** → **Create**.
3. Copy the **Client ID** and **Client Secret**.
4. Click **Generate Code** → scope: `ZohoCRM.modules.leads.CREATE,ZohoCRM.modules.leads.READ` → time: `10 minutes` → click Create.
5. Copy the **grant token** that appears.
6. In a terminal, run (replace placeholders):
   ```bash
   curl -X POST "https://accounts.zoho.in/oauth/v2/token" \
     -d "client_id=YOUR_CLIENT_ID" \
     -d "client_secret=YOUR_CLIENT_SECRET" \
     -d "grant_type=authorization_code" \
     -d "code=YOUR_GRANT_TOKEN"
   ```
   You'll get back a `refresh_token`. **Save this — it never expires.**

> If you'd rather not touch the terminal, ask any Zoho admin partner — this is a 10-minute job they do daily.

### Step 4 — Set up Google Analytics 4 (5 min)

1. Open **analytics.google.com** → **Admin** → **Create property** → **Web** → enter `get.ciaogreen.com` → grab the **Measurement ID** (`G-XXXXXXXXXX`).
2. **Admin → Data Streams → your stream → Measurement Protocol API secrets → Create** → copy the value.

### Step 5 — Set up Meta Conversions API (5 min)

1. In **Meta Events Manager**, open your Pixel (create one if you don't have one — name it `Ciao Green Website`).
2. **Settings → Conversions API → Set up manually → Generate access token** → copy.
3. Note the **Pixel ID**.

### Step 6 — Plug everything into Vercel (5 min)

1. In your Vercel project, go to **Settings → Environment Variables**.
2. Add one row per variable from `.env.example`. Paste values from the previous steps. Apply to Production + Preview + Development.
3. Hit **Save**.
4. Go to **Deployments** → click the most recent → **Redeploy**. This makes the env vars take effect.

### Step 7 — Point the domain (5 min)

1. In Vercel, **Settings → Domains → Add**, enter `get.ciaogreen.com` (or whatever subdomain you want).
2. Vercel shows you a CNAME record. Log in to wherever ciaogreen.com's DNS is managed (GoDaddy, Hostinger, etc.) and add the CNAME.
3. Within 10 minutes the subdomain serves the new LP over HTTPS automatically.

Done. The new LP is live, completely isolated from the old pages.

---

## Replace placeholders before going live

Search the files for these and replace:

| Placeholder | Where | What to replace it with |
|---|---|---|
| `GTM-XXXXXXX` | `index.html`, `thank-you.html` | Your GTM container ID (see GTM setup below) |
| `get.ciaogreen.com` | `index.html`, `robots.txt`, `sitemap.xml`, schema JSON-LD | Your real subdomain |
| `og.jpg` | `index.html` | A 1200×630 cover image at `/og.jpg` |
| `U70200KA2017PTC107XXX` | `index.html` footer | Your actual CIN |
| `29AAXCS1234X1ZX` | `index.html` footer | Your actual GST number |
| Logo placeholder tiles | `index.html` trust section | Real client SVG/PNG logos in `/logos/` |
| Featured project gradient cards | `index.html` work section | Real project photos as `<img>` |

## GTM setup (so Google Ads & Meta fire on form submit)

1. Create a GTM container at **tagmanager.google.com**.
2. Replace `GTM-XXXXXXX` in the two HTML files with your real ID.
3. Inside GTM, create:
   - **GA4 Configuration tag** (all pages) — uses your `G-XXXXXXXXXX`.
   - **GA4 Event tag** `generate_lead` — trigger: Custom Event = `lead_submit`.
   - **Google Ads Conversion Linker** (all pages).
   - **Google Ads Conversion tag** — trigger: Custom Event = `lead_submit`. Turn on **Enhanced Conversions** and map the form email/phone fields.
   - **Meta Pixel base** (all pages).
   - **Meta Pixel Lead event** — trigger: Custom Event = `lead_submit`. Pass the `eventId` data-layer variable to deduplicate with the server-side CAPI fire.

The page already pushes `lead_submit` to the dataLayer with the right fields when the form succeeds — you just wire the tags.

## Testing checklist

- [ ] Open the live URL on your phone — page renders, sticky bottom bar works.
- [ ] Submit the form with a test name — lead appears in Zoho CRM under Leads.
- [ ] In GA4 → Realtime, see the `generate_lead` event.
- [ ] In Meta Events Manager → Test Events (with `META_TEST_EVENT_CODE` set), see the `Lead` event with `event_id`.
- [ ] In Google Ads → Tools → Conversions, see the conversion tracked.
- [ ] Run **PageSpeed Insights** on the URL — confirm Performance ≥ 90 on mobile.
- [ ] Validate at **search.google.com/test/rich-results** — confirm Organization, LocalBusiness, FAQ, BreadcrumbList all detected.

## Editing the page later

The page is plain HTML. Any developer can open `index.html` and change text, swap images, or add sections. No build step, no framework. If you want a non-developer CMS, ask for the Sanity.io integration option.

## When you're ready to migrate traffic

When the new LP is winning vs the old ones, add 301 redirects from the old URLs to the new one:

In `vercel.json` under `"redirects"`:
```json
{ "source": "/", "has": [{ "type": "host", "value": "design.ciaogreen.com" }], "destination": "https://get.ciaogreen.com/", "permanent": true }
```

Or set up redirects in whatever host runs the old WordPress site.

---

## Support

This codebase is yours. Hand it to any web developer or AI builder (Cursor, v0, Lovable) and they can extend it. No proprietary frameworks, no agency lock-in.
