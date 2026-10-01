/* ============================================================
   idesign - Badili Bongo direct mobile money payment
   Vercel Serverless Function.  POST /api/initiate-mobile-payment

   Sends a ClickPesa USSD-PUSH request straight to the visitor's own
   phone. Amount, name, email and phone are all collected on
   idesign.co.tz itself - nothing here redirects to a ClickPesa-hosted
   page. The visitor stays on badili-bongo/support, and a prompt to
   enter their mobile money PIN arrives on their own phone.

   CLICKPESA_CLIENT_ID, CLICKPESA_API_KEY and CLICKPESA_CHECKSUM_KEY
   are read from the environment and never leave the server, for the
   same reason RESEND_API_KEY doesn't in api/contact.js: every file
   under the site root is publicly downloadable.

   ClickPesa specifics (verified against docs.clickpesa.com,
   September 2026 - confirm against current docs before relying on
   this in production, since payment APIs change):
     - USSD-PUSH is mobile-money only (M-Pesa, Tigo Pesa, Airtel
       Money, Halotel, etc.) - no card support through this endpoint.
       Anyone who wants to pay by card or bank transfer uses the
       "Prefer bank transfer" contact option on the page instead.
     - No sandbox exists. Testing happens on live production with
       small real amounts.
     - orderReference must be alphanumeric and 20 characters or
       fewer - this file's orderReference() produces 16.
     - checksum is documented as optional on this endpoint, but a
       reference with no checksum was rejected in practice - sent
       unconditionally to be safe.
     - This endpoint's request body has no callbackUrl field. The
       frontend confirms status by polling
       api/check-contribution-status.js. The admin notification email
       comes separately from api/clickpesa-webhook.js, via a
       merchant-level webhook registered in the ClickPesa dashboard
       (Settings > Developers > Webhooks).
   ============================================================ */

'use strict';

const crypto = require('crypto');

const TOKEN_URL = 'https://api.clickpesa.com/third-parties/generate-token';
const INITIATE_URL = 'https://api.clickpesa.com/third-parties/payments/initiate-ussd-push-request';

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
   an abuse attempt) from pushing to an implausible amount. */
const MIN_TZS = 1000;
const MAX_TZS = 5000000;

const LIMITS = { name: 100, email: 254 };
const EMAIL_RE = /^[^\s@,;:<>()[\]\\"]+@[^\s@,;:<>()[\]\\".]+(\.[^\s@,;:<>()[\]\\".]+)+$/;
/* Tanzanian mobile numbers: country code 255, then 6 or 7, then 8
   more digits - 12 digits total, no plus sign, per ClickPesa's docs. */
const PHONE_RE = /^255[67]\d{8}$/;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function plain(value, max) {
  return String(value == null ? '' : value).replace(CONTROL_RE, '').trim().slice(0, max);
}
function headerSafe(value) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
}
/* Accepts 07XXXXXXXX, 7XXXXXXXX, +255712345678 or 255712345678 and
   normalises to the 255-prefixed, no-plus form ClickPesa expects. */
function normalizePhone(raw) {
  let digits = String(raw == null ? '' : raw).replace(/[^\d]/g, '');
  if (digits.indexOf('0') === 0) digits = '255' + digits.slice(1);
  else if (digits.length === 9) digits = '255' + digits;
  return digits;
}

/* Same best-effort per-IP throttle as api/contact.js. */
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

/* "BB" + timestamp + random, 16 characters - under the 20-character
   limit this endpoint enforces. check-contribution-status.js relies
   on this exact shape to recognise a reference as one of ours. */
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
    console.error('initiate-mobile-payment: CLICKPESA_CLIENT_ID / CLICKPESA_API_KEY / CLICKPESA_CHECKSUM_KEY not set');
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

  const phone = normalizePhone(body.phone);
  if (!PHONE_RE.test(phone)) return res.status(400).json({ ok: false, reason: 'phone' });

  const name = headerSafe(plain(body.name, LIMITS.name));
  const email = headerSafe(plain(body.email, LIMITS.email)).toLowerCase();
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ ok: false, reason: 'email' });

  const ip = headerSafe(String(req.headers['x-forwarded-for'] || '').split(',')[0]) || 'unknown';
  if (rateLimited(ip)) return res.status(429).json({ ok: false });

  const ref = orderReference();

  try {
    const tokenResp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'client-id': clientId, 'api-key': apiKey }
    });
    if (!tokenResp.ok) {
      const detail = await tokenResp.text().catch(function () { return ''; });
      console.error('initiate-mobile-payment: token request ' + tokenResp.status + ' ' + detail.slice(0, 400));
      return res.status(502).json({ ok: false });
    }
    const tokenData = await tokenResp.json();
    const rawToken = tokenData && tokenData.token;
    if (!rawToken) {
      console.error('initiate-mobile-payment: token response carried no token');
      return res.status(502).json({ ok: false });
    }
    /* ClickPesa's generate-token response already includes the "Bearer "
       prefix in the token field itself. */
    const authHeader = rawToken.indexOf('Bearer ') === 0 ? rawToken : 'Bearer ' + rawToken;

    const pushBody = {
      amount: totalPrice,
      currency: 'TZS',
      orderReference: ref,
      phoneNumber: phone
    };
    /* Computed before the checksum field itself is added - checksum
       is excluded from its own computation per ClickPesa's docs. */
    pushBody.checksum = checksumFor(checksumKey, pushBody);

    const pushResp = await fetch(INITIATE_URL, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(pushBody)
    });
    if (!pushResp.ok) {
      const detail = await pushResp.text().catch(function () { return ''; });
      console.error('initiate-mobile-payment: initiate-ussd-push-request ' + pushResp.status + ' ' + detail.slice(0, 400));
      return res.status(502).json({ ok: false });
    }
    const pushData = await pushResp.json();
    /* Whitelisted fields only - never the token, keys, checksum or phone. */
    console.log('initiate-mobile-payment: initiate-ussd-push-request ' + pushResp.status + ' ' + JSON.stringify({
      at: new Date().toISOString(),
      id: pushData && pushData.id,
      status: pushData && pushData.status,
      message: pushData && pushData.message,
      channel: pushData && pushData.channel,
      orderReference: (pushData && pushData.orderReference) || ref,
      collectedAmount: pushData && pushData.collectedAmount,
      collectedCurrency: pushData && pushData.collectedCurrency,
      createdAt: pushData && pushData.createdAt
    }));

    return res.status(200).json({
      ok: true,
      orderReference: ref,
      status: (pushData && pushData.status) || 'PROCESSING',
      channel: pushData && pushData.channel
    });
  } catch (err) {
    console.error('initiate-mobile-payment: failed', err && err.message);
    return res.status(502).json({ ok: false });
  }
};
