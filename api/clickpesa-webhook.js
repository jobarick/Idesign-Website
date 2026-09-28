/* ============================================================
   idesign - Badili Bongo contribution webhook
   Vercel Serverless Function.  POST /api/clickpesa-webhook

   ClickPesa calls this after a contribution succeeds or fails
   (PAYMENT RECEIVED / PAYMENT FAILED). It is the only reliable
   confirmation - the browser's own redirect back to the site can be
   closed, lost, or skipped, so nothing here depends on that
   happening.

   Set this exact URL as the Checkout Link's callbackUrl (already
   wired in api/create-contribution.js) and, separately, in the
   ClickPesa dashboard under Settings > Developers > Webhooks if a
   merchant-level webhook is wanted too.

   CHECKSUM VERIFICATION - NOT YET WIRED UP, DELIBERATELY.
   ClickPesa's webhook payload can carry a "checksum" and
   "checksumMethod" for verifying it actually came from ClickPesa,
   documented separately in their Checksum guide. That guide's exact
   algorithm was not confirmed while building this - rather than
   guess at a verification scheme and give false confidence, this
   handler does NOT trust the payload blindly: it only acts on a
   PAYMENT RECEIVED whose orderReference matches this project's own
   "BB" + timestamp format, which a forged request would have to
   guess. Read ClickPesa's Checksum documentation and add real
   verification here before this handles amounts anyone would miss.

   RESEND_API_KEY is reused from api/contact.js to notify on a
   successful contribution - no new secret needed.
   ============================================================ */

'use strict';

const INBOX = 'jobarick@gmail.com';
const OWN_REFERENCE_RE = /^BB[0-9A-Z]{6,}$/;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function notifyAdmin(payload) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('clickpesa-webhook: RESEND_API_KEY not set, skipping notification email');
    return;
  }
  const amount = payload.collectedAmount != null ? payload.collectedAmount : payload.amount;
  const currency = payload.currency || 'TZS';
  const ref = payload.orderReference || payload.reference || '(no reference)';
  const channel = payload.paymentChannel || payload.channel || '';
  const name = payload.customerName || '';
  const email = payload.customerEmail || '';

  const text = [
    'A new Badili Bongo contribution came through.',
    '',
    'Amount     : ' + amount + ' ' + currency,
    'Reference  : ' + ref,
    'Channel    : ' + (channel || '-'),
    'From       : ' + (name || '-') + (email ? ' <' + email + '>' : ''),
    '',
    'This is an automated notification from the ClickPesa webhook on idesign.co.tz.'
  ].join('\n');

  const html =
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#111110">' +
    '<p style="margin:0 0 16px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6B675F">' +
    'Badili Bongo &middot; contribution received</p>' +
    '<p><strong>' + escapeHtml(String(amount)) + ' ' + escapeHtml(currency) + '</strong></p>' +
    '<p style="color:#6B675F">Reference ' + escapeHtml(String(ref)) + (channel ? ' &middot; ' + escapeHtml(channel) : '') + '</p>' +
    (name || email ? '<p>From ' + escapeHtml(name) + (email ? ' &lt;' + escapeHtml(email) + '&gt;' : '') + '</p>' : '') +
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

  const status = String(body.status || body.event || '').toUpperCase();
  const ref = String(body.orderReference || body.reference || '');

  /* Always acknowledge with 2xx - ClickPesa's docs are explicit that
     this only confirms delivery, not processing, and a non-2xx here
     just causes pointless retries of an event we've already logged. */
  console.log('clickpesa-webhook: received status=' + status + ' ref=' + ref);

  if (status.indexOf('SUCCESS') !== -1 || status.indexOf('RECEIVED') !== -1) {
    if (OWN_REFERENCE_RE.test(ref)) {
      await notifyAdmin(body);
    } else {
      console.error('clickpesa-webhook: PAYMENT RECEIVED with an unrecognised reference, not notifying: ' + ref);
    }
  } else if (status.indexOf('FAIL') !== -1) {
    console.log('clickpesa-webhook: payment failed ref=' + ref + ' reason=' + (body.failureReason || body.reason || 'unspecified'));
  }

  return res.status(200).json({ ok: true });
};
