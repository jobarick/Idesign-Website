/* ============================================================
   idesign - contact form handler
   Vercel Serverless Function.  POST /api/contact

   The visitor never chooses the recipient. The browser sends a
   department KEY ("landscape", "cgi", ...) and this file maps that
   key to an address. Any address supplied by the visitor is
   ignored entirely.

   RESEND_API_KEY is read from the environment and never leaves the
   server. It must not appear in any file under the site root,
   since every one of those is publicly downloadable.

   No npm dependency: Resend is called over its REST API using the
   runtime's built-in fetch, which keeps this project free of a
   package.json and a build step.
   ============================================================ */

'use strict';

/* Where enquiries are read. The four department addresses cannot
   receive mail today - idesign.co.tz has no working MX - so mail
   is delivered here and the department is carried in the sender
   name and the subject line. */
const INBOX = 'jobarick@gmail.com';

/* Controlled routing table. The key arrives from the form; the
   address is decided here and nowhere else. */
const DEPARTMENTS = {
  landscape: { label: 'Idesign Landscape', address: 'landscape@idesign.co.tz' },
  cgi:       { label: 'Idesign CGI',       address: 'cgi@idesign.co.tz'       },
  lifestyle: { label: 'Idesign Lifestyle', address: 'lifestyle@idesign.co.tz' },
  lab:       { label: 'Idefenda Lab',      address: 'lab@idesign.co.tz'       },
  badili:    { label: 'Badili Bongo',      address: 'badilibongo@gmail.com'   }
};

/* Resend only sends from a verified domain. Until idesign.co.tz
   finishes verification, mail goes out through Resend's shared
   sender, which needs no DNS.

   Set CONTACT_SENDER_DOMAIN=idesign.co.tz in Vercel once the domain
   shows Verified, and every department then sends from its own
   address with no code change. */
const SENDER_DOMAIN = (process.env.CONTACT_SENDER_DOMAIN || '').trim();
const FALLBACK_SENDER = 'onboarding@resend.dev';

const LIMITS = { name: 100, email: 254, phone: 40, location: 120, message: 5000 };

/* Deliberately conservative: no display names, no quoting, no
   comment syntax. Anything unusual is rejected rather than guessed
   at. */
const EMAIL_RE = /^[^\s@,;:<>()[\]\\"]+@[^\s@,;:<>()[\]\\".]+(\.[^\s@,;:<>()[\]\\".]+)+$/;

/* C0/C1 control characters, excluding tab and newline. */
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/* Remove anything that could terminate or forge a header line.
   Applied to every value that reaches a header. Without it, a
   newline in the name field could inject a Bcc. */
function headerSafe(value) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
}

/* Strip control characters while keeping the newlines a message
   body legitimately contains. */
function plain(value, max) {
  return String(value == null ? '' : value).replace(CONTROL_RE, '').trim().slice(0, max);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Best-effort throttle. Serverless instances are recycled, so this
   bounds a burst against one warm instance rather than enforcing a
   global limit. It is a speed bump for casual abuse; the honeypot
   and validation do the real work. */
const RATE = new Map();
const RATE_MAX = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;

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

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false });
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('contact: RESEND_API_KEY is not set');
    return res.status(500).json({ ok: false });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ ok: false }); }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ ok: false });

  /* Honeypot. A real visitor never sees this field, so anything in
     it is a bot. Answer 200 so the bot learns nothing. */
  if (plain(body['company-website'], 200)) return res.status(200).json({ ok: true });

  /* hasOwnProperty, not a plain lookup: "__proto__" and
     "constructor" would otherwise resolve to inherited Object
     members, pass a truthy check, and send a malformed email. */
  const deptKey = plain(body.department, 40).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(DEPARTMENTS, deptKey)) {
    return res.status(400).json({ ok: false });
  }
  const dept = DEPARTMENTS[deptKey];

  const name     = headerSafe(plain(body.name, LIMITS.name));
  const email    = headerSafe(plain(body.email, LIMITS.email)).toLowerCase();
  const phone    = headerSafe(plain(body.phone, LIMITS.phone));
  const location = headerSafe(plain(body.location, LIMITS.location));
  const message  = plain(body.message, LIMITS.message);

  if (!name || !message) return res.status(400).json({ ok: false });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false });

  const ip = headerSafe(String(req.headers['x-forwarded-for'] || '').split(',')[0]) || 'unknown';
  if (rateLimited(ip)) return res.status(429).json({ ok: false });

  const from = SENDER_DOMAIN
    ? dept.label + ' <' + dept.address.split('@')[0] + '@' + SENDER_DOMAIN + '>'
    : dept.label + ' (idesign) <' + FALLBACK_SENDER + '>';

  const subject = headerSafe('[idesign] ' + dept.label + ' - enquiry from ' + name);

  const text = [
    'Department : ' + dept.label + '  (' + dept.address + ')',
    'Name       : ' + name,
    'Email      : ' + email,
    'Phone      : ' + (phone || '-'),
    'Location   : ' + (location || '-'),
    '',
    message,
    '',
    'Sent from the contact form on idesign.co.tz'
  ].join('\n');

  const row = function (k, v) {
    return '<tr><td style="padding:4px 20px 4px 0;color:#6B675F">' + k +
           '</td><td>' + v + '</td></tr>';
  };

  const html =
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#111110">' +
    '<p style="margin:0 0 16px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6B675F">' +
      escapeHtml(dept.label) + ' &middot; enquiry</p>' +
    '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:20px">' +
      row('Name', escapeHtml(name)) +
      row('Email', '<a href="mailto:' + escapeHtml(email) + '">' + escapeHtml(email) + '</a>') +
      row('Phone', escapeHtml(phone || '-')) +
      row('Location', escapeHtml(location || '-')) +
      row('Routed to', escapeHtml(dept.address)) +
    '</table>' +
    '<div style="white-space:pre-wrap;border-left:1px solid #E3E0DA;padding-left:16px">' +
      escapeHtml(message) + '</div>' +
    '<p style="margin-top:24px;font-size:12px;color:#6B675F">Sent from the contact form on ' +
      'idesign.co.tz. Reply to this message and it goes straight to the visitor.</p>' +
    '</div>';

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: from,
        to: [INBOX],
        reply_to: email,
        subject: subject,
        text: text,
        html: html
      })
    });

    if (!resp.ok) {
      /* Logged server-side only. Resend errors can echo addresses
         and configuration detail, so the visitor sees none of it. */
      const detail = await resp.text().catch(function () { return ''; });
      console.error('contact: resend responded ' + resp.status + ' ' + detail.slice(0, 400));
      return res.status(502).json({ ok: false });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('contact: send failed', err && err.message);
    return res.status(502).json({ ok: false });
  }
};
