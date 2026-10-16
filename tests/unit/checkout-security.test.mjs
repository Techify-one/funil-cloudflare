// Endurecimento do checkout: /api/checkout-event, guardas de status do
// /api/checkout, already_paid sem IDs, _debug_approve, vazamento de erros e
// endpoints /internal/* protegidos pela chave do roteador.
import test from 'node:test';
import assert from 'node:assert/strict';

import worker, {
  buildCheckoutEventCustomData, isAuthorizedInternalCall,
} from '../../checkout/src/index.js';
import { constantTimeEqual } from '../../shared/utils.js';
import {
  createCheckoutDb, insertOffer, installFakeFetch, jsonRequest, makeCtx,
} from './checkout-harness.mjs';

const INTERNAL_KEY = 'chave-interna-de-teste-0123456789';

async function insertBump(db, offerId, { name = 'Bônus', price_cents = 500, is_active = 1, position = 0 } = {}) {
  await db.prepare(
    'INSERT INTO order_bumps (offer_id, name, description, price_cents, is_active, position) VALUES (?, ?, NULL, ?, ?, ?)'
  ).bind(offerId, name, price_cents, is_active, position).run();
}

function capiCalls(fake) {
  return fake.only('https://graph.facebook.com/');
}

function postEvent(env, body) {
  return worker.fetch(jsonRequest('/api/checkout-event', body), env, makeCtx());
}

// ---------------------------------------------------------------------------
// 1. /api/checkout-event
// ---------------------------------------------------------------------------

test('checkout-event accepts InitiateCheckout and builds custom_data on the server', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });
  const offer = await insertOffer(db, {
    code: 'real', name: 'Curso Real', sale_price_cents: 3700, meta_pixel_id: '444444444444444', meta_capi_token: 'offer-token',
  });
  await insertBump(db, offer.id, { price_cents: 1300 });
  await insertBump(db, offer.id, { price_cents: 900, is_active: 0, position: 1 });
  const env = { DB: db, META_PIXEL_ID: '333333333333333', META_PIXEL_ACCESS_TOKEN: 'instance-token' };

  const resp = await postEvent(env, {
    event_name: 'InitiateCheckout',
    event_id: 'ic-1',
    offer_code: 'real',
    pixel_id: '666666666666666',
    access_token: 'client-token',
    test_event_code: 'CLIENT-TEST',
    custom_data: {
      value: 9999, currency: 'USD', content_type: 'product', content_ids: ['real'], num_items: 1,
      order_id: 'ord-1', predicted_ltv: 100000, status: 'hacked',
    },
  });
  assert.equal(resp.status, 202);

  const [call] = capiCalls(fake);
  assert.match(call.url, /\/444444444444444\/events\?access_token=offer-token$/);
  assert.equal('test_event_code' in call.body, false, 'client test_event_code is ignored');
  const event = call.body.data[0];
  assert.equal(event.event_name, 'InitiateCheckout');
  assert.deepEqual(event.custom_data, {
    content_type: 'product', content_ids: ['real'], num_items: 1, order_id: 'ord-1',
    value: 50, currency: 'BRL', content_name: 'Curso Real',
  }, 'value clamped to sale price + active bumps (37 + 13), currency forced, unknown keys dropped');
});

test('checkout-event keeps META_TEST_EVENT_CODE from the instance', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });
  await insertOffer(db, { code: 'real' });
  const env = { DB: db, META_PIXEL_ID: '333333333333333', META_PIXEL_ACCESS_TOKEN: 'instance-token', META_TEST_EVENT_CODE: 'TEST999' };

  const resp = await postEvent(env, { event_name: 'InitiateCheckout', event_id: 'ic-2', offer_code: 'real', test_event_code: 'CLIENT' });
  assert.equal(resp.status, 202);
  assert.equal(capiCalls(fake)[0].body.test_event_code, 'TEST999');
});

