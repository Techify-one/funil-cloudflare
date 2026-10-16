// Endurecimento do módulo site/ e dos helpers compartilhados: custom_data do
// relay da CAPI montado no servidor, /api/lead (robôs, honeypot e tamanho) e
// substituições de HTML imunes aos padrões especiais do String.replace.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMetaCustomData, handleLead, handleMetaEvent, MAX_LEAD_BODY_BYTES } from '../../site/src/api.mjs';
import { buildHeadInject, injectHtml } from '../../site/src/pages.mjs';
import { pickCapiCustomData, serveHtmlNoCache } from '../../shared/utils.js';
import worker from '../../checkout/src/index.js';
import { assetsBinding, createCheckoutDb, insertOffer, makeCtx } from './checkout-harness.mjs';

const BROWSER_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36';
const DOLLAR_NAME = "Curso $' $` $& $$ $1 Final";

// ---------------------------------------------------------------------------
// 2. /api/meta-event: custom_data
// ---------------------------------------------------------------------------

test('buildMetaCustomData keeps only known keys and takes value from the offer', () => {
  const raw = {
    value: 9999, currency: 'USD', content_name: 'Produto', content_ids: ['p1'], content_type: 'product',
    content_category: 'hero', num_items: 2, order_id: 'o-1', predicted_ltv: 1e6, test_event_code: 'X',
  };
  const offer = { sale_price_cents: 4990 };
  assert.deepEqual(buildMetaCustomData('InitiateCheckout', raw, { offer }), {
    content_name: 'Produto', content_ids: ['p1'], content_type: 'product', content_category: 'hero', num_items: 2,
    value: 49.9, currency: 'BRL',
  });
  assert.equal(buildMetaCustomData('ViewContent', raw, { page: { value: 10 }, offer }).value, 10, 'page config value wins');
  assert.deepEqual(buildMetaCustomData('PageView', raw, { offer }), {
    content_name: 'Produto', content_ids: ['p1'], content_type: 'product', content_category: 'hero', num_items: 2,
  }, 'PageView never carries a value');
  assert.deepEqual(buildMetaCustomData('Lead', { value: 500, currency: 'USD' }, {}), {}, 'no offer, no client value');
});

test('pickCapiCustomData sanitizes types and lengths', () => {
  const out = pickCapiCustomData({
    content_name: 'x'.repeat(500), content_type: 'evil', num_items: 1000, content_ids: 'not-array',
    order_id: 'bad id with spaces', content_category: { nested: true },
  }, ['content_name', 'content_type', 'num_items', 'content_ids', 'order_id', 'content_category']);
  assert.deepEqual(out, { content_name: 'x'.repeat(200) });
  assert.deepEqual(pickCapiCustomData(null, ['content_name']), {});
  assert.deepEqual(pickCapiCustomData(['a'], ['content_name']), {});
});

test('handleMetaEvent sends server-built custom_data and drops client test_event_code', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ events_received: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const pending = [];
  try {
    const env = {
      META_PIXEL_ID: '999', META_PIXEL_ACCESS_TOKEN: 'env-token',
      DB: { prepare() { return { bind() { return { first: async () => ({ code: 'produto-exemplo', name: 'P', sale_price_cents: 9700, meta_pixel_id: null }) }; } }; } },
    };
    const req = new Request('https://site.example.com/api/meta-event', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': BROWSER_UA },
      body: JSON.stringify({
        event_name: 'InitiateCheckout', event_id: 'ic-1', source: 'nao-registrada', offer_code: 'produto-exemplo',
        custom_data: { value: 1, currency: 'USD', content_name: 'P', foo: 'bar' },
        test_event_code: 'CLIENT', pixel_id: '666', access_token: 'cliente',
      }),
    });
    const resp = await handleMetaEvent(req, env, { waitUntil(p) { pending.push(p); } });
    assert.equal(resp.status, 204);
    await Promise.all(pending);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/999\/events$/);
    assert.equal(calls[0].body.access_token, 'env-token');
    assert.equal('test_event_code' in calls[0].body, false);
    assert.deepEqual(calls[0].body.data[0].custom_data, { content_name: 'P', value: 97, currency: 'BRL' });
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// 7. /api/lead: robôs, honeypot e tamanho
// ---------------------------------------------------------------------------

function trackingDb() {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return { bind(...args) { return { async run() { writes.push({ sql, args }); return { meta: { last_row_id: 42 } }; } }; } };
    },
  };
}

function leadRequest(body, { ua = BROWSER_UA, headers = {} } = {}) {
  return new Request('https://site.example.com/api/lead', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': ua, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const VALID_LEAD = { name: 'Maria', email: 'maria@example.com', phone: '11987654321' };

test('/api/lead drops bots silently with 204', async () => {
  const db = trackingDb();
  for (const ua of ['curl/8.0', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'python-requests/2.31']) {
    const resp = await handleLead(leadRequest(VALID_LEAD, { ua }), { DB: db });
    assert.equal(resp.status, 204, ua);
    assert.equal(await resp.text(), '');
  }
  assert.equal(db.writes.length, 0);
});

test('/api/lead honeypot answers ok without inserting', async () => {
  const db = trackingDb();
  const resp = await handleLead(leadRequest({ ...VALID_LEAD, website: 'http://spam.example' }), { DB: db });
  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), { ok: true });
  assert.equal(db.writes.length, 0);

  const empty = await handleLead(leadRequest({ ...VALID_LEAD, website: '   ' }), { DB: db });
  assert.deepEqual(await empty.json(), { ok: true, id: 42 });
  assert.equal(db.writes.length, 1, 'empty honeypot is a real lead');
});

