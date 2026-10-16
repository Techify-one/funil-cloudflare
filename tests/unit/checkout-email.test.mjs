import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildPurchaseEmail,
  isEmailConfigured,
  parseSender,
  sendCloudflareTransactionalEmail,
  sendTransactionalEmail,
} from '../../shared/email.mjs';
import { initialStoredCardStatus } from '../../shared/payment-status.mjs';
import worker from '../../checkout/src/index.js';
import {
  createCheckoutDb, insertOffer, installFakeFetch, jsonRequest, makeCtx,
} from './checkout-harness.mjs';

const OFFER = {
  name: 'Curso de Fotografia',
  email_subject: 'Acesso liberado: {{produto}}',
  email_body: 'Olá, {{nome}}!\nSeu acesso a {{produto}} está pronto.\n<b>sem html</b>',
  email_access_url: 'https://area.example.com/entrar?x=1&y=2',
};

test('builds the purchase email from offer fields, escaping HTML and filling placeholders', () => {
  const email = buildPurchaseEmail({
    name: 'Ma<script>ria Souza',
    email: 'Maria.Souza@Example.com',
    offer: OFFER,
    from: 'Loja Exemplo <contato@loja.example.com>',
    brand: 'Loja Exemplo',
  });

  assert.equal(email.to, 'maria.souza@example.com');
  assert.equal(email.from, 'contato@loja.example.com');
  assert.equal(email.from_name, 'Loja Exemplo');
  assert.equal(email.subject, 'Acesso liberado: Curso de Fotografia');
  assert.match(email.html, /Olá, Ma&lt;script&gt;ria!<br>Seu acesso a Curso de Fotografia está pronto\.<br>&lt;b&gt;sem html&lt;\/b&gt;/);
  assert.doesNotMatch(email.html, /<script>|<b>sem/);
  assert.match(email.html, /href="https:\/\/area\.example\.com\/entrar\?x=1&amp;y=2"/);
  assert.match(email.html, />Acessar<\/a>/);
  assert.match(email.text, /Seu acesso a Curso de Fotografia está pronto\./);
  assert.match(email.text, /Acessar: https:\/\/area\.example\.com\/entrar\?x=1&y=2/);
});

test('uses neutral defaults when the offer has no custom subject, body or link', () => {
  const email = buildPurchaseEmail({
    name: '', email: 'cliente@example.com', offer: { name: 'Produto X' }, from: 'vendas@example.com',
  });
  assert.equal(email.subject, 'Sua compra de Produto X foi confirmada');
  assert.match(email.text, /^Olá, Cliente\./);
  assert.match(email.text, /Sua compra de Produto X foi confirmada/);
  assert.doesNotMatch(email.html, /Acessar/);
  assert.equal(email.from_name, '');
});

test('ignores non-http access links and requires a sender', () => {
  const email = buildPurchaseEmail({
    name: 'A', email: 'a@example.com', offer: { name: 'P', email_access_url: 'javascript:alert(1)' }, from: 'x@example.com',
  });
  assert.doesNotMatch(email.html, /javascript:|Acessar/);
  assert.throws(() => buildPurchaseEmail({ name: 'A', email: 'a@example.com', offer: {}, from: '' }), /email_from_not_configured/);
  assert.throws(() => buildPurchaseEmail({ name: 'A', email: 'invalido', offer: {}, from: 'x@example.com' }), /invalid_recipient_email/);
});

test('parses EMAIL_FROM with or without display name and treats placeholders as empty', () => {
  assert.deepEqual(parseSender('contato@example.com'), { email: 'contato@example.com', name: '' });
  assert.deepEqual(parseSender('"Minha Loja" <Contato@Example.com>'), { email: 'contato@example.com', name: 'Minha Loja' });
  assert.equal(parseSender('__EMAIL_FROM__'), null);
  assert.equal(parseSender('sem-arroba'), null);
});

