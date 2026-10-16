import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../../checkout/src/index.js';
import {
  createCheckoutDb, insertOffer, installFakeFetch, jsonRequest, makeCtx,
} from './checkout-harness.mjs';

// Chave interna que o roteador injeta no env do checkout e envia no cabeçalho
// x-internal-call das chamadas do shim CHECKOUT_SERVICE.
const INTERNAL_KEY = 'chave-interna-de-teste-0123456789';
const INTERNAL_HEADERS = { 'x-internal-call': INTERNAL_KEY };

const EMAIL_ENV = {
  EMAIL_FROM: 'Loja <loja@example.com>',
  CLOUDFLARE_EMAIL_API_TOKEN: 'email-token',
  CLOUDFLARE_EMAIL_ACCOUNT_ID: 'acc-1',
  __INTERNAL_KEY: INTERNAL_KEY,
};

async function seedApprovedOrder(db, offer, { email = 'cliente@example.com', status = 'approved' } = {}) {
  const lead = await db.prepare(
    `INSERT INTO leads (name, email, phone, phone_norm, method, status, created_at, updated_at)
     VALUES ('Cliente Teste', ?, '+55 11999990000', '5511999990000', 'Pix', 'pix_gerado', '2026-01-01T10:00:00-03:00', '2026-01-01T10:00:00-03:00')`
  ).bind(email).run();
  const leadId = lead.meta.last_row_id;
  await db.prepare(
    `INSERT INTO orders (gateway, gateway_txn_id, status, method, amount_cents, lead_id, offer_id,
                         payer_name, payer_email, approved_at, side_effects_at)
     VALUES ('mercadopago', ?, ?, 'pix', 3700, ?, ?, 'Cliente Teste', ?, '2026-01-01T10:05:00-03:00', '2026-01-01T10:05:00-03:00')`
  ).bind(String(800000 + leadId), status, leadId, offer.id, email).run();
  return leadId;
}

function resend(env, body) {
  return worker.fetch(jsonRequest('/internal/dashboard/resend-email', body, { headers: INTERNAL_HEADERS }), env, makeCtx());
}

test('resend-email sends the confirmation again and logs a manual dispatch', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });

  const offer = await insertOffer(db, { code: 'curso', name: 'Curso X', email_enabled: 1 });
  const leadId = await seedApprovedOrder(db, offer);
  const resp = await resend({ DB: db, ...EMAIL_ENV }, { lead_id: leadId });

  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), { ok: true, status: 'queued', destination: 'cliente@example.com' });
  const calls = fake.only('https://api.cloudflare.com/');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.subject, 'Sua compra de Curso X foi confirmada');
  const dispatch = await db.prepare('SELECT channel, status, triggered_by, destination, lead_id, offer_id FROM purchase_dispatches').first();
  assert.deepEqual({ ...dispatch }, {
    channel: 'email', status: 'queued', triggered_by: 'manual',
    destination: 'cliente@example.com', lead_id: leadId, offer_id: offer.id,
  });
});

test('resend-email returns 404 when the lead has no approved order', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });

  const offer = await insertOffer(db, { code: 'curso', email_enabled: 1 });
  const pendingLead = await seedApprovedOrder(db, offer, { status: 'pending' });
  for (const leadId of [pendingLead, 999]) {
    const resp = await resend({ DB: db, ...EMAIL_ENV }, { lead_id: leadId });
    assert.equal(resp.status, 404);
    assert.equal((await resp.json()).error, 'order_not_found');
  }
  assert.equal(fake.calls.length, 0);
});

