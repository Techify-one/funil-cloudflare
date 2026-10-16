import test from 'node:test';
import assert from 'node:assert/strict';

import { metaCapiDispatchOutcome, sendMetaCapiEvent } from '../../shared/utils.js';
import { handleCheckoutEvent } from '../../checkout/src/index.js';

function request() {
  return new Request('https://loja.example.com/api/checkout-event', {
    headers: {
      'user-agent': 'meta-capi-regression-test',
      'cf-connecting-ip': '127.0.0.1',
    },
  });
}

test('sendMetaCapiEvent reports missing pixel token instead of silently succeeding', async () => {
  const result = await sendMetaCapiEvent(request(), { META_PIXEL_ID: '111111111111111' }, {
    event_name: 'Purchase',
    event_id: 'purchase-test-missing-token',
    custom_data: { value: 19.9, currency: 'BRL' },
  });

  assert.deepEqual(result, {
    ok: false,
    error: 'meta_capi_not_configured',
  });
});

test('sendMetaCapiEvent reports a rejected Meta response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'Invalid OAuth access token' } }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });

  try {
    const result = await sendMetaCapiEvent(request(), {
      META_PIXEL_ID: '111111111111111',
      META_PIXEL_ACCESS_TOKEN: 'invalid-test-token',
      META_API_VERSION: 'v25.0',
    }, {
      event_name: 'Purchase',
      event_id: 'purchase-test-rejected',
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, 'meta_capi_http_401');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('metaCapiDispatchOutcome marks missing configuration as failed', () => {
  assert.deepEqual(
    metaCapiDispatchOutcome({ ok: false, error: 'meta_capi_not_configured' }),
    { status: 'failed', error: 'meta_capi_not_configured' },
  );
});

test('metaCapiDispatchOutcome marks an accepted event as sent', () => {
  assert.deepEqual(
    metaCapiDispatchOutcome({ ok: true, events_received: 1, fbtrace_id: 'trace-123' }),
    { status: 'sent', error: null },
  );
});

test('checkout CAPI endpoint returns Meta acceptance instead of an unconditional 204', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'trace-production' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  const offer = {
    id: 14,
    code: 'produto-teste',
    name: 'Produto Teste',
    description: '',
    anchor_price_cents: 99700,
    sale_price_cents: 1990,
    is_active: 1,
    out_of_stock: 0,
    thanks_url: '/obrigado',
    meta_pixel_id: '111111111111111',
    meta_capi_token: 'valid-test-token',
  };
  const env = {
    META_API_VERSION: 'v25.0',
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() { return sql.includes('FROM offers') ? offer : null; },
              async all() { return { results: [] }; },
            };
          },
        };
      },
    },
  };
  const req = new Request('https://loja.example.com/api/checkout-event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'test' },
    body: JSON.stringify({
      // Purchase do navegador só é aceito no checkout fake (out_of_stock);
      // para esta oferta real o evento legítimo é o InitiateCheckout.
      event_name: 'InitiateCheckout',
      event_id: 'ic-endpoint-test',
      offer_code: 'produto-teste',
      custom_data: { value: 19.9, currency: 'BRL' },
    }),
  });

  try {
    const response = await handleCheckoutEvent(req, env, { waitUntil() {} });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      ok: true,
      events_received: 1,
      fbtrace_id: 'trace-production',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function captureGraph() {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ events_received: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore() { globalThis.fetch = originalFetch; } };
}

test('sendMetaCapiEvent attaches META_TEST_EVENT_CODE to every server event', async () => {
  const graph = captureGraph();
  try {
    const env = {
      META_PIXEL_ID: '222222222222222',
      META_PIXEL_ACCESS_TOKEN: 'instance-token',
      META_TEST_EVENT_CODE: 'TEST12345',
    };
    const result = await sendMetaCapiEvent(request(), env, { event_name: 'Purchase', event_id: 'purchase-test-code' });
    assert.equal(result.ok, true);
    assert.equal(graph.calls.length, 1);
    assert.equal(graph.calls[0].body.test_event_code, 'TEST12345');
    assert.match(graph.calls[0].url, /\/222222222222222\/events$/);
  } finally {
    graph.restore();
  }
});

test('sendMetaCapiEvent omits test_event_code when the instance leaves it empty or unreplaced', async () => {
  const graph = captureGraph();
  try {
    for (const code of ['', '__META_TEST_EVENT_CODE__', undefined]) {
      await sendMetaCapiEvent(request(), {
        META_PIXEL_ID: '222222222222222',
        META_PIXEL_ACCESS_TOKEN: 'instance-token',
        META_TEST_EVENT_CODE: code,
      }, { event_name: 'Lead', event_id: 'lead-1' });
    }
    assert.equal(graph.calls.length, 3);
    for (const call of graph.calls) assert.equal('test_event_code' in call.body, false);
  } finally {
    graph.restore();
  }
});

test('offer pixel and token override the instance fallback; empty offer uses META_PIXEL_ID', async () => {
  const graph = captureGraph();
  const offerRow = (pixel, token) => ({
    id: 1, code: 'produto-teste', name: 'Produto', description: '', anchor_price_cents: 0,
    sale_price_cents: 1000, is_active: 1, out_of_stock: 0, thanks_url: null,
    meta_pixel_id: pixel, meta_capi_token: token,
  });
  const envFor = (row) => ({
    META_PIXEL_ID: '333333333333333',
    META_PIXEL_ACCESS_TOKEN: 'instance-token',
    DB: { prepare(sql) { return { bind() { return {
      async first() { return sql.includes('FROM offers') ? row : null; },
      async all() { return { results: [] }; },
    }; } }; } },
  });
  const post = (env) => handleCheckoutEvent(new Request('https://loja.example.com/api/checkout-event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_name: 'InitiateCheckout', event_id: 'ic-1', offer_code: 'produto-teste' }),
  }), env, {});
  try {
    await post(envFor(offerRow('444444444444444', 'offer-token')));
    await post(envFor(offerRow(null, null)));
    assert.match(graph.calls[0].url, /\/444444444444444\/events$/);
    assert.equal(graph.calls[0].body.access_token, 'offer-token');
    assert.match(graph.calls[1].url, /\/333333333333333\/events$/);
    assert.equal(graph.calls[1].body.access_token, 'instance-token');
  } finally {
    graph.restore();
  }
});
