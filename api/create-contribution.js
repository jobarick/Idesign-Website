/* ============================================================
   idesign - Badili Bongo contribution checkout
   Vercel Serverless Function.  POST /api/create-contribution

   Takes an amount (and optional name/email) from the support page,
   asks ClickPesa for a Hosted Checkout link, and hands that link
   back to the browser to redirect to. Idesign never sees or stores
   a card number, wallet PIN, or any payment credential - ClickPesa's
   hosted page owns the entire payment step.

   CLICKPESA_CLIENT_ID, CLICKPESA_API_KEY and CLICKPESA_CHECKSUM_KEY
   are read from the environment and never leave the server, for the
   same reason RESEND_API_KEY doesn't in api/contact.js: every file
   under the site root is publicly downloadable. The checksum key is
   a separate secret from the Client ID/API Key pair - found in the
   ClickPesa merchant dashboard, not the same place as those two.

   No npm dependency: ClickPesa is called over its REST API using
   the runtime's built-in fetch, matching api/contact.js.

   ClickPesa specifics (verified against docs.clickpesa.com,
   September 2026 - confirm against current docs before relying on
   this in production, since payment APIs change):
     - No sandbox exists. Testing happens on live production with
       small real amounts.
     - Before KYC approval, ClickPesa caps an account at TZS 100,000
       combined across collections/payouts/deposits and 100 API
       calls/day. Confirm KYC status before a real campaign launches.
     - Fees and settlement timing are not published in the docs and
       must be confirmed from the merchant dashboard or the account's
       own agreement - nothing here assumes a fee percentage.
     - The Return URL a visitor lands on after paying is configured
       in the ClickPesa dashboard (Settings), not per-request. Set it
       to https://idesign.co.tz/support-thanks before this goes live.
   ============================================================ */

'use strict';

const crypto = require('crypto');

const TOKEN_URL = 'https://api.clickpesa.com/third-parties/generate-token';
const CHECKOUT_URL = 'https://api.clickpesa.com/third-parties/checkout-link/generate-checkout-url';

/* Per docs.clickpesa.com/home/checksum.md: recursively sort object
   keys, stringify with no whitespace, HMAC-SHA256 with the merchant's
   checksum key, hex-encode. Order-independent by design. */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.keys(value).sort().reduce(function (acc, key) {
    acc[key] = canonicalize(value[key]);
    return acc;
  }, {});
}
function checksumFor(checksumKey, payload) {
  const hmac = crypto.createHmac('sha256', checksumKey);
  hmac.update(JSON.stringify(canonicalize(payload)));
  return hmac.digest('hex');
}

/* Round-number guardrails, not a claim about what's "right" to give.
   MIN stops accidental near-zero submissions; MAX stops a typo (or
   an abuse attempt) from generating a checkout link for an
   implausible amount. Both are easy to change here if they're wrong
   for how people actually want to give. */
const MIN_TZS = 1000;
const MAX_TZS = 5000000;

const LIMITS = { name: 100, email: 254 };
const EMAIL_RE = /^[^\s@,;:<>()[\]\\"]+@[^\s@,;:<>()[\]\\".]+(\.[^\s@,;:<>()[\]\\".]+)+$/;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function plain(value, max) {
  return String(value == null ? '' : value).replace(CONTROL_RE, '').trim().slice(0, max);
}
function headerSafe(value) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
}

/* Same best-effort per-IP throttle as api/contact.js - a speed bump
   against a single abusive script, not a hard global limit. See
   that file's comment for why the numbers are this generous. */
const RATE = new Map();
const RATE_MAX = 20;
const RATE_WINDOW_MS = 15 * 60 * 1000;
function rateLimited(ip) {
  const now = Date.now();
  const hits = (RATE.get(ip) || []).filter(function (t) { return now - t < RATE_WINDOW_MS; });
  hits.push(now);
  RATE.set(ip, hits);
  if (RATE.size > 500) {
    for (const k of RATE.keys()) { RATE.delete(k); if (RATE.size <= 500) break; }
  }
  return hits.length > RATE_MAX;
}

function orderReference() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return 'BB' + Date.now().toString(36).toUpperCase() + rand;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false });
  }

  const clientId = process.env.CLICKPESA_CLIENT_ID;
  const apiKey = process.env.CLICKPESA_API_KEY;
  const checksumKey = process.env.CLICKPESA_CHECKSUM_KEY;
  if (!clientId || !apiKey || !checksumKey) {
    console.error('create-contribution: CLICKPESA_CLIENT_ID / CLICKPESA_API_KEY / CLICKPESA_CHECKSUM_KEY not set');
    return res.status(500).json({ ok: false });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ ok: false }); }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ ok: false });

  /* Honeypot, same convention as the contact form. */
  if (plain(body['company-website'], 200)) return res.status(200).json({ ok: true });

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < MIN_TZS || amount > MAX_TZS) {
    return res.status(400).json({ ok: false, reason: 'amount' });
  }
  const totalPrice = String(Math.round(amount));

  const name = headerSafe(plain(body.name, LIMITS.name));
  const email = headerSafe(plain(body.email, LIMITS.email)).toLowerCase();
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ ok: false, reason: 'email' });

  const ip = headerSafe(String(req.headers['x-forwarded-for'] || '').split(',')[0]) || 'unknown';
  if (rateLimited(ip)) return res.status(429).json({ ok: false });

  try {
    const tokenResp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'client-id': clientId, 'api-key': apiKey }
    });
    if (!tokenResp.ok) {
      const detail = await tokenResp.text().catch(function () { return ''; });
      console.error('create-contribution: token request ' + tokenResp.status + ' ' + detail.slice(0, 400));
      return res.status(502).json({ ok: false });
    }
    const tokenData = await tokenResp.json();
    const rawToken = tokenData && tokenData.token;
    if (!rawToken) {
      console.error('create-contribution: token response carried no token');
      return res.status(502).json({ ok: false });
    }
    /* ClickPesa's generate-token response already includes the "Bearer "
       prefix in the token field itself (per docs.clickpesa.com), so the
       Authorization header must use it as-is, not "Bearer " + token. */
    const authHeader = rawToken.indexOf('Bearer ') === 0 ? rawToken : 'Bearer ' + rawToken;

    const checkoutBody = {
      totalPrice: totalPrice,
      orderReference: orderReference(),
      orderCurrency: 'TZS',
      description: 'Support for Badili Bongo',
      callbackUrl: 'https://idesign.co.tz/api/clickpesa-webhook'
    };
    if (name) checkoutBody.customerName = name;
    if (email) checkoutBody.customerEmail = email;
    /* Computed over the body above, before adding the checksum field
       itself - checksum/checksumMethod are excluded from their own
       computation per ClickPesa's docs. */
    checkoutBody.checksum = checksumFor(checksumKey, checkoutBody);

    const checkoutResp = await fetch(CHECKOUT_URL, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(checkoutBody)
    });
    if (!checkoutResp.ok) {
      const detail = await checkoutResp.text().catch(function () { return ''; });
      console.error('create-contribution: checkout-link ' + checkoutResp.status + ' ' + detail.slice(0, 400));
      return res.status(502).json({ ok: false });
    }
    const checkoutData = await checkoutResp.json();
    if (!checkoutData || !checkoutData.checkoutLink) {
      console.error('create-contribution: checkout response carried no checkoutLink');
      return res.status(502).json({ ok: false });
    }

    return res.status(200).json({ ok: true, checkoutLink: checkoutData.checkoutLink });
  } catch (err) {
    console.error('create-contribution: failed', err && err.message);
    return res.status(502).json({ ok: false });
  }
};