test('isEmailConfigured needs a sender plus a binding or REST credentials', () => {
  const binding = { send: async () => ({ messageId: 'm' }) };
  assert.equal(isEmailConfigured({}), false);
  assert.equal(isEmailConfigured({ EMAIL: binding }), false);
  assert.equal(isEmailConfigured({ EMAIL_FROM: 'a@example.com' }), false);
  assert.equal(isEmailConfigured({ EMAIL_FROM: 'a@example.com', EMAIL: binding }), true);
  assert.equal(isEmailConfigured({ EMAIL_FROM: 'a@example.com', CLOUDFLARE_EMAIL_API_TOKEN: 't' }), false);
  assert.equal(isEmailConfigured({ EMAIL_FROM: 'a@example.com', CLOUDFLARE_EMAIL_API_TOKEN: 't', CLOUDFLARE_EMAIL_ACCOUNT_ID: 'acc' }), true);
});

test('accepts a queued Cloudflare REST response as a successful dispatch', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      success: true,
      result: { queued: ['cliente@example.com'], delivered: [], permanent_bounces: [] },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await sendCloudflareTransactionalEmail({
    accountId: 'account-123',
    apiToken: 'secret-token',
    message: buildPurchaseEmail({ name: 'Cliente', email: 'Cliente@example.com', offer: OFFER, from: 'vendas@example.com' }),
    fetchImpl,
  });

  assert.deepEqual(result, { status: 'queued' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/account-123/email/sending/send');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-token');
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.from, 'vendas@example.com');
  assert.equal(sent.to, 'cliente@example.com');
});

