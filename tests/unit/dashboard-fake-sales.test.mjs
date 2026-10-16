import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as fake from '../../shared/fake-checkout.mjs';

test('sales API, CSV and UI consume explicit simulated value metadata; frontend sends offer and selected IDs', () => {
  const worker = readFileSync(new URL('../../dashboard/src/worker.js', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../../dashboard/src/vendas.html', import.meta.url), 'utf8');
  const checkout = readFileSync(new URL('../../public/checkout.html', import.meta.url), 'utf8');
  assert.match(worker, /FAKE_SALE_COLUMNS/);
  assert.match(worker, /value_source:/);
  assert.ok(worker.includes('"Tipo de valor"'), 'CSV must distinguish fake value from payment revenue');
  assert.ok(worker.includes('Simulado, sem receita'));
  assert.match(ui, /Valor simulado/);
  const start = checkout.indexOf('function buildFakeLeadBody');
  const end = checkout.indexOf('let fakeSaleFired');
  assert.ok(start >= 0 && end > start, 'checkout.html mantém o corpo da compra simulada');
  const body = checkout.slice(start, end);
  assert.match(body, /offer_code: offer.code/);
  assert.match(body, /order_bump_ids: selectedBumpIds\(\)/);
  assert.match(body, /expected_total_cents: currentTotalCents\(\)/);
});

test('legacy same-offer fake checkout without bumps reconstructs PIX and 990 as estimated, not revenue', () => {
  assert.equal(typeof fake.fakeSaleValue, 'function');
  const value = fake.fakeSaleValue({ product: 'combo', lead_status: 'comprou', fake_offer: 1, fake_offer_price: 990,
    legacy_session: JSON.stringify({ offer_code: 'combo', method: 'pix', bump_selected: 0, last_stage: 'payment_attempt' }) });
  assert.equal(value.method, 'pix');
  assert.equal(value.amount_cents, 990);
  assert.equal(value.value_source, 'legacy_estimated');
  assert.equal(value.is_fake_checkout, true);
});

test('unknown legacy bumps never invent totals and cross-offer sessions are rejected', () => {
  const row = { product: 'combo', lead_status: 'comprou', fake_offer: 1, fake_offer_price: 990 };
  assert.equal(fake.fakeSaleValue({ ...row, legacy_session: JSON.stringify({ offer_code: 'combo', method: 'pix', bump_selected: 1, last_stage: 'payment_attempt' }) }).amount_cents, null);
  assert.equal(fake.fakeSaleValue({ ...row, legacy_session: JSON.stringify({ offer_code: 'other', method: 'pix', bump_selected: 0, last_stage: 'payment_attempt' }) }).method, '');
  assert.equal(fake.fakeSaleValue({ ...row, lead_status: 'nome' }).is_fake_checkout, false);
  assert.equal(fake.fakeSaleValue({ ...row, last_payment_id: 10 }).is_fake_checkout, false);
});

test('persisted same-offer snapshot wins over current catalog; foreign snapshot is ignored', () => {
  const row = { product: 'combo', lead_status: 'comprou', fake_offer_price: 9999 };
  const snapshot = { offer_code: 'combo', method: 'card', total_cents: 1490, offer_name: 'Original', bumps: [{ id: 7, name: 'Suporte', price_cents: 500 }] };
  const result = fake.fakeSaleValue({ ...row, fake_snapshot: JSON.stringify(snapshot) });
  assert.equal(result.amount_cents, 1490);
  assert.equal(result.value_source, 'fake_snapshot');
  assert.deepEqual(result.bumps, snapshot.bumps);
  assert.equal(fake.fakeSaleValue({ ...row, fake_snapshot: JSON.stringify({ ...snapshot, offer_code: 'other' }) }).amount_cents, null);
});
