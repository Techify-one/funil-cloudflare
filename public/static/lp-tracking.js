/*
 * lp-tracking.js: bloco técnico único das páginas de venda.
 *
 * O worker do site serve cada página registrada em site/pages.config.mjs e
 * injeta, no <head>, o Pixel (init + PageView) e window.__LP; antes do </body>,
 * inclui este script. Ele cuida de:
 *   - Meta Pixel: ViewContent + InitiateCheckout (PageView já é disparado inline).
 *   - CAPI (deduplicada pelo eventID) via /api/meta-event, enviando o offer_code
 *     para o servidor escolher o pixel/token da oferta.
 *   - Link do checkout: monta /checkout/<oferta> encaminhando TODOS os params da
 *     URL (utm_*, fbclid etc.) + funnel + utm_page (variante) + utm_content_cta.
 *   - Binding de CTA por delegação de evento em [data-cta]/[data-checkout]/#checkout.
 *   - Rastreamento por seção (/api/section-event -> /secoes), com
 *     page = '<slug>-v<N>' para comparar variantes separadamente.
 *
 * Toda a config vem de window.__LP (pixelId/page/funnel/utmPage/offer/source/
 * content/value/currency).
 */
(function () {
  var C = window.__LP || {};
  var PAGE = C.page || 'pagina';
  var FUNNEL = C.funnel || PAGE;
  var UTM_PAGE = C.utmPage || ('/' + PAGE);
  var OFFER = C.offer || '';
  var SOURCE = C.source || PAGE;
  var CONTENT = C.content || PAGE;
  var VALUE = typeof C.value === 'number' ? C.value : 0;
  var CURRENCY = C.currency || 'BRL';
  var CHECKOUT_BASE = '/checkout/' + OFFER;
  // Slug por variante ('<pagina>-v1', '<pagina>-v2'...) usado no /secoes.
  var SECTION_PAGE = UTM_PAGE.replace(/^\//, '') || PAGE;

  // ---- CAPI: dispara fbq + manda o mesmo evento (com eventID) pro servidor ----
  function genId(prefix) {
    return prefix + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e7).toString(36);
  }
  function fbCapi(eventName, customData) {
    var eventId = genId(eventName.toLowerCase());
    try {
      if (typeof fbq === 'function') fbq('track', eventName, customData || {}, { eventID: eventId });
    } catch (_) {}
    try {
      var body = JSON.stringify({
        event_name: eventName,
        event_id: eventId,
        source: SOURCE,
        offer_code: OFFER,
        custom_data: customData || {},
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/meta-event', new Blob([body], { type: 'application/json' }));
      } else {
        fetch('/api/meta-event', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body,
          keepalive: true,
        }).catch(function () {});
      }
    } catch (_) {}
    return eventId;
  }
  window.__fbCapi = fbCapi;

  // PageView já foi disparado inline; aqui mandamos a versão CAPI + ViewContent.
  fbCapi('PageView');
  fbCapi('ViewContent', { content_name: CONTENT, content_type: 'product', value: VALUE, currency: CURRENCY });

  // ---- Checkout: encaminha params da URL + funnel + utm_page da variante ----
  function buildCheckoutUrl(source) {
    var sp = new URLSearchParams(location.search || '');
    sp.set('funnel', FUNNEL);
    sp.set('utm_page', UTM_PAGE);
    if (source) sp.set('utm_content_cta', source);
    return CHECKOUT_BASE + '?' + sp.toString();
  }

  function goToCheckout(source) {
    try {
      window.__fbCapi('InitiateCheckout', {
        content_name: CONTENT,
        content_category: source || 'cta',
        value: VALUE,
        currency: CURRENCY,
      });
    } catch (_) {}
    location.href = buildCheckoutUrl(source);
  }

  // ---- Binding por delegação: pega qualquer CTA que aponte pro checkout ----
  var SEL = 'a[href$="#checkout"], a[href="#checkout"], [data-cta], [data-checkout]';
  document.addEventListener(
    'click',
    function (e) {
      var t = e.target && e.target.closest ? e.target.closest(SEL) : null;
      if (!t) return;
      e.preventDefault();
      var source = t.getAttribute('data-cta') || 'cta';
      goToCheckout(source);
    },
    true
  );

  // ===== Section-level tracking (in-page analytics, sem terceiros) =====
  // Captura section_view (1x por seção+sessão), max_scroll, time_on_page,
  // e cta_click com last_visible_section. Envia em batch via sendBeacon.
  try {
    function getSessionUuid() {
      try {
        var k = 'tx_session_uuid';
        var u = localStorage.getItem(k);
        if (u && /^[0-9a-f-]{36}$/i.test(u)) return u;
      } catch (_) {}
      var r = (crypto && crypto.randomUUID) ? crypto.randomUUID() : (function () {
        var s = ''; for (var i = 0; i < 36; i++) { var c = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'[i]; if (c === '-' || c === '4') { s += c; continue; } var v = Math.random() * 16 | 0; if (c === 'y') v = (v & 0x3) | 0x8; s += v.toString(16); } return s;
      })();
      try { localStorage.setItem('tx_session_uuid', r); } catch (_) {}
      return r;
    }

    var SESSION = getSessionUuid();
    var sp2 = new URLSearchParams(location.search || '');
    var UTM = {
      utm_source: sp2.get('utm_source') || null,
      utm_medium: sp2.get('utm_medium') || null,
      utm_campaign: sp2.get('utm_campaign') || null,
      utm_term: sp2.get('utm_term') || null,
      utm_content: sp2.get('utm_content') || null,
    };

    var seenSections = {};
    var lastVisibleSection = null;
    var maxScrollPct = 0;
    var lastScrollMilestone = 0;
    var visibleMs = 0;
    var lastResumeMs = Date.now();
    var buffer = [];
    var flushScheduled = false;

    function pushEvent(ev) { buffer.push(ev); scheduleFlush(); }

    function scheduleFlush() {
      if (flushScheduled) return;
      flushScheduled = true;
      setTimeout(function () { flushScheduled = false; flush(false); }, 4000);
    }

    function flush(final) {
      if (!buffer.length) return;
      var events = buffer.splice(0, buffer.length);
      var payload = JSON.stringify({
        session_uuid: SESSION,
        page: SECTION_PAGE,
        funnel: FUNNEL,
        utm: UTM,
        events: events,
      });
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon('/api/section-event', new Blob([payload], { type: 'application/json' }));
          return;
        }
      } catch (_) {}
      try {
        fetch('/api/section-event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, keepalive: true }).catch(function () {});
      } catch (_) {}
    }

    function accumulateTime() {
      if (lastResumeMs == null) return;
      visibleMs += (Date.now() - lastResumeMs);
      lastResumeMs = null;
    }
    function resumeTime() {
      if (lastResumeMs == null) lastResumeMs = Date.now();
    }

    function onScroll() {
      var doc = document.documentElement;
      var body = document.body;
      var st = window.pageYOffset || doc.scrollTop || body.scrollTop || 0;
      var sh = Math.max(doc.scrollHeight, body.scrollHeight) - (window.innerHeight || doc.clientHeight || 0);
      if (sh <= 0) return;
      var pct = Math.max(0, Math.min(100, Math.round((st / sh) * 100)));
      if (pct > maxScrollPct) maxScrollPct = pct;
      var milestones = [25, 50, 75, 100];
      for (var i = 0; i < milestones.length; i++) {
        var m = milestones[i];
        if (pct >= m && lastScrollMilestone < m) {
          lastScrollMilestone = m;
          pushEvent({ type: 'max_scroll', value: m, ts_ms: Date.now() });
        }
      }
    }

    function initObserver() {
      if (typeof IntersectionObserver !== 'function') return;
      var nodes = document.querySelectorAll('[data-section]');
      var obs = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i];
          var slug = e.target.getAttribute('data-section');
          if (!slug) continue;
          if (e.isIntersecting && e.intersectionRatio >= 0.5) {
            lastVisibleSection = slug;
            if (!seenSections[slug]) {
              seenSections[slug] = true;
              pushEvent({ type: 'section_view', section: slug, ts_ms: Date.now() });
            }
          }
        }
      }, { threshold: [0.5] });
      for (var j = 0; j < nodes.length; j++) obs.observe(nodes[j]);
    }

    function bindCtaTracking() {
      document.querySelectorAll('[data-cta]').forEach(function (el) {
        if (el.dataset.ctaTrackBound) return;
        el.dataset.ctaTrackBound = '1';
        // Capture pra rodar antes do handler de goToCheckout (preventDefault + redirect).
        el.addEventListener('click', function () {
          var cta = el.getAttribute('data-cta') || 'unknown';
          var nowTs = Date.now();
          accumulateTime();
          var timeS = Math.round(visibleMs / 1000);
          resumeTime();
          var payload = JSON.stringify({
            session_uuid: SESSION,
            page: SECTION_PAGE,
            funnel: FUNNEL,
            utm: UTM,
            events: [{
              type: 'cta_click', cta: cta, last_visible_section: lastVisibleSection,
              value: maxScrollPct, ts_ms: nowTs,
            }, {
              type: 'time_on_page', value: timeS, ts_ms: nowTs,
            }, {
              type: 'max_scroll', value: maxScrollPct, ts_ms: nowTs,
            }],
          });
          try {
            if (navigator.sendBeacon) {
              navigator.sendBeacon('/api/section-event', new Blob([payload], { type: 'application/json' }));
            } else {
              fetch('/api/section-event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, keepalive: true }).catch(function () {});
            }
          } catch (_) {}
        }, true);
      });
    }

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') accumulateTime();
      else resumeTime();
    });
    window.addEventListener('pagehide', function () {
      accumulateTime();
      var timeS = Math.round(visibleMs / 1000);
      pushEvent({ type: 'time_on_page', value: timeS, ts_ms: Date.now() });
      pushEvent({ type: 'max_scroll', value: maxScrollPct, ts_ms: Date.now() });
      flush(true);
    });
    window.addEventListener('scroll', onScroll, { passive: true });

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { initObserver(); bindCtaTracking(); onScroll(); });
    } else {
      initObserver(); bindCtaTracking(); onScroll();
    }
  } catch (_) { /* tracking opcional, nunca quebra a página */ }
})();
