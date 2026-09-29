/* ============================================================
   idesign - Badili Bongo mobile payment status check
   Vercel Serverless Function.  GET /api/check-contribution-status?ref=...

   The frontend polls this after initiate-mobile-payment.js sends a
   USSD-PUSH request, so the visitor sees a live "check your phone" /
   "received" state without ever leaving idesign.co.tz.

   This is also where the admin notification email fires from. The
   initiate-ussd-push-request endpoint has no callbackUrl field (unlike
   checkout-link's), so there is no per-request webhook for this
   payment method - only a merchant-level webhook configured in the
   ClickPesa dashboard, which this project cannot assume is set up.
   Polling is the reliable path: the first time this sees a terminal
   SUCCESS/SETTLED status for a reference, it sends the email itself.

   RESEND_API_KEY is reused from api/contact.js - no new secret needed.
   ============================================================ */

'use strict';

const TOKEN_URL = 'https://api.clickpesa.com/third-parties/generate-token';
const QUERY_URL = 'https://api.clickpesa.com/third-parties/payments/';
const INBOX = 'jobarick@gmail.com';

/* Must match initiate-mobile-payment.js's orderReference() shape:
   "BB" + up to 8 base36 timestamp chars + 6 base36 random chars. */
const OWN_REFERENCE_RE = /^BB[0-9A-Z]{6,18}$/;

/* Best-effort de-dup so a payment that's polled repeatedly after
   going SUCCESS/SETTLED doesn't send a second email. Per serverless
   instance, same caveat as the rate limiters elsewhere in this
   project - there is no database, so this is the honest ceiling on
   how reliable "exactly once" can be here. */
const NOTIFIED = new Set();
function alreadyNotified(ref) {
  if (NOTIFIED.has(ref)) return true;
  NOTIFIED.add(ref);
  if (NOTIFIED.size > 500) {
    const first = NOTIFIED.values().next().value;
    NOTIFIED.delete(first);
  }
  return false;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function notifyAdmin(payment) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('check-contribution-status: RESEND_API_KEY not set, skipping notification email');
    return;
  }
  const amount = payment.collectedAmount != null ? payment.collectedAmount : payment.amount;
  const currency = payment.collectedCurrency || 'TZS';
  const ref = payment.orderReference || '(no reference)';
  const channel = payment.channel || '';
  const customer = payment.customer || {};
  const name = customer.customerName || '';
  const phone = customer.customerPhoneNumber || payment.paymentPhoneNumber || '';

  const text = [
    'A new Badili Bongo contribution came through (direct mobile money).',
    '',
    'Amount     : ' + amount + ' ' + currency,
    'Reference  : ' + ref,
    'Channel    : ' + (channel || '-'),
    'From       : ' + (name || '-') + (phone ? ' (' + phone + ')' : ''),
    '',
    'This is an automated notification from idesign.co.tz.'
  ].join('\n');

  const html =
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#111110">' +
    '<p style="margin:0 0 16px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6B675F">' +
    'Badili Bongo &middot; contribution received</p>' +
    '<p><strong>' + escapeHtml(String(amount)) + ' ' + escapeHtml(currency) + '</strong></p>' +
    '<p style="color:#6B675F">Reference ' + escapeHtml(String(ref)) + (channel ? ' &middot; ' + escapeHtml(channel) : '') + '</p>' +
    (name || phone ? '<p>From ' + escapeHtml(name) + (phone ? ' (' + escapeHtml(phone) + ')' : '') + '</p>' : '') +
    '</div>';

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Badili Bongo contributions (idesign) <onboarding@resend.dev>',
        to: [INBOX],
        subject: '[idesign] Badili Bongo contribution: ' + amount + ' ' + currency,
        text: text,
        html: html
      })
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(function () { return ''; });
      console.error('check-contribution-status: notification email failed ' + resp.status + ' ' + detail.slice(0, 400));
    }
  } catch (err) {
    console.error('check-contribution-status: notification email threw', err && err.message);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false });
  }

  const ref = String((req.query && req.query.ref) || '');
  if (!OWN_REFERENCE_RE.test(ref)) return res.status(400).json({ ok: false });

  const clientId = process.env.CLICKPESA_CLIENT_ID;
  const apiKey = process.env.CLICKPESA_API_KEY;
  if (!clientId || !apiKey) {
    console.error('check-contribution-status: CLICKPESA_CLIENT_ID / CLICKPESA_API_KEY not set');
    return res.status(500).json({ ok: false });
  }

  try {
    const tokenResp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'client-id': clientId, 'api-key': apiKey }
    });
    if (!tokenResp.ok) {
      console.error('check-contribution-status: token request ' + tokenResp.status);
      return res.status(502).json({ ok: false });
    }
    const tokenData = await tokenResp.json();
    const rawToken = tokenData && tokenData.token;
    if (!rawToken) return res.status(502).json({ ok: false });
    const authHeader = rawToken.indexOf('Bearer ') === 0 ? rawToken : 'Bearer ' + rawToken;

    const queryResp = await fetch(QUERY_URL + encodeURIComponent(ref), {
      headers: { 'Authorization': authHeader }
    });
    if (queryResp.status === 404) {
      return res.status(200).json({ ok: true, status: 'PENDING' });
    }
    if (!queryResp.ok) {
      console.error('check-contribution-status: query ' + queryResp.status);
      return res.status(502).json({ ok: false });
    }
    const data = await queryResp.json();
    const payment = Array.isArray(data) ? data[0] : data;
    if (!payment) return res.status(200).json({ ok: true, status: 'PENDING' });

    const status = String(payment.status || '').toUpperCase();

    if ((status === 'SUCCESS' || status === 'SETTLED') && !alreadyNotified(ref)) {
      await notifyAdmin(payment);
    }

    return res.status(200).json({ ok: true, status: status || 'PENDING' });
  } catch (err) {
    console.error('check-contribution-status: failed', err && err.message);
    return res.status(502).json({ ok: false });
  }
};