test('checkout-event rejects Purchase for a real offer and accepts it for an out_of_stock offer', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });
  await insertOffer(db, { code: 'real', sale_price_cents: 3700 });
  const fakeOffer = await insertOffer(db, { code: 'esgotado', name: 'Esgotado', out_of_stock: 1, sale_price_cents: 990 });
  await insertBump(db, fakeOffer.id, { price_cents: 500 });
  const env = { DB: db, META_PIXEL_ID: '333333333333333', META_PIXEL_ACCESS_TOKEN: 'instance-token' };

  const rejected = await postEvent(env, {
    event_name: 'Purchase', event_id: 'purchase-forged', offer_code: 'real', custom_data: { value: 9999 },
  });
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), { ok: false, error: 'invalid_event' });
  assert.equal(capiCalls(fake).length, 0);

  const accepted = await postEvent(env, {
    event_name: 'Purchase',
    event_id: 'purchase-fake-1',
    offer_code: 'esgotado',
    custom_data: { value: 9999, currency: 'BRL', content_name: 'Esgotado', content_type: 'product', payment_method: 'pix' },
    user_data: { name: 'Ana Souza', email: 'ana@example.com', phone: '+55 11999990000' },
  });
  assert.equal(accepted.status, 202);
  const [call] = capiCalls(fake);
  const event = call.body.data[0];
  assert.equal(event.event_name, 'Purchase');
  assert.equal(event.event_id, 'purchase-fake-1');
  assert.deepEqual(event.custom_data, {
    content_name: 'Esgotado', content_type: 'product', value: 14.9, currency: 'BRL',
  });
  assert.ok(Array.isArray(event.user_data.em) && event.user_data.em.length === 1, 'user_data still hashed');
});

test('checkout-event rejects unknown events and missing offers without calling Meta', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });
  await insertOffer(db, { code: 'real' });
  const env = { DB: db, META_PIXEL_ID: '333333333333333', META_PIXEL_ACCESS_TOKEN: 'instance-token' };

  for (const event_name of ['Lead', 'AddPaymentInfo', 'CompleteRegistration', 'Subscribe', 'purchase']) {
    const resp = await postEvent(env, { event_name, event_id: 'x-1', offer_code: 'real' });
    assert.equal(resp.status, 400, event_name);
    assert.equal((await resp.json()).error, 'invalid_event');
  }
  for (const offer_code of [undefined, 'nao-existe', '../x']) {
    const resp = await postEvent(env, { event_name: 'InitiateCheckout', event_id: 'x-2', offer_code });
    assert.equal(resp.status, 400);
    assert.equal((await resp.json()).error, 'offer_not_found');
  }
  assert.equal((await postEvent(env, { event_name: 'InitiateCheckout' })).status, 400);
  assert.equal(capiCalls(fake).length, 0);
});

test('checkout-event does not return Meta error details to the browser', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  t.after(() => dispose());
  await insertOffer(db, { code: 'real' });
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'Invalid OAuth access token: EAAB-secret-detail' } }), {
    status: 400, headers: { 'content-type': 'application/json' },
  });
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.join(' ')); };
  t.after(() => { globalThis.fetch = original; console.error = originalError; });

  const resp = await postEvent({ DB: db, META_PIXEL_ID: '333333333333333', META_PIXEL_ACCESS_TOKEN: 'instance-token' }, {
    event_name: 'InitiateCheckout', event_id: 'ic-err', offer_code: 'real',
  });
  assert.equal(resp.status, 502);
  const text = await resp.text();
  assert.deepEqual(JSON.parse(text), { ok: false, error: 'capi_unavailable' });
  assert.doesNotMatch(text, /OAuth|secret-detail|meta_capi_http/);
  assert.ok(logged.some((line) => line.includes('secret-detail')), 'detail goes to the log');
});

test('buildCheckoutEventCustomData clamps value and defaults content_name', () => {
  const offer = { name: 'Oferta', sale_price_cents: 1990, order_bumps: [{ price_cents: 1000 }] };
  assert.deepEqual(buildCheckoutEventCustomData(offer, { value: -5 }), { value: 0, currency: 'BRL', content_name: 'Oferta' });
  assert.equal(buildCheckoutEventCustomData(offer, { value: 25.5 }).value, 25.5);
  assert.equal(buildCheckoutEventCustomData(offer, { value: 1e9 }).value, 29.9);
  assert.equal(buildCheckoutEventCustomData(offer, { value: 'abc' }).value, 19.9, 'non numeric falls back to the sale price');
  assert.equal(buildCheckoutEventCustomData(offer, null).value, 19.9);
  assert.equal(buildCheckoutEventCustomData(offer, { content_name: 'Outro' }).content_name, 'Outro');
});

