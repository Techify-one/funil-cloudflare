import test from 'node:test';
import assert from 'node:assert/strict';

import { isValidCheckoutEmail } from '../../checkout/src/index.js';

test('rejects common mistyped email endings before contacting Mercado Pago', () => {
  assert.equal(isValidCheckoutEmail('cliente@gmail.comm'), false);
  assert.equal(isValidCheckoutEmail('cliente@hotmail.con'), false);
  assert.equal(isValidCheckoutEmail('cliente@outlook.coom'), false);
  assert.equal(isValidCheckoutEmail('cliente@yahoo.cpm'), false);
});

test('accepts ordinary valid checkout email addresses', () => {
  assert.equal(isValidCheckoutEmail('cliente@gmail.com'), true);
  assert.equal(isValidCheckoutEmail('cliente@empresa.com.br'), true);
  assert.equal(isValidCheckoutEmail('cliente+compra@dominio.digital'), true);
});
