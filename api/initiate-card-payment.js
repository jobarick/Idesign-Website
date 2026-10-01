/* ============================================================
   idesign - Badili Bongo international card payment
   Vercel Serverless Function.  POST /api/initiate-card-payment

   For supporters outside Tanzania without access to Tanzanian mobile
   money. ClickPesa's Card Payment API accepts Visa, Mastercard, Amex
   and UnionPay, but - per docs.clickpesa.com - even this "direct" API
   still opens a ClickPesa-hosted page for the actual card entry step;
   no ClickPesa integration lets a merchant's own page collect card
   numbers directly (standard PCI practice). This function only
   generates that link; it never sees a card number itself.

   CLICKPESA_CLIENT_ID, CLICKPESA_API_KEY and CLICKPESA_CHECKSUM_KEY
   are the same three secrets api/initiate-mobile-payment.js uses -
   same ClickPesa Application, a different endpoint on it.

   ClickPesa specifics (verified against docs.clickpesa.com,
   October 2026 - confirm against current docs before relying on this
   in production, since payment APIs change):
     - Currency is USD only for this endpoint - not TZS. Amount
       pickers on the page must be priced in USD for this method.
     - customer.fullName, customer.email and customer.phoneNumber are
       all required here, unlike the mobile money flow where name and
       email are optional.
     - No sandbox exists. Testing happens on live production with a
       small real amount.
     - checksum is documented as optional here too, but the same was
       true of checkout-link and initiate-ussd-push-request and both
       turned out to require it in practice - sent unconditionally.
     - Confirmation path is identical to the mobile money flow: no
       callbackUrl field on this request either, so the frontend polls
       api/check-contribution-status.js, and the admin notification
       email comes from api/clickpesa-webhook.js via the same
       merchant-level webhook.
   ============================================================ */

'use strict';

const crypto = require('crypto');

const TOKEN_URL = 'https://api.clickpesa.com/third-parties/generate-token';
const INITIATE_URL = 'https://api.clickpesa.com/third-parties/payments/initiate-card-payment';

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

/* Round-number guardrails in USD for an international contribution. */
const MIN_USD = 1;
const MAX_USD = 5000;

const LIMITS = { name: 100, email: 254 };
const EMAIL_RE = /^[^\s@,;:<>()[\]\\"]+@[^\s@,;:<>()[\]\\".]+(\.[^\s@,;:<>()[\]\\".]+)+$/;
/* Lenient international format: digits only after stripping
   formatting, 7-15 digits (E.164's own range), no country-specific
   assumption the way the mobile money flow's Tanzanian regex has. */
const PHONE_RE = /^\d{7,15}$/;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function plain(value, max) {
  return String(value == null ? '' : value).replace(CONTROL_RE, '').trim().slice(0, max);
}
function headerSafe(value) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
}
function normalizePhone(raw) {
  return String(raw == null ? '' : raw).replace(/[^\d]/g, '');
}

/* Same best-effort per-IP throttle as the other payment endpoints. */
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

/* Same "BB" + timestamp + random shape used everywhere else in this
   project, so check-contribution-status.js's OWN_REFERENCE_RE still
   recognises it. */
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
    console.error('initiate-card-payment: CLICKPESA_CLIENT_ID / CLICKPESA_API_KEY / CLICKPESA_CHECKSUM_KEY not set');
    return res.status(500).json({ ok: false });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ ok: false }); }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ ok: false });

  /* Honeypot, same convention as the other forms on the site. */
  if (plain(body['company-website'], 200)) return res.status(200).json({ ok: true });

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < MIN_USD || amount > MAX_USD) {
    return res.status(400).json({ ok: false, reason: 'amount' });
  }
  const totalPrice = String(amount.toFixed(2));

  const name = headerSafe(plain(body.name, LIMITS.name));
  const email = headerSafe(plain(body.email, LIMITS.email)).toLowerCase();
  const phone = normalizePhone(body.phone);
  if (!name) return res.status(400).json({ ok: false, reason: 'name' });
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ ok: false, reason: 'email' });
  if (!PHONE_RE.test(phone)) return res.status(400).json({ ok: false, reason: 'phone' });

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
      console.error('initiate-card-payment: token request ' + tokenResp.status + ' ' + detail.slice(0, 400));
      return res.status(502).json({ ok: false });
    }
    const tokenData = await tokenResp.json();
    const rawToken = tokenData && tokenData.token;
    if (!rawToken) {
      console.error('initiate-card-payment: token response carried no token');
      return res.status(502).json({ ok: false });
    }
    const authHeader = rawToken.indexOf('Bearer ') === 0 ? rawToken : 'Bearer ' + rawToken;

    const cardBody = {
      customer: { fullName: name, email: email, phoneNumber: phone },
      orderReference: ref,
      currency: 'USD',
      amount: totalPrice
    };
    cardBody.checksum = checksumFor(checksumKey, cardBody);

    const cardResp = await fetch(INITIATE_URL, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(cardBody)
    });
    if (!cardResp.ok) {
      const detail = await cardResp.text().catch(function () { return ''; });
      console.error('initiate-card-payment: initiate-card-payment ' + cardResp.status + ' ' + detail.slice(0, 400));
      return res.status(502).json({ ok: false });
    }
    const cardData = await cardResp.json();
    if (!cardData || !cardData.cardPaymentLink) {
      console.error('initiate-card-payment: response carried no cardPaymentLink');
      return res.status(502).json({ ok: false });
    }

    return res.status(200).json({ ok: true, orderReference: ref, cardPaymentLink: cardData.cardPaymentLink });
  } catch (err) {
    console.error('initiate-card-payment: failed', err && err.message);
    return res.status(502).json({ ok: false });
  }
};
