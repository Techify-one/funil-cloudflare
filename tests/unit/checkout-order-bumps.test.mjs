import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateOrderBumps,
  normalizeSelectedBumpIds,
  calculateCheckoutSelection,
  buildPaymentItems,
} from '../../shared/order-bumps.mjs';

test('validates and normalizes up to 10 configurable order bumps', () => {
  const result = validateOrderBumps([
    { id: 7, name: 'Templates', description: 'Pacote rápido', price_cents: 1290, is_active: 1 },
    { name: 'Prompts', description: '', price_cents: 700, is_active: 0 },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.bumps, [
    { id: 7, name: 'Templates', description: 'Pacote rápido', price_cents: 1290, is_active: 1, position: 0 },
    { id: null, name: 'Prompts', description: null, price_cents: 700, is_active: 0, position: 1 },
  ]);
});

test('rejects malformed, duplicate, or excessive order bumps', () => {
  assert.match(validateOrderBumps([{ name: '', price_cents: 100 }]).error, /nome/i);
  assert.match(validateOrderBumps([{ name: 'X', price_cents: -1 }]).error, /preço/i);
  assert.match(validateOrderBumps([
    { id: 4, name: 'A', price_cents: 100 },
    { id: 4, name: 'B', price_cents: 200 },
  ]).error, /duplicado/i);
  assert.match(validateOrderBumps(Array.from({ length: 11 }, (_, i) => ({ name: `B${i}`, price_cents: 100 }))).error, /10/);
});

test('normalizes selected ids without duplicates and rejects invalid values', () => {
  assert.deepEqual(normalizeSelectedBumpIds([3, '2', 3]), { ok: true, ids: [3, 2] });
  assert.equal(normalizeSelectedBumpIds(['x']).ok, false);
  assert.equal(normalizeSelectedBumpIds(Array.from({ length: 11 }, (_, i) => i + 1)).ok, false);
});

test('calculates checkout total from server-side active bumps only', () => {
  const bumps = [
    { id: 1, offer_id: 8, name: 'A', description: '', price_cents: 500, is_active: 1, position: 0 },
    { id: 2, offer_id: 8, name: 'B', description: '', price_cents: 700, is_active: 1, position: 1 },
  ];
  const result = calculateCheckoutSelection(3700, bumps, [2, 1]);
  assert.equal(result.ok, true);
  assert.equal(result.total_cents, 4900);
  assert.deepEqual(result.selected.map((b) => b.id), [1, 2]);
});

test('rejects stale or foreign bump ids instead of silently undercharging', () => {
  const result = calculateCheckoutSelection(3700, [{ id: 1, price_cents: 500, is_active: 1, position: 0 }], [1, 99]);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_order_bumps');
});

test('builds Mercado Pago line items for the base offer and selected bumps', () => {
  const items = buildPaymentItems(
    { id: 8, name: 'Oferta teste', sale_price_cents: 3700 },
    [{ id: 2, name: 'Bônus prático', description: 'Descrição curta', price_cents: 700 }],
  );
  assert.deepEqual(items, [
    { id: 'offer-8', title: 'Oferta teste', description: 'Oferta teste', category_id: 'learnings', quantity: 1, unit_price: 37 },
    { id: 'bump-2', title: 'Bônus prático', description: 'Descrição curta', category_id: 'learnings', quantity: 1, unit_price: 7 },
  ]);
});