// ---------------------------------------------------------------------------
// 3. /api/checkout: guardas de status
// ---------------------------------------------------------------------------

function leadBody(extra = {}) {
  return { name: 'Fulano', email: 'fulano@example.com', phone: '11988887777', ...extra };
}

test('public /api/checkout rejects reembolsado and comprou for a real offer', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });
  await insertOffer(db, { code: 'real' });
  const env = { DB: db };

  for (const body of [
    leadBody({ status: 'reembolsado', offer_code: 'real' }),
    leadBody({ status: 'reembolsado' }),
    leadBody({ status: 'comprou', offer_code: 'real', method: 'pix' }),
    leadBody({ status: 'comprou', method: 'pix' }),
    leadBody({ status: 'comprou', offer_code: 'nao-existe', method: 'pix' }),
  ]) {
    const resp = await worker.fetch(jsonRequest('/api/checkout', body), env, makeCtx());
    assert.equal(resp.status, 400, JSON.stringify(body));
    assert.equal((await resp.json()).error, 'invalid_status');
  }
  const count = await db.prepare('SELECT COUNT(*) AS n FROM leads').first();
  assert.equal(count.n, 0);
});

test('public /api/checkout keeps lead progression and the fake comprou path working', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });
  await insertOffer(db, { code: 'real' });
  await insertOffer(db, { code: 'esgotado', out_of_stock: 1, sale_price_cents: 990 });
  const env = { DB: db };

  const first = await worker.fetch(jsonRequest('/api/checkout', { status: 'nome', name: 'Fulano', offer_code: 'real' }), env, makeCtx());
  assert.equal(first.status, 200);
  const { id } = await first.json();
  for (const status of ['email', 'telefone', 'escolheu_metodo', 'pix_gerado']) {
    const resp = await worker.fetch(jsonRequest('/api/checkout', leadBody({ id, status, offer_code: 'real' })), env, makeCtx());
    assert.equal(resp.status, 200, status);
    assert.equal((await resp.json()).id, id);
  }

  const fakeBuy = await worker.fetch(jsonRequest('/api/checkout', leadBody({
    status: 'comprou', offer_code: 'esgotado', method: 'pix', expected_total_cents: 990, email: 'outra@example.com', phone: '11977776666',
  })), env, makeCtx());
  assert.equal(fakeBuy.status, 200);
  const bought = await fakeBuy.json();
  const lead = await db.prepare('SELECT status, product FROM leads WHERE id = ?').bind(bought.id).first();
  assert.deepEqual({ ...lead }, { status: 'comprou', product: 'esgotado' });
});

test('public /api/checkout hides database error details', async (t) => {
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.join(' ')); };
  t.after(() => { console.error = originalError; });
  const env = { DB: { prepare(sql) { return { bind() { return {
    async first() { return null; },
    async all() { return { results: [] }; },
    async run() { throw new Error('D1_ERROR: no such table: leads_secret_schema'); },
  }; } }; } } };
  const resp = await worker.fetch(jsonRequest('/api/checkout', { status: 'nome', name: 'Fulano' }), env, makeCtx());
  assert.equal(resp.status, 500);
  const text = await resp.text();
  assert.deepEqual(JSON.parse(text), { ok: false, error: 'db_error' });
  assert.doesNotMatch(text, /leads_secret_schema|D1_ERROR/);
  assert.ok(logged.some((line) => line.includes('leads_secret_schema')));
});

// ---------------------------------------------------------------------------
// 4. already_paid sem IDs
// ---------------------------------------------------------------------------