test('/api/lead rejects bodies larger than 8 KB, with or without content-length', async () => {
  const db = trackingDb();
  const big = JSON.stringify({ ...VALID_LEAD, filler: 'x'.repeat(MAX_LEAD_BODY_BYTES) });

  const declared = await handleLead(leadRequest(big), { DB: db });
  assert.equal(declared.status, 413);
  assert.deepEqual(await declared.json(), { ok: false, error: 'payload_too_large' });

  const bytes = new TextEncoder().encode(big);
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 1024) controller.enqueue(bytes.slice(i, i + 1024));
      controller.close();
    },
  });
  const chunked = new Request('https://site.example.com/api/lead', {
    method: 'POST', body: stream, duplex: 'half',
    headers: { 'content-type': 'application/json', 'user-agent': BROWSER_UA },
  });
  assert.equal(chunked.headers.get('content-length'), null);
  const streamed = await handleLead(chunked, { DB: db });
  assert.equal(streamed.status, 413);
  assert.equal(db.writes.length, 0);

  const ok = await handleLead(leadRequest({ ...VALID_LEAD, filler: 'x'.repeat(4000) }), { DB: db });
  assert.equal(ok.status, 200);
});

test('/api/lead hides database error details', async () => {
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.join(' ')); };
  try {
    const db = { prepare() { return { bind() { return { async run() { throw new Error('D1_ERROR: secret_table_name'); } }; } }; } };
    const resp = await handleLead(leadRequest(VALID_LEAD), { DB: db });
    assert.equal(resp.status, 500);
    const text = await resp.text();
    assert.deepEqual(JSON.parse(text), { ok: false, error: 'db_error' });
    assert.doesNotMatch(text, /secret_table_name/);
    assert.ok(logged.some((line) => line.includes('secret_table_name')));
  } finally {
    console.error = originalError;
  }
});

// ---------------------------------------------------------------------------
// 8. Padrões $ nas substituições de HTML
// ---------------------------------------------------------------------------

const PAGE_HTML = '<!doctype html><html><head><title>T</title></head><body><main>conteudo</main></body></html>';

test("injectHtml keeps $' $` $& from the offer name literal", () => {
  const head = buildHeadInject('123', { content: DOLLAR_NAME, value: 10 });
  const html = injectHtml(PAGE_HTML, head);
  assert.equal(html.match(/<\/head>/g).length, 1);
  assert.equal(html.match(/<\/body>/g).length, 1);
  assert.equal(html.match(/<main>/g).length, 1, 'no duplicated markup');
  assert.equal(html.match(/<!doctype html>/g).length, 1);
  const cfg = JSON.parse(html.match(/window\.__LP=(\{.*?\});<\/script>/)[1]);
  assert.equal(cfg.content, DOLLAR_NAME);
  assert.ok(html.endsWith('<script src="/static/lp-tracking.js"></script></body></html>'));
});

test('serveHtmlNoCache replaces placeholders literally', async () => {
  const env = {
    ASSETS: { fetch: async () => new Response("<p>__A__</p><i>__B__</i>", { headers: { 'content-type': 'text/html' } }) },
  };
  const resp = await serveHtmlNoCache(new Request('https://x.example.com/obrigado'), env, '/obrigado.html', {
    __A__: DOLLAR_NAME, __B__: null,
  });
  assert.equal(await resp.text(), `<p>${DOLLAR_NAME}</p><i></i>`);
  assert.match(resp.headers.get('cache-control'), /no-store/);
});

test("checkout page keeps an offer name/description with $' $` $& intact", async (t) => {
  const { db, dispose } = await createCheckoutDb();
  t.after(() => dispose());
  await insertOffer(db, { code: 'dolar', name: DOLLAR_NAME, description: "Desc $` antes $' depois $&" });
  const env = { DB: db, ASSETS: assetsBinding(), BRAND_NAME: "Loja $' $&", META_PIXEL_ID: '777' };

  const resp = await worker.fetch(new Request('https://loja.example.com/checkout/dolar'), env, makeCtx());
  assert.equal(resp.status, 200);
  const html = await resp.text();
  assert.equal(html.match(/<\/head>/g).length, 1);
  assert.equal(html.match(/<\/html>/g).length, 1);
  assert.equal(html.match(/window\.__OFFER__ = /g).length, 1);
  const offer = JSON.parse(html.match(/window\.__OFFER__ = (\{.*?\});\n/)[1]);
  assert.equal(offer.name, DOLLAR_NAME);
  assert.equal(offer.description, "Desc $` antes $' depois $&");
  assert.ok(html.includes("Checkout | Loja $&#39; $&amp;</title>"));
});
