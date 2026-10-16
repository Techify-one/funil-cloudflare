import test from 'node:test';
import assert from 'node:assert/strict';

import { createMpFullRefund } from '../../checkout/src/index.js';

test('creates a full Mercado Pago refund without sending an amount', async () => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ id: 987, payment_id: 123456, amount: 19.9, status: 'approved' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const operationId = '7cad3cea-42d0-403e-8712-a25a41d82efc';
    const result = await createMpFullRefund({ MP_ACCESS_TOKEN: 'test-token' }, '123456', operationId);

    assert.equal(captured.url, 'https://api.mercadopago.com/v1/payments/123456/refunds');
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.headers['X-Idempotency-Key'], operationId);
    assert.equal(captured.init.headers.Authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(captured.init.body), {});
    assert.equal(result.status, 'approved');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('surfaces Mercado Pago refund errors without treating them as success', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    message: 'The action requested is not valid for the current payment state',
    cause: [{ code: 2063, description: 'Payment is not refundable' }],
  }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });

  try {
    await assert.rejects(
      createMpFullRefund(
        { MP_ACCESS_TOKEN: 'test-token' },
        '123456',
        '7cad3cea-42d0-403e-8712-a25a41d82efc',
      ),
      (error) => error.message === 'Payment is not refundable' && error.mpCode === '2063',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
