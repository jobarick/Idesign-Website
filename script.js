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

/* ============================================================
   Badili Bongo contribution form (badili-bongo.html, support.html)
   Two payment methods, picked with the toggle at the top:
   - "mobile" (Tanzania): a ClickPesa USSD-PUSH request straight to
     the phone number entered. Nothing redirects anywhere - the
     visitor stays on this page and enters their mobile money PIN on
     their own phone.
   - "card" (International): ClickPesa's Card Payment API still
     requires a ClickPesa-hosted page for the actual card entry (no
     integration lets a merchant collect card numbers directly), so
     this opens that in a new tab rather than redirecting the whole
     page away.
   Either way, this script polls /api/check-contribution-status until
   it sees a result and shows it inline, so the page itself always
   ends up showing the outcome regardless of which tab the visitor
   actually paid in.
   ============================================================ */
(function () {
  'use strict';

  var form = document.getElementById('contribute');
  if (!form) return;

  var status = document.getElementById('c-status');
  var note = document.getElementById('c-note');
  var button = form.querySelector('button[type="submit"]');
  var methodButtons = form.querySelectorAll('[data-method]');
  var panels = form.querySelectorAll('[data-method-panel]');
  var method = 'mobile';

  var amountField = document.getElementById('c-amount');
  var presets = form.querySelectorAll('.amt');
  var amountUsdField = document.getElementById('c-amount-usd');
  var presetsUsd = form.querySelectorAll('.amt-usd');

  var POLL_INTERVAL_MS = 3000;
  var POLL_MAX_ATTEMPTS = 30; /* ~90s before backing off */
  var pollTimer = null;
  var pollsLeft = 0;
  var pendingRef = null;

  var TEXT = {
    sending:     { en: 'Sending a payment request to your phone...', sw: 'Inatuma ombi la malipo kwenye simu yako...' },
    sendingCard: { en: 'Opening secure card payment...', sw: 'Inafungua malipo salama ya kadi...' },
    waiting:     { en: 'Check your phone. Enter your mobile money PIN to confirm.', sw: 'Angalia simu yako. Weka PIN yako ya pesa ya simu kuthibitisha.' },
    waitingCard: { en: 'Complete your payment in the tab that just opened. This page will update once it is done.', sw: 'Kamilisha malipo yako kwenye tab iliyofunguliwa. Ukurasa huu utasasishwa ukimaliza.' },
    paid:        { en: 'Thank you. Your contribution has been received.', sw: 'Asante. Mchango wako umepokelewa.' },
    failed:      { en: 'The payment did not go through. Please try again.', sw: 'Malipo hayakufanikiwa. Tafadhali jaribu tena.' },
    timeout:     { en: 'Still waiting to hear back. If you already paid, give it a moment and check again.', sw: 'Bado tunasubiri jibu. Kama tayari umelipa, subiri kidogo kisha angalia tena.' },
    fail:        { en: 'We could not send the payment request. Please try again.', sw: 'Hatukuweza kutuma ombi la malipo. Tafadhali jaribu tena.' },
    invalid:     { en: 'Please enter an amount of at least 1,000 TZS and a valid phone number.', sw: 'Tafadhali weka kiasi cha angalau TZS 1,000 na namba sahihi ya simu.' },
    invalidCard: { en: 'Please enter a valid amount, full name, email and phone number.', sw: 'Tafadhali weka kiasi sahihi, jina kamili, barua pepe na namba ya simu.' }
  };

  var NOTE = {
    mobile: { en: 'Payment is handled by ClickPesa, licensed under the Bank of Tanzania. A prompt will arrive on your phone to enter your mobile money PIN. Idesign never sees or stores it.',
               sw: 'Malipo yanashughulikiwa na ClickPesa, iliyosajiliwa chini ya Benki Kuu ya Tanzania. Ombi litafika kwenye simu yako kuweka PIN yako ya pesa ya simu. Idesign haioni wala kuihifadhi.' },
    card:   { en: 'Card payment is handled by ClickPesa on a secure page that opens in a new tab. Idesign never sees or stores your card details.',
               sw: 'Malipo ya kadi yanashughulikiwa na ClickPesa kwenye ukurasa salama unaofunguka kwenye tab mpya. Idesign haioni wala kuhifadhi taarifa za kadi yako.' }
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

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    pendingRef = null;
  }

  function resetPresets() {
    for (var j = 0; j < presets.length; j++) presets[j].classList.remove('on');
    for (var k = 0; k < presetsUsd.length; k++) presetsUsd[k].classList.remove('on');
  }

  function checkStatus() {
    fetch('/api/check-contribution-status?ref=' + encodeURIComponent(pendingRef), {
      method: 'GET'
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false }; });
    }).then(function (data) {
      var s = data && data.ok ? data.status : null;
      if (s === 'SUCCESS' || s === 'SETTLED') {
        say('paid');
        stopPolling();
        if (button) button.disabled = false;
        form.reset();
        resetPresets();
        return;
      }
      if (s === 'FAILED') {
        say('failed');
        stopPolling();
        if (button) button.disabled = false;
        return;
      }
      pollsLeft -= 1;
      if (pollsLeft <= 0) {
        say('timeout');
        stopPolling();
        if (button) button.disabled = false;
        return;
      }
      pollTimer = setTimeout(checkStatus, POLL_INTERVAL_MS);
    }).catch(function () {
      pollsLeft -= 1;
      if (pollsLeft <= 0) {
        say('timeout');
        stopPolling();
        if (button) button.disabled = false;
        return;
      }
      pollTimer = setTimeout(checkStatus, POLL_INTERVAL_MS);
    });
  }

  for (var m = 0; m < methodButtons.length; m++) {
    methodButtons[m].addEventListener('click', function () {
      method = this.getAttribute('data-method');
      for (var mm = 0; mm < methodButtons.length; mm++) methodButtons[mm].classList.remove('on');
      this.classList.add('on');
      for (var p = 0; p < panels.length; p++) {
        panels[p].hidden = (panels[p].getAttribute('data-method-panel') !== method);
      }
      if (note && NOTE[method]) note.textContent = NOTE[method][lang()];
      if (status) { status.textContent = ''; status.removeAttribute('data-state'); }
    });
  }

  for (var i = 0; i < presets.length; i++) {
    presets[i].addEventListener('click', function () {
      for (var j = 0; j < presets.length; j++) presets[j].classList.remove('on');
      this.classList.add('on');
      if (amountField) amountField.value = this.getAttribute('data-amount');
    });
  }
  if (amountField) {
    amountField.addEventListener('input', function () {
      for (var k = 0; k < presets.length; k++) presets[k].classList.remove('on');
    });
  }

  for (var iu = 0; iu < presetsUsd.length; iu++) {
    presetsUsd[iu].addEventListener('click', function () {
      for (var ju = 0; ju < presetsUsd.length; ju++) presetsUsd[ju].classList.remove('on');
      this.classList.add('on');
      if (amountUsdField) amountUsdField.value = this.getAttribute('data-amount');
    });
  }
  if (amountUsdField) {
    amountUsdField.addEventListener('input', function () {
      for (var ku = 0; ku < presetsUsd.length; ku++) presetsUsd[ku].classList.remove('on');
    });
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    stopPolling();

    if (method === 'card') {
      var cardPayload = {
        amount: value('amount-usd'),
        name: value('name-intl'),
        email: value('email-intl'),
        phone: value('phone-intl')
      };
      cardPayload['company-website'] = value('company-website');

      var amountUsd = Number(cardPayload.amount);
      var phoneIntlDigits = cardPayload.phone.replace(/[^\d]/g, '');
      if (!amountUsd || amountUsd < 1 || !cardPayload.name || !cardPayload.email || phoneIntlDigits.length < 7) {
        say('invalidCard');
        return;
      }

      if (button) button.disabled = true;
      say('sendingCard');

      fetch('/api/initiate-card-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cardPayload)
      }).then(function (r) {
        return r.json().catch(function () { return { ok: r.ok }; });
      }).then(function (data) {
        if (button) button.disabled = false;
        if (data && data.ok && data.orderReference && data.cardPaymentLink) {
          window.open(data.cardPaymentLink, '_blank', 'noopener');
          pendingRef = data.orderReference;
          pollsLeft = POLL_MAX_ATTEMPTS;
          say('waitingCard');
          pollTimer = setTimeout(checkStatus, POLL_INTERVAL_MS);
        } else {
          say('fail');
        }
      }).catch(function () {
        say('fail');
        if (button) button.disabled = false;
      });
      return;
    }

    var payload = {
      amount: value('amount'),
      phone: value('phone'),
      name: value('name'),
      email: value('email')
    };
    payload['company-website'] = value('company-website');

    var amount = Number(payload.amount);
    var phoneDigits = payload.phone.replace(/[^\d]/g, '');
    if (!amount || amount < 1000 || phoneDigits.length < 9) {
      say('invalid');
      return;
    }

    if (button) button.disabled = true;
    say('sending');

    fetch('/api/initiate-mobile-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().catch(function () { return { ok: r.ok }; });
    }).then(function (data) {
      if (data && data.ok && data.orderReference) {
        pendingRef = data.orderReference;
        pollsLeft = POLL_MAX_ATTEMPTS;
        say('waiting');
        pollTimer = setTimeout(checkStatus, POLL_INTERVAL_MS);
      } else {
        say('fail');
        if (button) button.disabled = false;
      }
    }).catch(function () {
      say('fail');
      if (button) button.disabled = false;
    });
  });
})();
