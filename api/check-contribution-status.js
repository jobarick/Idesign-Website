/* ============================================================
   idesign - Badili Bongo mobile payment status check
   Vercel Serverless Function.  GET /api/check-contribution-status?ref=...

   The frontend polls this after initiate-mobile-payment.js sends a
   USSD-PUSH request, so the visitor sees a live "check your phone" /
   "received" state without ever leaving idesign.co.tz.

   This endpoint only relays status back to the browser - it does not
   send the admin notification email. That happens once, centrally,
   from api/clickpesa-webhook.js, which a merchant-level webhook
   registered in the ClickPesa dashboard (Settings > Developers >
   Webhooks, pointed at https://idesign.co.tz/api/clickpesa-webhook)
   fires for both this payment method and Hosted Checkout alike. This
   file used to also send that email, which meant a payment observed
   by both the webhook and a poll here could double-notify; the fix
   was to make the webhook the single source of truth for that, not
   to fix the duplication here.
   ============================================================ */

'use strict';

const TOKEN_URL = 'https://api.clickpesa.com/third-parties/generate-token';
const QUERY_URL = 'https://api.clickpesa.com/third-parties/payments/';

/* Must match initiate-mobile-payment.js's orderReference() shape:
   "BB" + up to 8 base36 timestamp chars + 6 base36 random chars. */
const OWN_REFERENCE_RE = /^BB[0-9A-Z]{6,18}$/;

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
    /* Docs say 404 means "payment not found"; live testing shows
       ClickPesa actually returns 400 for a reference with no
       matching payment yet (e.g. checked before initiate-ussd-push-
       request's response even lands). Treat both as "nothing to
       report yet" rather than an error. */
    if (queryResp.status === 404 || queryResp.status === 400) {
      return res.status(200).json({ ok: true, status: 'PENDING' });
    }
    if (!queryResp.ok) {
      const detail = await queryResp.text().catch(function () { return ''; });
      console.error('check-contribution-status: query ' + queryResp.status + ' ' + detail.slice(0, 400));
      return res.status(502).json({ ok: false });
    }
    const data = await queryResp.json();
    const payment = Array.isArray(data) ? data[0] : data;
    if (!payment) return res.status(200).json({ ok: true, status: 'PENDING' });

    const status = String(payment.status || '').toUpperCase();
    return res.status(200).json({ ok: true, status: status || 'PENDING' });
  } catch (err) {
    console.error('check-contribution-status: failed', err && err.message);
    return res.status(502).json({ ok: false });
  }
};
