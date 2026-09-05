/* ============================================================
   IDESIGN GROUP — language toggle
   English / Swahili. Choice persists across pages via
   localStorage, so a visitor picks once and the whole site
   follows. Falls back silently if storage is unavailable.
   ============================================================ */
(function () {
  'use strict';

  var KEY = 'idesign-lang';

  function store(v) {
    try { localStorage.setItem(KEY, v); } catch (e) { /* private mode */ }
  }
  function recall() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function apply(l) {
    document.documentElement.lang = (l === 'sw' ? 'sw' : 'en');

    // swap every translatable node
    var nodes = document.querySelectorAll('[data-en]');
    for (var i = 0; i < nodes.length; i++) {
      var v = nodes[i].getAttribute('data-' + l);
      if (v !== null) nodes[i].innerHTML = v;
    }

    // translate placeholder / aria attributes too
    var attrNodes = document.querySelectorAll('[data-en-placeholder]');
    for (var j = 0; j < attrNodes.length; j++) {
      var p = attrNodes[j].getAttribute('data-' + l + '-placeholder');
      if (p !== null) attrNodes[j].setAttribute('placeholder', p);
    }

    var en = document.getElementById('b-en');
    var sw = document.getElementById('b-sw');
    if (en && sw) {
      en.classList.toggle('on', l === 'en');
      sw.classList.toggle('on', l === 'sw');
      en.setAttribute('aria-pressed', String(l === 'en'));
      sw.setAttribute('aria-pressed', String(l === 'sw'));
    }
  }


  /* Stretch the strapline so it matches the wordmark's width exactly.
     Each letter becomes a flex item; space-between distributes the
     remainder. Re-runs on language change since Swahili is a
     different length. */
  function fitSub(l) {
    var s = document.querySelector('.top .strap');
    if (!s) return;
    var t = s.getAttribute('data-' + l);
    if (!t) t = s.getAttribute('data-plain') || s.textContent;
    t = t.replace(/&middot;/g, '\u00B7').trim();
    s.setAttribute('data-plain', t);
    s.setAttribute('aria-label', t);
    var out = '';
    for (var i = 0; i < t.length; i++) {
      out += (t.charAt(i) === ' ')
        ? '<span class="sp" aria-hidden="true"></span>'
        : '<span aria-hidden="true">' + t.charAt(i) + '</span>';
    }
    s.innerHTML = out;
  }

  window.setLang = function (l) {
    store(l);
    apply(l);
    fitSub(l);
  };

  // run before paint where possible
  var saved = recall();
  var start = (saved === 'sw') ? 'sw' : 'en';
  function boot() {
    if (start === 'sw') apply('sw');
    fitSub(start);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

/* ============================================================
   Contact form
   Submits as JSON to /api/contact so the page never reloads.
   The department is sent as a KEY; the server owns the address.
   Nothing secret is referenced here - this file is public.
   ============================================================ */
(function () {
  'use strict';

  var form = document.getElementById('enquiry');
  if (!form) return;

  var status = document.getElementById('f-status');
  var button = form.querySelector('button[type="submit"]');

  var TEXT = {
    sending: { en: 'Sending...', sw: 'Inatuma...' },
    ok:      { en: 'Your message has been sent successfully.',
               sw: 'Ujumbe wako umetumwa kikamilifu.' },
    fail:    { en: 'We could not send your message. Please try again.',
               sw: 'Hatukuweza kutuma ujumbe wako. Tafadhali jaribu tena.' },
    invalid: { en: 'Please fill in your name, a valid email, and a message.',
               sw: 'Tafadhali jaza jina lako, barua pepe sahihi, na ujumbe.' }
  };

  function lang() {
    try { return localStorage.getItem('idesign-lang') === 'sw' ? 'sw' : 'en'; }
    catch (e) { return 'en'; }
  }

  function say(kind) {
    if (!status) return;
    status.textContent = TEXT[kind][lang()];
    status.setAttribute('data-state', kind);
  }

  function value(name) {
    var el = form.elements[name];
    return el && el.value ? el.value.trim() : '';
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();

    var payload = {
      department: value('department'),
      name: value('name'),
      email: value('email'),
      phone: value('phone'),
      location: value('location'),
      message: value('message')
    };
    payload['company-website'] = value('company-website');

    if (!payload.name || !payload.message || payload.email.indexOf('@') < 1) {
      say('invalid');
      return;
    }

    if (button) button.disabled = true;
    say('sending');

    fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().catch(function () { return { ok: r.ok }; });
    }).then(function (data) {
      if (data && data.ok) {
        say('ok');
        form.reset();
      } else {
        /* Deliberately generic. The server never returns a reason
           and the visitor is never shown one. */
        say('fail');
      }
    }).catch(function () {
      say('fail');
    }).then(function () {
      if (button) button.disabled = false;
    });
  });
})();