test('rejects Cloudflare bounces and API failures', async () => {
  const message = buildPurchaseEmail({ name: 'Buyer', email: 'buyer@example.com', offer: OFFER, from: 'vendas@example.com' });
  const bounced = async () => new Response(JSON.stringify({
    success: true,
    result: { queued: [], delivered: [], permanent_bounces: ['buyer@example.com'] },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  await assert.rejects(
    sendCloudflareTransactionalEmail({ accountId: 'account-123', apiToken: 'secret-token', message, fetchImpl: bounced }),
    /permanent_bounce/,
  );

  const failed = async () => new Response(JSON.stringify({
    success: false, errors: [{ code: 123, message: 'disabled' }],
  }), { status: 403, headers: { 'content-type': 'application/json' } });

  await assert.rejects(
    sendCloudflareTransactionalEmail({ accountId: 'account-123', apiToken: 'secret-token', message, fetchImpl: failed }),
    /cloudflare_email_403/,
  );
});

test('prefers the send_email binding over the REST API', async () => {
  const sent = [];
  let restCalls = 0;
  const env = {
    EMAIL: { async send(msg) { sent.push(msg); return { messageId: 'msg-1' }; } },
    CLOUDFLARE_EMAIL_API_TOKEN: 'token',
    CLOUDFLARE_EMAIL_ACCOUNT_ID: 'acc',
  };
  const message = buildPurchaseEmail({
    name: 'Ana', email: 'ana@example.com', offer: OFFER, from: 'Loja <loja@example.com>',
  });
  const result = await sendTransactionalEmail({ env, message, fetchImpl: async () => { restCalls += 1; return new Response('{}'); } });

  assert.equal(result.status, 'sent');
  assert.equal(result.transport, 'binding');
  assert.equal(restCalls, 0);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].from, { email: 'loja@example.com', name: 'Loja' });
  assert.equal(sent[0].to, 'ana@example.com');
  assert.equal(sent[0].subject, message.subject);
  assert.equal(sent[0].html, message.html);
  assert.equal(sent[0].text, message.text);
});

test('falls back to REST without a binding and surfaces binding error codes', async () => {
  const message = buildPurchaseEmail({ name: 'Ana', email: 'ana@example.com', offer: OFFER, from: 'loja@example.com' });
  const rest = await sendTransactionalEmail({
    env: { CLOUDFLARE_EMAIL_API_TOKEN: 'token', CLOUDFLARE_EMAIL_ACCOUNT_ID: 'acc' },
    message,
    fetchImpl: async () => new Response(JSON.stringify({ success: true, result: { delivered: ['ana@example.com'] } }), { status: 200 }),
  });
  assert.deepEqual(rest, { status: 'delivered', transport: 'rest' });

  const failing = { EMAIL: { async send() { const e = new Error('nope'); e.code = 'E_SENDER_NOT_VERIFIED'; throw e; } } };
  await assert.rejects(sendTransactionalEmail({ env: failing, message }), /email_binding_E_SENDER_NOT_VERIFIED/);
});

test('stores an immediately approved card as pending until transition processing', () => {
  assert.equal(initialStoredCardStatus('approved'), 'pending');
  assert.equal(initialStoredCardStatus('rejected'), 'rejected');
  assert.equal(initialStoredCardStatus('cancelled'), 'cancelled');
  assert.equal(initialStoredCardStatus('in_process'), 'in_process');
  assert.equal(initialStoredCardStatus(null), 'pending');
});

test('checkout wires the generic e-mail module and gates it on offers.email_enabled', () => {
  const source = readFileSync(new URL('../../checkout/src/index.js', import.meta.url), 'utf8');
  assert.match(source, /from ['"]\.\.\/\.\.\/shared\/email\.mjs['"]/);
  assert.match(source, /from ['"]\.\.\/\.\.\/shared\/payment-status\.mjs['"]/);
  assert.match(source, /const initialStatus = initialStoredCardStatus\(mpPayment\.status\)/);
  assert.match(source, /Number\(o\.offer_email_enabled\) === 1/);
  assert.match(source, /channel: 'email'/);
});

// ---------------------------------------------------------------------------
// Fluxo completo: Pix criado pelo checkout, aprovado via /api/mp/_debug_approve,
// efeitos pós-compra lidos de orders + offers num D1 real (schema 0001).
// ---------------------------------------------------------------------------

async function buyWithPix(env, fakeFetch, offerCode, { email = 'comprador@example.com' } = {}) {
  const ctx = makeCtx();
  const create = await worker.fetch(jsonRequest('/api/mp/create-pix', {
    offer_code: offerCode,
    name: 'Comprador Teste',
    email,
    phone: '+55 11999990000',
    funnel: 'meu-funil',
    utm_source: 'fb',
  }), env, ctx);
  const created = await create.json();
  assert.equal(create.status, 200, JSON.stringify(created));
  await ctx.drain();

  const approveCtx = makeCtx();
  const approve = await worker.fetch(jsonRequest('/api/mp/_debug_approve', { payment_id: created.payment_id }, {
    headers: { 'x-debug-token': env.DEBUG_APPROVE_TOKEN },
  }), env, approveCtx);
  assert.equal(approve.status, 200);
  await approveCtx.drain();
  return created;
}

function baseEnv(db, extra = {}) {
  return {
    DB: db,
    MP_ACCESS_TOKEN: 'mp-test-token',
    DEBUG_APPROVE_TOKEN: 'debug-token',
    META_PIXEL_ID: '555555555555555',
    META_PIXEL_ACCESS_TOKEN: 'pixel-token',
    ...extra,
  };
}

test('email_enabled=1 sends the confirmation once and logs a dispatch', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });

  const offer = await insertOffer(db, { code: 'com-email', email_enabled: 1, ...OFFER });
  const env = baseEnv(db, {
    EMAIL_FROM: 'Loja <loja@example.com>',
    BRAND_NAME: 'Loja',
    CLOUDFLARE_EMAIL_API_TOKEN: 'email-token',
    CLOUDFLARE_EMAIL_ACCOUNT_ID: 'acc-1',
  });
  const created = await buyWithPix(env, fake, offer.code);

  const emailCalls = fake.only('https://api.cloudflare.com/');
  assert.equal(emailCalls.length, 1);
  assert.equal(emailCalls[0].body.to, 'comprador@example.com');
  assert.equal(emailCalls[0].body.subject, 'Acesso liberado: Curso de Fotografia');

  const dispatches = (await db.prepare('SELECT channel, status, triggered_by, destination, error FROM purchase_dispatches ORDER BY id').all()).results;
  assert.deepEqual(dispatches.map((d) => [d.channel, d.status, d.triggered_by]), [
    ['capi', 'sent', 'auto'],
    ['email', 'queued', 'auto'],
  ]);
  assert.equal(dispatches[1].destination, 'comprador@example.com');

  // Polling + webhook depois da aprovação não reenviam (compare-and-set em side_effects_at).
  const statusCtx = makeCtx();
  await worker.fetch(new Request('https://loja.example.com/api/mp/status?payment_id=' + created.payment_id), env, statusCtx);
  await worker.fetch(jsonRequest('/api/mp/_debug_approve', { payment_id: created.payment_id }, {
    headers: { 'x-debug-token': 'debug-token' },
  }), env, statusCtx);
  await statusCtx.drain();
  assert.equal(fake.only('https://api.cloudflare.com/').length, 1);

  const order = await db.prepare('SELECT status, side_effects_at, meta_event_id FROM orders').first();
  assert.equal(order.status, 'approved');
  assert.ok(order.side_effects_at);
  assert.equal(order.meta_event_id, 'purchase-' + created.payment_id);
});

test('email_enabled=0 skips the e-mail entirely', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });

  const offer = await insertOffer(db, { code: 'sem-email', email_enabled: 0, ...OFFER });
  const env = baseEnv(db, {
    EMAIL_FROM: 'loja@example.com',
    CLOUDFLARE_EMAIL_API_TOKEN: 'email-token',
    CLOUDFLARE_EMAIL_ACCOUNT_ID: 'acc-1',
  });
  await buyWithPix(env, fake, offer.code);

  assert.equal(fake.only('https://api.cloudflare.com/').length, 0);
  const channels = (await db.prepare('SELECT channel FROM purchase_dispatches').all()).results.map((r) => r.channel);
  assert.deepEqual(channels, ['capi']);
});

