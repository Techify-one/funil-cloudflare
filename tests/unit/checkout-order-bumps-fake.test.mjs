import test from 'node:test';
import assert from 'node:assert/strict';
const fake = await import('../../shared/fake-checkout.mjs').catch(() => ({}));
import worker from '../../checkout/src/index.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('frontend failed fake save remains retryable and emits no purchase event', async () => {
  const html = readFileSync(new URL('../../public/checkout.html', import.meta.url), 'utf8');
  const source = html.slice(html.indexOf('let fakeSaleFired = false;'), html.indexOf('async function submitFakePix'));
  const context = vm.createContext({ fetch: async () => ({ ok: false, json: async () => ({ ok: false }) }), buildFakeLeadBody: () => ({}), state: {}, currentTotalCents: () => 990, firePurchasePixel: () => {} });
  await vm.runInContext(source + "fakeFireSale({}, 'pix')", context);
  assert.equal(vm.runInContext('fakeSaleFired', context),false);
});

test('retry of a recorded fake intent succeeds even if catalog prices changed', async () => {
  const env = { DB: { prepare(sql) { return { bind() { return {
    async first() { if (sql.includes('FROM offers')) return { id: 8, code: 'combo', name: 'Combo', is_active: 1, out_of_stock: 1, sale_price_cents: 5000 }; if (sql.includes('FROM fake_checkout_purchases')) return { lead_id: 2115, total_cents: 990, method: 'pix' }; return null; },
    async all() { return { results: [] }; }, async run() { throw new Error('retry must not rewrite'); }
  }; } }; } } };
  const response = await worker.fetch(new Request('https://example.com/api/checkout', { method: 'POST', body: JSON.stringify({ id: 2115, name: 'Teste', email: 'test@example.com', phone: '11999999999', status: 'comprou', offer_code: 'combo', method: 'pix', expected_total_cents: 990 }) }), env, {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, 2115);
});

test('checkout persists fake purchase separately and retries do not overwrite snapshots or create payments', async () => {
  const writes = [];
  const offer = { id: 8, code: 'combo', name: 'Combo', out_of_stock: 1, is_active: 1, sale_price_cents: 990 };
  const env = { DB: { prepare(sql) { return { bind(...args) { return { async first() { if (sql.includes('FROM offers')) return offer; if (sql.includes("status = 'comprou'")) return { id: 2115 }; return null; }, async all() { return { results: [{ id: 7, name: 'Suporte', price_cents: 500, is_active: 1 }] }; }, async run() { writes.push({ sql, args }); return { meta: { changes: 1, last_row_id: 2115 } }; } }; } }; } } };
  const response = await worker.fetch(new Request('https://example.com/api/checkout', { method: 'POST', body: JSON.stringify({ id: 2115, name: 'Teste', email: 'test@example.com', phone: '11999999999', status: 'comprou', offer_code: 'combo', method: 'pix', order_bump_ids: [7], expected_total_cents: 1490 }) }), env, { waitUntil() {} });
  assert.equal(response.status, 200);
  const insert = writes.find(w => w.sql.includes('INSERT INTO fake_checkout_purchases'));
  assert.ok(insert, 'must persist a distinct fake snapshot');
  assert.match(insert.sql, /ON CONFLICT.*DO NOTHING/s);
  assert.ok(insert.args.includes(1490));
  assert.ok(insert.args.some(a => typeof a === 'string' && a.includes('Suporte')));
  assert.equal(writes.some(w => /INSERT INTO (payments|orders)/.test(w.sql)), false);
  const progress = writes.find(w => w.sql.includes('UPDATE leads SET') && w.sql.includes('status !='));
  assert.match(progress.sql, /product IS NULL OR product = \?/);
  assert.match(progress.sql, /NOT EXISTS.*payments/s);
});

test('fake purchase snapshots server prices, selected names and method, ignoring client amount', () => {
  assert.equal(typeof fake.buildFakePurchase, 'function');
  const offer = { id: 8, code: 'combo', name: 'Combo', out_of_stock: true, sale_price_cents: 990,
    order_bumps: [{ id: 7, name: 'Suporte', price_cents: 500, is_active: 1 }] };
  const result = fake.buildFakePurchase(offer, { method: 'card', order_bump_ids: [7], amount_cents: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.purchase.method, 'card');
  assert.equal(result.purchase.total_cents, 1490);
  assert.deepEqual(result.purchase.bumps, [{ id: 7, name: 'Suporte', price_cents: 500 }]);
  offer.order_bumps[0].name = 'Mudou';
  assert.equal(result.purchase.bumps[0].name, 'Suporte');
});

test('rejects real offers, invalid methods, inactive or foreign bumps and stale totals', () => {
  const offer = { id: 8, code: 'combo', name: 'Combo', out_of_stock: true, sale_price_cents: 990, order_bumps: [{ id: 7, name: 'B', price_cents: 500, is_active: 0 }] };
  assert.equal(fake.buildFakePurchase({ ...offer, out_of_stock: false }, { method: 'pix' }).error, 'invalid_fake_offer');
  assert.equal(fake.buildFakePurchase(offer, { method: 'boleto' }).error, 'invalid_method');
  for (const id of [7, 99]) assert.equal(fake.buildFakePurchase(offer, { method: 'pix', order_bump_ids: [id] }).error, 'invalid_order_bumps');
  assert.equal(fake.buildFakePurchase(offer, { method: 'pix', expected_total_cents: 1 }).error, 'price_changed');
});