test('resend-email returns 409 when the offer has e-mail disabled or there is no address', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });

  const disabled = await insertOffer(db, { code: 'desligado', email_enabled: 0 });
  const leadA = await seedApprovedOrder(db, disabled, { email: 'a@example.com' });
  const r1 = await resend({ DB: db, ...EMAIL_ENV }, { lead_id: leadA });
  assert.equal(r1.status, 409);
  assert.equal((await r1.json()).error, 'email_disabled');

  const enabled = await insertOffer(db, { code: 'ligado', email_enabled: 1 });
  const leadB = await seedApprovedOrder(db, enabled, { email: '' });
  const r2 = await resend({ DB: db, ...EMAIL_ENV }, { lead_id: leadB });
  assert.equal(r2.status, 409);
  assert.equal((await r2.json()).error, 'no_email');

  assert.equal(fake.calls.length, 0);
  const count = await db.prepare('SELECT COUNT(*) AS n FROM purchase_dispatches').first();
  assert.equal(count.n, 0);
});

test('resend-email returns 503 and logs a skipped dispatch when e-mail is not configured', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });

  const offer = await insertOffer(db, { code: 'curso', email_enabled: 1 });
  const leadId = await seedApprovedOrder(db, offer);
  const resp = await resend({ DB: db, CLOUDFLARE_EMAIL_API_TOKEN: 'email-token', __INTERNAL_KEY: INTERNAL_KEY }, { lead_id: leadId });

  assert.equal(resp.status, 503);
  assert.equal((await resp.json()).error, 'email_nao_configurado');
  assert.equal(fake.calls.length, 0);
  const dispatch = await db.prepare('SELECT status, error, triggered_by FROM purchase_dispatches').first();
  assert.deepEqual({ ...dispatch }, { status: 'skipped', error: 'email_nao_configurado', triggered_by: 'manual' });
});

test('resend-email returns 502 when the transport fails and 400 on bad input', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch({ email: { fail: true } });
  t.after(async () => { fake.restore(); await dispose(); });

  const offer = await insertOffer(db, { code: 'curso', email_enabled: 1 });
  const leadId = await seedApprovedOrder(db, offer);
  const failed = await resend({ DB: db, ...EMAIL_ENV }, { lead_id: leadId });
  assert.equal(failed.status, 502);
  const body = await failed.json();
  assert.equal(body.error, 'email_send_failed');
  assert.match(body.message, /cloudflare_email_500/);
  const dispatch = await db.prepare('SELECT status FROM purchase_dispatches').first();
  assert.equal(dispatch.status, 'failed');

  assert.equal((await resend({ DB: db, ...EMAIL_ENV }, { lead_id: 'x' })).status, 400);
  const invalidJson = await worker.fetch(new Request('https://loja.example.com/internal/dashboard/resend-email', {
    method: 'POST', body: '{', headers: INTERNAL_HEADERS,
  }), { DB: db, ...EMAIL_ENV }, makeCtx());
  assert.equal(invalidJson.status, 400);
});

test('resend-email works through the router shim and stays blocked publicly', async (t) => {
  const { db, dispose } = await createCheckoutDb();
  const fake = installFakeFetch();
  t.after(async () => { fake.restore(); await dispose(); });

  const { resolveModule } = await import('../../src/routes.mjs');
  assert.equal(resolveModule('/internal/dashboard/resend-email'), 'blocked');

  const offer = await insertOffer(db, { code: 'curso', email_enabled: 1 });
  const leadId = await seedApprovedOrder(db, offer);
  // Mesmo contrato do shim do roteador: chave no env do checkout e no cabeçalho.
  const shim = {
    fetch: (input, init) => {
      const request = new Request(input instanceof Request ? input : new Request(input, init));
      request.headers.set('x-internal-call', INTERNAL_KEY);
      return worker.fetch(request, { DB: db, ...EMAIL_ENV }, makeCtx());
    },
  };
  const resp = await shim.fetch(new Request('https://checkout.internal/internal/dashboard/resend-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lead_id: leadId }),
  }));
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).ok, true);
  assert.equal(fake.only('https://api.cloudflare.com/').length, 1);

  // Chamada direta sem a chave (como uma requisição pública) não alcança o handler.
  const direct = await worker.fetch(new Request('https://checkout.internal/internal/dashboard/resend-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lead_id: leadId }),
  }), { DB: db, ...EMAIL_ENV }, makeCtx());
  assert.equal(direct.status, 404);
  assert.equal(fake.only('https://api.cloudflare.com/').length, 1);
});