test('already_paid answers without payment_id or lead_id on Pix and card', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });
  await insertOffer(db, { code: 'real' });
  const env = { DB: db, MP_ACCESS_TOKEN: 'mp-token', DEBUG_APPROVE_TOKEN: 'debug-token' };
  const buyer = { offer_code: 'real', name: 'Ana Souza', email: 'ana@example.com', phone: '+55 11999990000' };

  const ctx = makeCtx();
  const created = await (await worker.fetch(jsonRequest('/api/mp/create-pix', buyer), env, ctx)).json();
  await ctx.drain();
  const approve = await worker.fetch(jsonRequest('/api/mp/_debug_approve', { payment_id: created.payment_id }, {
    headers: { 'x-debug-token': 'debug-token' },
  }), env, makeCtx());
  assert.equal(approve.status, 200);

  const pixAgain = await worker.fetch(jsonRequest('/api/mp/create-pix', buyer), env, makeCtx());
  assert.equal(pixAgain.status, 200);
  assert.deepEqual(await pixAgain.json(), { ok: true, already_paid: true });

  const cardAgain = await worker.fetch(jsonRequest('/api/mp/create-card', {
    ...buyer, token: 'card-token', payment_method_id: 'visa', installments: 1, identification_number: '52998224725',
  }), env, makeCtx());
  assert.equal(cardAgain.status, 200);
  assert.deepEqual(await cardAgain.json(), { ok: true, already_paid: true });

  const mpCreates = fake.calls.filter((c) => c.url === 'https://api.mercadopago.com/v1/payments');
  assert.equal(mpCreates.length, 1, 'no second charge');
});

// ---------------------------------------------------------------------------
// 5. _debug_approve
// ---------------------------------------------------------------------------

test('debug approve: 503 without secret, 403 on wrong or shorter/longer token, 200 on the right one', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });
  await insertOffer(db, { code: 'real' });
  const env = { DB: db, MP_ACCESS_TOKEN: 'mp-token', DEBUG_APPROVE_TOKEN: 'segredo-debug-123' };
  const ctx = makeCtx();
  const created = await (await worker.fetch(jsonRequest('/api/mp/create-pix', {
    offer_code: 'real', name: 'Ana', email: 'ana@example.com', phone: '+55 11999990000',
  }), env, ctx)).json();
  await ctx.drain();

  const call = (token, e = env) => worker.fetch(jsonRequest('/api/mp/_debug_approve', { payment_id: created.payment_id }, {
    headers: token == null ? {} : { 'x-debug-token': token },
  }), e, makeCtx());

  assert.equal((await call('x', { DB: db })).status, 503);
  for (const token of [null, '', 'segredo-debug-124', 'segredo-debug-12', 'segredo-debug-1234', 'SEGREDO-DEBUG-123']) {
    assert.equal((await call(token)).status, 403, String(token));
  }
  const ok = await call('segredo-debug-123');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, payment_id: created.payment_id });
});

test('constantTimeEqual compares full byte sequences', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('', ''), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual('abcd', 'abc'), false);
  assert.equal(constantTimeEqual('ação', 'acao'), false);
  assert.equal(constantTimeEqual(null, ''), true);
});

// ---------------------------------------------------------------------------
// 6. Erros do gateway não vazam detalhes internos
// ---------------------------------------------------------------------------

test('create-pix keeps the Mercado Pago message but hides internal failures', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  t.after(() => dispose());
  await insertOffer(db, { code: 'real' });
  const originalError = console.error;
  console.error = () => {};
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; console.error = originalError; });

  // Sem MP_ACCESS_TOKEN: falha interna, não pode citar a variável.
  const noToken = await worker.fetch(jsonRequest('/api/mp/create-pix', {
    offer_code: 'real', name: 'Ana', email: 'ana@example.com', phone: '+55 11999990000',
  }), { DB: db }, makeCtx());
  assert.equal(noToken.status, 502);
  const body = await noToken.json();
  assert.deepEqual(body, { ok: false, error: 'mp_create_failed', detail: 'gateway_unavailable' });

  // Erro devolvido pelo Mercado Pago: a mensagem segue (o front reconhece e-mail inválido).
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'payer.email must be a valid email' }), {
    status: 400, headers: { 'content-type': 'application/json' },
  });
  const mpError = await worker.fetch(jsonRequest('/api/mp/create-pix', {
    offer_code: 'real', name: 'Ana', email: 'ana2@example.com', phone: '+55 11999990001',
  }), { DB: db, MP_ACCESS_TOKEN: 'mp-token' }, makeCtx());
  assert.equal(mpError.status, 502);
  assert.equal((await mpError.json()).detail, 'payer.email must be a valid email');

  const logged = await db.prepare("SELECT error_detail FROM payment_errors WHERE stage = 'pix_create' ORDER BY id").all();
  assert.match(logged.results[0].error_detail, /MP_ACCESS_TOKEN/, 'full detail stays in payment_errors');
});

