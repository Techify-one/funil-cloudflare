import test from 'node:test';
import assert from 'node:assert/strict';

import worker, { statementDescriptor, guaranteeDays } from '../../checkout/src/index.js';
import {
  assetsBinding, createCheckoutDb, insertOffer, installFakeFetch, jsonRequest, makeCtx,
} from './checkout-harness.mjs';

test('statement descriptor is sanitized to Mercado Pago limits', () => {
  assert.equal(statementDescriptor({ STATEMENT_DESCRIPTOR: 'Minha Loja' }), 'MINHA LOJA');
  assert.equal(statementDescriptor({ STATEMENT_DESCRIPTOR: 'Ação & Cia. Digital 2026' }), 'ACAO CIA DIGI');
  assert.equal(statementDescriptor({ STATEMENT_DESCRIPTOR: '' }), null);
  assert.equal(statementDescriptor({ STATEMENT_DESCRIPTOR: '__STATEMENT_DESCRIPTOR__' }), null);
  assert.equal(statementDescriptor({ STATEMENT_DESCRIPTOR: '!!!' }), null);
  assert.equal(statementDescriptor({}), null);
});

async function createPayment(env, path, extra = {}) {
  const ctx = makeCtx();
  const resp = await worker.fetch(jsonRequest(path, {
    offer_code: 'produto',
    name: 'Joana',
    email: '',
    phone: '+55 11999990000',
    ...extra,
  }), env, ctx);
  await ctx.drain();
  return resp;
}

test('statement_descriptor comes from env on Pix and card, and is omitted when empty', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });
  await insertOffer(db, { code: 'produto' });

  const base = { DB: db, MP_ACCESS_TOKEN: 'mp-token' };
  const card = {
    token: 'card-token', payment_method_id: 'visa', installments: 1, identification_number: '52998224725',
  };

  assert.equal((await createPayment({ ...base, STATEMENT_DESCRIPTOR: 'Minha Loja' }, '/api/mp/create-pix', { email: 'a@example.com' })).status, 200);
  assert.equal((await createPayment({ ...base, STATEMENT_DESCRIPTOR: 'Minha Loja' }, '/api/mp/create-card', { email: 'b@example.com', phone: '+55 11999990001', ...card })).status, 200);
  assert.equal((await createPayment({ ...base, STATEMENT_DESCRIPTOR: '' }, '/api/mp/create-pix', { email: 'c@example.com', phone: '+55 11999990002' })).status, 200);
  assert.equal((await createPayment(base, '/api/mp/create-card', { email: 'd@example.com', phone: '+55 11999990003', ...card })).status, 200);

  const bodies = fake.calls
    .filter((c) => c.url === 'https://api.mercadopago.com/v1/payments')
    .map((c) => c.body);
  assert.equal(bodies.length, 4);
  assert.equal(bodies[0].statement_descriptor, 'MINHA LOJA');
  assert.equal(bodies[1].statement_descriptor, 'MINHA LOJA');
  assert.equal('statement_descriptor' in bodies[2], false);
  assert.equal('statement_descriptor' in bodies[3], false);
  assert.equal(bodies[0].payment_method_id, 'pix');
  assert.equal(bodies[1].payment_method_id, 'visa');
  assert.match(bodies[0].external_reference, /^ord-\d+-\d+-[0-9a-f]{12}$/);
});

test('payer sent to Mercado Pago uses a neutral fallback last name', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });
  await insertOffer(db, { code: 'produto' });

  const resp = await createPayment({ DB: db, MP_ACCESS_TOKEN: 'mp-token' }, '/api/mp/create-pix', { email: 'joana@example.com' });
  assert.equal(resp.status, 200);
  const body = fake.calls.find((c) => c.url === 'https://api.mercadopago.com/v1/payments').body;
  assert.deepEqual(body.payer, { email: 'joana@example.com', first_name: 'Joana', last_name: 'Cliente' });
  assert.equal(body.notification_url, 'https://loja.example.com/api/mp/webhook');
});

test('checkout page renders brand, guarantee and pixel placeholders from env', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  t.after(() => dispose());
  await insertOffer(db, { code: 'produto', meta_pixel_id: null, meta_capi_token: 'segredo' });
  const env = {
    DB: db, ASSETS: assetsBinding(), BRAND_NAME: 'Loja <Exemplo>', GUARANTEE_DAYS: '15',
    META_PIXEL_ID: '777777777777777', MP_PUBLIC_KEY: 'TEST-PK',
  };

  const resp = await worker.fetch(new Request('https://loja.example.com/checkout/produto'), env, makeCtx());
  assert.equal(resp.status, 200);
  const html = await resp.text();
  assert.match(html, /<title>Checkout \| Loja &lt;Exemplo&gt;<\/title>/);
  assert.match(html, /window\.__CHECKOUT_GUARANTEE__ = '15'/);
  assert.match(html, /fbq\('init', '777777777777777'\)/);
  assert.match(html, /window\.__MP_PUBLIC_KEY__ = 'TEST-PK'/);
  assert.doesNotMatch(html, /segredo/);
  assert.doesNotMatch(html, /__(BRAND_NAME|GUARANTEE_DAYS|META_PIXEL_ID|MP_PK_VAL|OFFER_JSON)__/);

  assert.equal(guaranteeDays({}), '30');
  assert.equal(guaranteeDays({ GUARANTEE_DAYS: '0' }), '0');
  assert.equal(guaranteeDays({ GUARANTEE_DAYS: 'abc' }), '30');
  assert.equal(guaranteeDays({ GUARANTEE_DAYS: '__GUARANTEE_DAYS__' }), '30');

  const fallback = await worker.fetch(new Request('https://loja.example.com/checkout'), { ...env, BRAND_NAME: '' }, makeCtx());
  assert.match(await fallback.text(), /<title>Checkout \| Checkout<\/title>/);
});

test('debug approve requires the token and approves only existing payments', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });
  await insertOffer(db, { code: 'produto' });
  const env = { DB: db, MP_ACCESS_TOKEN: 'mp-token', DEBUG_APPROVE_TOKEN: 'debug' };

  const created = await (await createPayment(env, '/api/mp/create-pix', { email: 'x@example.com' })).json();
  const call = (token, id) => worker.fetch(jsonRequest('/api/mp/_debug_approve', { payment_id: id }, {
    headers: token ? { 'x-debug-token': token } : {},
  }), env, makeCtx());

  assert.equal((await call(null, created.payment_id)).status, 403);
  assert.equal((await call('debug', '123')).status, 404);
  assert.equal((await worker.fetch(jsonRequest('/api/mp/_debug_approve', { payment_id: '1' }), { DB: db }, makeCtx())).status, 503);
  const ok = await call('debug', created.payment_id);
  assert.equal(ok.status, 200);

  const status = await (await worker.fetch(new Request('https://loja.example.com/api/mp/status?payment_id=' + created.payment_id), env, makeCtx())).json();
  assert.equal(status.status, 'approved');
  assert.equal(status.meta_event_id, 'purchase-' + created.payment_id);
});