test('missing e-mail configuration logs a skipped dispatch without calling any transport', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });

  const offer = await insertOffer(db, { code: 'sem-config', email_enabled: 1 });
  // Token presente, mas sem EMAIL_FROM: tratado como não configurado.
  const env = baseEnv(db, { CLOUDFLARE_EMAIL_API_TOKEN: 'email-token', CLOUDFLARE_EMAIL_ACCOUNT_ID: 'acc-1', EMAIL_FROM: '__EMAIL_FROM__' });
  await buyWithPix(env, fake, offer.code);

  assert.equal(fake.only('https://api.cloudflare.com/').length, 0);
  const email = await db.prepare("SELECT status, error FROM purchase_dispatches WHERE channel = 'email'").first();
  assert.deepEqual({ ...email }, { status: 'skipped', error: 'email_nao_configurado' });
});

test('the send_email binding is used in the purchase flow when present', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });

  const sent = [];
  const offer = await insertOffer(db, { code: 'binding', email_enabled: 1, name: 'Produto B' });
  const env = baseEnv(db, {
    EMAIL_FROM: 'loja@example.com',
    BRAND_NAME: 'Loja',
    EMAIL: { async send(msg) { sent.push(msg); return { messageId: 'abc' }; } },
    CLOUDFLARE_EMAIL_API_TOKEN: 'email-token',
    CLOUDFLARE_EMAIL_ACCOUNT_ID: 'acc-1',
  });
  await buyWithPix(env, fake, offer.code);

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].from, { email: 'loja@example.com', name: 'Loja' });
  assert.equal(sent[0].subject, 'Sua compra de Produto B foi confirmada');
  assert.equal(fake.only('https://api.cloudflare.com/').length, 0);
  const email = await db.prepare("SELECT status, message FROM purchase_dispatches WHERE channel = 'email'").first();
  assert.equal(email.status, 'sent');
  assert.match(email.message, /transport=binding/);
});

test('out_of_stock (fake) purchases never create payments, orders or e-mails', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });

  const offer = await insertOffer(db, { code: 'esgotado', out_of_stock: 1, email_enabled: 1, sale_price_cents: 990 });
  const env = baseEnv(db, {
    EMAIL_FROM: 'loja@example.com',
    EMAIL: { async send() { throw new Error('must not send'); } },
  });
  const ctx = makeCtx();
  const resp = await worker.fetch(jsonRequest('/api/checkout', {
    status: 'comprou', name: 'Fulano', email: 'fulano@example.com', phone: '11988887777',
    offer_code: offer.code, method: 'pix', expected_total_cents: 990,
  }), env, ctx);
  await ctx.drain();
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.ok(body.id);

  const counts = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM payments) AS payments,
      (SELECT COUNT(*) FROM orders) AS orders,
      (SELECT COUNT(*) FROM purchase_dispatches) AS dispatches,
      (SELECT COUNT(*) FROM fake_checkout_purchases) AS fakes`).first();
  assert.deepEqual({ ...counts }, { payments: 0, orders: 0, dispatches: 0, fakes: 1 });
  assert.equal(fake.calls.length, 0);
});