// ---------------------------------------------------------------------------
// 9. /internal/* exige a chave do roteador
// ---------------------------------------------------------------------------

test('internal endpoints return 404 without env.__INTERNAL_KEY or with a wrong header', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });
  const offer = await insertOffer(db, { code: 'curso', email_enabled: 1 });
  const lead = await db.prepare(
    "INSERT INTO leads (name, email, phone, method, status, created_at, updated_at) VALUES ('Cliente', 'cliente@example.com', '+55 11999990000', 'Pix', 'pix_gerado', 'x', 'x')"
  ).run();
  await db.prepare(
    `INSERT INTO orders (gateway, gateway_txn_id, status, method, amount_cents, lead_id, offer_id, payer_email, approved_at)
     VALUES ('mercadopago', '123', 'approved', 'pix', 3700, ?, ?, 'cliente@example.com', 'x')`
  ).bind(lead.meta.last_row_id, offer.id).run();
  const base = {
    DB: db, MP_ACCESS_TOKEN: 'mp-token', EMAIL_FROM: 'loja@example.com',
    CLOUDFLARE_EMAIL_API_TOKEN: 'email-token', CLOUDFLARE_EMAIL_ACCOUNT_ID: 'acc-1',
  };
  const refundBody = { lead_id: lead.meta.last_row_id, operation_id: '7cad3cea-42d0-403e-8712-a25a41d82efc' };

  const cases = [
    [base, {}],
    [base, { 'x-internal-call': INTERNAL_KEY }],
    [{ ...base, __INTERNAL_KEY: '' }, { 'x-internal-call': '' }],
    [{ ...base, __INTERNAL_KEY: 'curta' }, { 'x-internal-call': 'curta' }],
    [{ ...base, __INTERNAL_KEY: INTERNAL_KEY }, {}],
    [{ ...base, __INTERNAL_KEY: INTERNAL_KEY }, { 'x-internal-call': INTERNAL_KEY + 'x' }],
  ];
  for (const [env, headers] of cases) {
    for (const [path, body] of [['/internal/dashboard/resend-email', { lead_id: refundBody.lead_id }], ['/internal/dashboard/refund', refundBody]]) {
      const resp = await worker.fetch(jsonRequest(path, body, { headers }), env, makeCtx());
      assert.equal(resp.status, 404, path + ' ' + JSON.stringify(headers));
    }
  }
  const unknown = await worker.fetch(jsonRequest('/internal/qualquer', {}, { headers: { 'x-internal-call': INTERNAL_KEY } }), { ...base, __INTERNAL_KEY: INTERNAL_KEY }, makeCtx());
  assert.equal(unknown.status, 404);
  assert.equal(fake.calls.length, 0, 'no Mercado Pago or e-mail call without the key');

  const ok = await worker.fetch(jsonRequest('/internal/dashboard/resend-email', { lead_id: refundBody.lead_id }, {
    headers: { 'x-internal-call': INTERNAL_KEY },
  }), { ...base, __INTERNAL_KEY: INTERNAL_KEY }, makeCtx());
  assert.equal(ok.status, 200);
});

test('isAuthorizedInternalCall requires a matching key of at least 16 characters', () => {
  const req = (value) => new Request('https://x/internal/dashboard/refund', { headers: value == null ? {} : { 'x-internal-call': value } });
  assert.equal(isAuthorizedInternalCall(req(INTERNAL_KEY), { __INTERNAL_KEY: INTERNAL_KEY }), true);
  assert.equal(isAuthorizedInternalCall(req(INTERNAL_KEY), {}), false);
  assert.equal(isAuthorizedInternalCall(req(null), { __INTERNAL_KEY: INTERNAL_KEY }), false);
  assert.equal(isAuthorizedInternalCall(req('a'.repeat(10)), { __INTERNAL_KEY: 'a'.repeat(10) }), false);
  assert.equal(isAuthorizedInternalCall(req(INTERNAL_KEY), { __INTERNAL_KEY: 12345 }), false);
});
