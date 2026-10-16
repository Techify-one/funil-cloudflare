// Rotas do módulo site/: páginas registradas, /obrigado, raiz, APIs de
// rastreamento, arquivos estáticos e 404. Roda o Worker inteiro no Miniflare.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_UA, ENV_PIXEL, OFFER_PIXEL, ORIGIN, isCapiCall, rows, startSite, stubbedModules, waitFor,
} from './site-harness.mjs';

const SESSION = '0b8f3a52-6a51-4c43-9d0e-6a3f6b9d2c11';

function headers(extra = {}) {
  return { 'user-agent': BROWSER_UA, 'cf-connecting-ip': '203.0.113.7', ...extra };
}

function postJson(mf, path, body, extra = {}) {
  return mf.dispatchFetch(ORIGIN + path, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json', ...extra }),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('módulo site', async (t) => {
  const { mf, db, outbound } = await startSite();
  t.after(() => mf.dispose());
  if (stubbedModules.length) t.diagnostic('stub em: ' + stubbedModules.join(', '));

  await t.test('GET /exemplo injeta Pixel da oferta, __LP e lp-tracking.js', async () => {
    await db.exec('DELETE FROM page_views');
    const res = await mf.dispatchFetch(ORIGIN + '/exemplo?utm_source=fb&utm_campaign=CP01&utm_content=ad1', { headers: headers() });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.equal(res.headers.get('x-lp-variant'), '1');
    const cookies = res.headers.getSetCookie();
    assert.ok(cookies.some((c) => /^lp_exemplo_v=1; Path=\/exemplo; Max-Age=2592000; SameSite=Lax; Secure$/.test(c)), cookies.join(' | '));
    assert.ok(cookies.some((c) => c.startsWith('tx_session_uuid=')), 'cookie de sessão do page_view');

    const html = await res.text();
    assert.ok(html.includes(`fbq('init','${OFFER_PIXEL}')`), 'pixel da oferta');
    assert.ok(!html.includes(`fbq('init','${ENV_PIXEL}')`));
    assert.ok(html.includes("fbq('track','PageView')"));
    assert.ok(html.indexOf('window.__LP=') < html.indexOf('</head>'), '__LP no <head>');
    assert.ok(html.includes('<script src="/static/lp-tracking.js"></script></body>'));

    const cfg = JSON.parse(html.match(/window\.__LP=(\{.*?\});/)[1]);
    assert.deepEqual(cfg, {
      pixelId: OFFER_PIXEL, page: 'exemplo', funnel: 'exemplo', utmPage: '/exemplo-v1',
      offer: 'produto-exemplo', source: 'exemplo', content: 'Produto Exemplo', value: 97, currency: 'BRL',
    });

    const views = await waitFor(() => rows(db, "SELECT * FROM page_views WHERE page = 'exemplo'").then((r) => r.length && r));
    assert.equal(views.length, 1);
    assert.equal(views[0].funnel, 'exemplo');
    assert.equal(views[0].utm_source, 'fb');
    assert.equal(views[0].utm_campaign, 'CP01');
    assert.equal(views[0].utm_content, 'ad1');
    assert.equal(views[0].utm_page, '/exemplo-v1');
    assert.match(views[0].session_uuid, /^[0-9a-f-]{36}$/);
    const sessionCookie = cookies.find((c) => c.startsWith('tx_session_uuid='));
    assert.ok(sessionCookie.includes(views[0].session_uuid), 'page_view usa a mesma sessão do cookie');
  });

  await t.test('?v=1 força a variante, barra final é aceita e cookie inválido é ignorado', async () => {
    const forced = await mf.dispatchFetch(ORIGIN + '/exemplo/?v=1', { headers: headers({ cookie: 'lp_exemplo_v=7' }) });
    assert.equal(forced.status, 200);
    assert.equal(forced.headers.get('x-lp-variant'), '1');
    await forced.text();
    const sticky = await mf.dispatchFetch(ORIGIN + '/exemplo?v=9', { headers: headers({ cookie: 'lp_exemplo_v=1' }) });
    assert.equal(sticky.headers.get('x-lp-variant'), '1');
    await sticky.text();
  });

  await t.test('sem pixel na oferta usa META_PIXEL_ID; oferta ausente não derruba a página', async () => {
    await db.prepare("UPDATE offers SET meta_pixel_id = NULL WHERE code = 'produto-exemplo'").run();
    const res = await mf.dispatchFetch(ORIGIN + '/exemplo', { headers: headers() });
    assert.ok((await res.text()).includes(`fbq('init','${ENV_PIXEL}')`));

    await db.prepare("UPDATE offers SET code = 'outra' WHERE code = 'produto-exemplo'").run();
    const missing = await mf.dispatchFetch(ORIGIN + '/exemplo', { headers: headers() });
    assert.equal(missing.status, 200);
    const cfg = JSON.parse((await missing.text()).match(/window\.__LP=(\{.*?\});/)[1]);
    assert.equal(cfg.pixelId, ENV_PIXEL);
    assert.equal(cfg.offer, 'produto-exemplo');
    assert.equal(cfg.content, 'exemplo');
    assert.equal(cfg.value, 0);

    await db.prepare("UPDATE offers SET code = 'produto-exemplo', meta_pixel_id = ? WHERE code = 'outra'").bind(OFFER_PIXEL).run();
  });

  await t.test('GET / redireciona para a página padrão', async () => {
    const res = await mf.dispatchFetch(ORIGIN + '/?utm_source=x', { headers: headers(), redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), ORIGIN + '/exemplo?utm_source=x');
  });

  await t.test('GET /obrigado serve a página neutra e registra o page_view do funil', async () => {
    await db.exec('DELETE FROM page_views');
    const res = await mf.dispatchFetch(ORIGIN + '/obrigado?funnel=exemplo&utm_campaign=CP01&pid=123', { headers: headers() });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control'), /no-store/);
    const html = await res.text();
    assert.ok(html.includes('Pagamento confirmado!'));
    assert.ok(html.includes('Enviamos os detalhes de acesso para o seu e-mail.'));
    assert.ok(html.includes(`var pixelId = '${ENV_PIXEL}';`));
    assert.ok(!html.includes('__META_PIXEL_ID__'));
    const view = await waitFor(() => rows(db, "SELECT * FROM page_views WHERE page = 'obrigado'").then((r) => r[0]));
    assert.equal(view.funnel, 'exemplo');
    assert.equal(view.utm_campaign, 'CP01');
    assert.equal(view.utm_page, '/obrigado');

    await db.exec('DELETE FROM page_views');
    await (await mf.dispatchFetch(ORIGIN + '/obrigado?funnel=Inv%C3%A1lido!', { headers: headers() })).text();
    const fallback = await waitFor(() => rows(db, "SELECT funnel FROM page_views WHERE page = 'obrigado'").then((r) => r[0]));
    assert.equal(fallback.funnel, 'lp');
  });

  await t.test('POST /api/section-event grava o lote com device', async () => {
    await db.exec('DELETE FROM section_events');
    const res = await postJson(mf, '/api/section-event', {
      session_uuid: SESSION, page: 'exemplo-v1', funnel: 'exemplo',
      utm: { utm_source: 'fb', utm_campaign: 'CP01' },
      events: [
        { type: 'section_view', section: 'hero', ts_ms: 1700000000000 },
        { type: 'max_scroll', value: 50, ts_ms: 1700000000100 },
        { type: 'cta_click', cta: 'hero', last_visible_section: 'hero', value: 50, ts_ms: 1700000000200 },
        { type: 'time_on_page', value: 12, ts_ms: 1700000000300 },
        { type: 'section_view', ts_ms: 1 },
        { type: 'desconhecido', section: 'x' },
        { type: 'section_view', section: 'Inválido!' },
      ],
    });
    assert.equal(res.status, 204);
    const events = await waitFor(() => rows(db, 'SELECT * FROM section_events ORDER BY id').then((r) => r.length >= 4 && r));
    assert.deepEqual(events.map((e) => e.event_type), ['section_view', 'max_scroll', 'cta_click', 'time_on_page']);
    for (const e of events) {
      assert.equal(e.page, 'exemplo-v1');
      assert.equal(e.funnel, 'exemplo');
      assert.equal(e.device, 'mobile');
      assert.equal(e.session_uuid, SESSION);
      assert.equal(e.utm_campaign, 'CP01');
      assert.equal(e.ip, '203.0.113.7');
    }
    assert.equal(events[2].cta, 'hero');
    assert.equal(events[2].last_visible_section, 'hero');

    const bot = await postJson(mf, '/api/section-event', { session_uuid: SESSION, page: 'x', events: [{ type: 'max_scroll', value: 1 }] }, { 'user-agent': 'curl/8.0' });
    assert.equal(bot.status, 204);
    const badJson = await postJson(mf, '/api/section-event', '{nope');
    assert.equal(badJson.status, 204);
  });

  await t.test('POST /api/checkout-click e /api/popup-open gravam page_views sintéticos', async () => {
    await db.exec('DELETE FROM page_views');
    assert.equal((await postJson(mf, '/api/checkout-click', { funnel: 'Exemplo', utm_page: '/exemplo-v1' })).status, 204);
    assert.equal((await postJson(mf, '/api/popup-open', { utm_page: '/exemplo-v1' })).status, 204);
    assert.equal((await postJson(mf, '/api/checkout-click', 'sem json')).status, 204);
    const views = await waitFor(() => rows(db, 'SELECT page, funnel, utm_page FROM page_views ORDER BY id').then((r) => r.length >= 3 && r));
    const byPage = (page) => views.filter((v) => v.page === page);
    assert.deepEqual(byPage('popup'), [{ page: 'popup', funnel: 'lp', utm_page: '/exemplo-v1' }]);
    const clicks = byPage('checkout');
    assert.equal(clicks.length, 2);
    assert.ok(clicks.some((v) => v.funnel === 'exemplo' && v.utm_page === '/exemplo-v1'));
    assert.ok(clicks.some((v) => v.funnel === null && v.utm_page === '/api/checkout-click'));
  });

  await t.test('POST /api/meta-event roteia pelo offer_code e nunca aceita pixel/token do cliente', async () => {
    outbound.length = 0;
    const res = await postJson(mf, '/api/meta-event', {
      event_name: 'InitiateCheckout', event_id: 'ic-1', source: 'exemplo', offer_code: 'produto-exemplo',
      custom_data: { value: 97, currency: 'BRL' },
      pixel_id: '666', access_token: 'cliente',
    }, { cookie: '_fbp=fb.1.1.2' });
    assert.equal(res.status, 204);
    const call = await waitFor(() => outbound.find(isCapiCall));
    assert.ok(call, 'evento enviado para a CAPI');
    const url = new URL(call.url);
    assert.equal(url.pathname, `/v25.0/${OFFER_PIXEL}/events`);
    assert.equal(url.searchParams.get('access_token'), null, 'token não vai na URL');
    assert.equal(JSON.parse(call.body).access_token, 'offer-token');
    const payload = JSON.parse(call.body).data[0];
    assert.equal(payload.event_name, 'InitiateCheckout');
    assert.equal(payload.event_id, 'ic-1');
    assert.deepEqual(payload.custom_data, { value: 97, currency: 'BRL' });
    assert.equal(payload.user_data.fbp, 'fb.1.1.2');
  });

  await t.test('POST /api/meta-event sem pixel na oferta cai no pixel/token do ambiente', async () => {
    outbound.length = 0;
    await postJson(mf, '/api/meta-event', { event_name: 'PageView', event_id: 'pv-1', offer_code: 'nao-existe' });
    await postJson(mf, '/api/meta-event', { event_name: 'Lead', event_id: 'ld-1', offer_code: '../x' });
    const calls = await waitFor(() => {
      const found = outbound.filter(isCapiCall);
      return found.length >= 2 && found;
    });
    assert.equal(calls.length, 2);
    for (const call of calls) {
      const url = new URL(call.url);
      assert.equal(url.pathname, `/v25.0/${ENV_PIXEL}/events`);
      assert.equal(url.searchParams.get('access_token'), null);
      assert.equal(JSON.parse(call.body).access_token, 'env-token');
    }
  });

  await t.test('POST /api/meta-event rejeita evento fora da lista e payload inválido', async () => {
    outbound.length = 0;
    const purchase = await postJson(mf, '/api/meta-event', { event_name: 'Purchase', event_id: 'p-1', offer_code: 'produto-exemplo' });
    assert.equal(purchase.status, 400);
    assert.deepEqual(await purchase.json(), { ok: false, error: 'invalid_event' });
    const invalid = await postJson(mf, '/api/meta-event', { event_name: 'PageView' });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { ok: false, error: 'invalid_payload' });
    const badJson = await postJson(mf, '/api/meta-event', '{');
    assert.equal(badJson.status, 400);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(outbound.length, 0);
  });

  await t.test('POST /api/lead grava o lead do formulário', async () => {
    await db.exec('DELETE FROM leads');
    const res = await postJson(mf, '/api/lead', {
      name: 'Maria Teste', email: 'maria@example.com', phone: '(11) 98765-4321',
      offer: 'produto-exemplo', funnel: 'exemplo', utm_page: '/exemplo-v1',
      utm_source: 'fb', utm_campaign: 'CP01', meta_ad_id: '123', fbclid: 'abc',
      status: 'comprou',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Number.isInteger(body.id));
    assert.equal(Object.keys(body).sort().join(','), 'id,ok');
    const [lead] = await rows(db, 'SELECT * FROM leads WHERE id = ?', body.id);
    assert.equal(lead.name, 'Maria Teste');
    assert.equal(lead.phone_norm, '11987654321');
    assert.equal(lead.method, 'form');
    assert.equal(lead.status, 'lead', 'status fora da lista vira lead');
    assert.equal(lead.product, 'produto-exemplo');
    assert.equal(lead.funnel, 'exemplo');
    assert.equal(lead.utm_page, '/exemplo-v1');
    assert.equal(lead.utm_campaign, 'CP01');
    assert.equal(lead.meta_ad_id, '123');
    assert.equal(lead.fbclid, 'abc');
    assert.equal(lead.ip, '203.0.113.7');

    const tel = await postJson(mf, '/api/lead', { name: 'João', email: 'j@example.com', phone: '11999990000', status: 'telefone' });
    const telBody = await tel.json();
    const [telLead] = await rows(db, 'SELECT status, funnel, product, utm_page FROM leads WHERE id = ?', telBody.id);
    assert.deepEqual({ ...telLead }, { status: 'lead', funnel: 'lp', product: null, utm_page: '/api/lead' });
  });

  await t.test('POST /api/lead valida os campos como a origem', async () => {
    const cases = [
      ['{', 'invalid_json'],
      [{ name: 'A', email: 'a@b.co' }, 'missing_fields'],
      [{ name: 'A', email: 'sem-arroba', phone: '11999990000' }, 'invalid_email'],
      [{ name: 'A', email: 'a@b.co', phone: '123' }, 'invalid_phone'],
    ];
    for (const [body, error] of cases) {
      const res = await postJson(mf, '/api/lead', body);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, error);
    }
  });

  await t.test('arquivos estáticos, rotas internas e 404', async () => {
    const script = await mf.dispatchFetch(ORIGIN + '/static/lp-tracking.js', { headers: headers() });
    assert.equal(script.status, 200);
    assert.ok((await script.text()).includes("'/checkout/' + OFFER"));

    const internal = await mf.dispatchFetch(ORIGIN + '/internal/x', { headers: headers() });
    assert.equal(internal.status, 404);
    await internal.text();

    const unknown = await mf.dispatchFetch(ORIGIN + '/nao-existe', { headers: headers() });
    assert.equal(unknown.status, 404);
    assert.equal(await unknown.text(), 'Página não encontrada');

    const missingFile = await mf.dispatchFetch(ORIGIN + '/static/nao-existe.js', { headers: headers() });
    assert.equal(missingFile.status, 404);
    await missingFile.text();

    const getApi = await mf.dispatchFetch(ORIGIN + '/api/lead', { headers: headers() });
    assert.equal(getApi.status, 404);
    await getApi.text();
  });

  await t.test('?src= é removido com redirect, como na origem', async () => {
    const res = await mf.dispatchFetch(ORIGIN + '/exemplo?src=x&utm_source=fb', { headers: headers(), redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), ORIGIN + '/exemplo?utm_source=fb');
  });
});
