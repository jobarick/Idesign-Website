/* ============================================================
   idesign - Badili Bongo contribution webhook
   Vercel Serverless Function.  POST /api/clickpesa-webhook

   ClickPesa calls this after a contribution succeeds or fails
   (PAYMENT RECEIVED / PAYMENT FAILED) for USSD-PUSH payments
   (api/initiate-mobile-payment.js) via a merchant-level webhook. It
   is the single reliable confirmation path - a visitor's own browser
   session can be closed, lost, or never return, so nothing here
   depends on that happening.

   Registered in the ClickPesa dashboard under Settings > Developers
   > Webhooks: https://idesign.co.tz/api/clickpesa-webhook
   That registration is what was actually missing at first - a
   payment settled on 2026-09-29 (reference BBMUMK5DKSZA705F) without
   this ever being called, because no webhook was registered there.

   PAYLOAD SHAPE - corrected against docs.clickpesa.com/home/webhooks,
   September 2026. The event type and every payment field are nested
   under "data", not flat on the body:
     { "event": "PAYMENT RECEIVED", "data": { "status": "SUCCESS",
       "orderReference": "...", "collectedAmount": "...", ... } }
   The original version of this file assumed a flat body and never
   actually found a real orderReference in a live payload - it looked
   like it might be working (body.event happened to satisfy the
   status check by accident) but silently failed to notify on every
   real payment. Confirm this shape against current docs before
   relying on it further, since payloads change.

   CHECKSUM VERIFICATION - NOT YET WIRED UP, DELIBERATELY.
   ClickPesa's webhook payload can carry a "checksum" and
   "checksumMethod" for verifying it actually came from ClickPesa.
   Rather than guess at exactly how those apply to this payload shape
   and give false confidence, this handler does NOT trust the payload
   blindly: it only acts on a PAYMENT RECEIVED whose orderReference
   matches this project's own "BB" + timestamp format, which a forged
   request would have to guess. Add real checksum verification here
   before this handles amounts anyone would miss.

   This is the single place that sends the admin notification email -
   api/check-contribution-status.js only reports status back to the
   browser for the in-page UI, it does not also email, specifically
   to avoid a duplicate email when both this webhook and that polling
   endpoint observe the same successful payment.

   De-duplicated per orderReference below, because ClickPesa can call
   this more than once for one payment: SUCCESS and a later SETTLED
   are separate events per their payment-status docs, and a slow or
   erroring response here causes a genuine retry of the same event.
   Best-effort, per serverless instance - there is no database, so
   this is the honest ceiling on "exactly once" here, same as the
   rate limiters elsewhere in this project.

   RESEND_API_KEY is reused from api/contact.js - no new secret needed.
   ============================================================ */

'use strict';

const INBOX = 'jobarick@gmail.com';
const OWN_REFERENCE_RE = /^BB[0-9A-Z]{6,}$/;

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

async function notifyAdmin(data) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('clickpesa-webhook: RESEND_API_KEY not set, skipping notification email');
    return;
  }
  const amount = data.collectedAmount != null ? data.collectedAmount : data.amount;
  const currency = data.collectedCurrency || data.currency || 'TZS';
  const ref = data.orderReference || '(no reference)';
  const channel = data.channel || '';
  const customer = data.customer || {};
  const name = customer.customerName || '';
  const email = customer.customerEmail || '';
  const phone = customer.customerPhoneNumber || '';

  const text = [
    'A new Badili Bongo contribution came through.',
    '',
    'Amount     : ' + amount + ' ' + currency,
    'Reference  : ' + ref,
    'Channel    : ' + (channel || '-'),
    'From       : ' + (name || '-') + (phone ? ' (' + phone + ')' : '') + (email ? ' <' + email + '>' : ''),
    '',
    'This is an automated notification from the ClickPesa webhook on idesign.co.tz.'
  ].join('\n');

  const html =
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#111110">' +
    '<p style="margin:0 0 16px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6B675F">' +
    'Badili Bongo &middot; contribution received</p>' +
    '<p><strong>' + escapeHtml(String(amount)) + ' ' + escapeHtml(currency) + '</strong></p>' +
    '<p style="color:#6B675F">Reference ' + escapeHtml(String(ref)) + (channel ? ' &middot; ' + escapeHtml(channel) : '') + '</p>' +
    (name || phone || email ? '<p>From ' + escapeHtml(name) + (phone ? ' (' + escapeHtml(phone) + ')' : '') + (email ? ' &lt;' + escapeHtml(email) + '&gt;' : '') + '</p>' : '') +
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
      console.error('clickpesa-webhook: notification email failed ' + resp.status + ' ' + detail.slice(0, 400));
    }
  } catch (err) {
    console.error('clickpesa-webhook: notification email threw', err && err.message);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  /* "data" carries the actual payment fields; fall back to the body
     itself in case a differently-shaped event ever lands here. */
  const data = (body.data && typeof body.data === 'object') ? body.data : body;
  const event = String(body.event || '').toUpperCase();
  const status = String(data.status || event || '').toUpperCase();
  const ref = String(data.orderReference || '');

  /* Always acknowledge with 2xx - ClickPesa's docs are explicit that
     this only confirms delivery, not processing, and a non-2xx here
     just causes pointless retries of an event we've already logged. */
  console.log('clickpesa-webhook: received event=' + event + ' status=' + status + ' ref=' + ref);

  if (status.indexOf('SUCCESS') !== -1 || status.indexOf('RECEIVED') !== -1 || status === 'SETTLED') {
    if (!OWN_REFERENCE_RE.test(ref)) {
      console.error('clickpesa-webhook: PAYMENT RECEIVED with an unrecognised reference, not notifying: ' + ref);
    } else if (alreadyNotified(ref)) {
      console.log('clickpesa-webhook: already notified for ref=' + ref + ', skipping duplicate email');
    } else {
      await notifyAdmin(data);
    }
  } else if (status.indexOf('FAIL') !== -1) {
    console.log('clickpesa-webhook: payment failed ref=' + ref + ' reason=' + (data.message || 'unspecified'));
  }

  return res.status(200).json({ ok: true });
};
