// Utilitários dos testes do checkout: D1 real (Miniflare, em memória) com o
// schema de migrations/0001_init.sql, ASSETS servindo public/, e um fetch
// global falso que imita Mercado Pago, Meta CAPI e a API de e-mail.
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';

const ROOT = new URL('../../', import.meta.url);
const SCHEMA = readFileSync(new URL('migrations/0001_init.sql', ROOT), 'utf8');

function schemaStatements() {
  const withoutComments = SCHEMA
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join('\n');
  return withoutComments
    .split(/;\s*(?:\n|$)/)
    .map((stmt) => stmt.trim())
    .filter(Boolean);
}

export async function createCheckoutDb() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    d1Databases: { DB: 'checkout-test-' + Math.random().toString(16).slice(2) },
  });
  const db = await mf.getD1Database('DB');
  await db.batch(schemaStatements().map((sql) => db.prepare(sql)));
  return { db, dispose: () => mf.dispose() };
}

export function assetsBinding() {
  return {
    async fetch(input) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      try {
        const body = readFileSync(new URL('public' + url.pathname, ROOT));
        return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    },
  };
}

export function makeCtx() {
  const pending = [];
  return {
    waitUntil(promise) { pending.push(Promise.resolve(promise).catch(() => {})); },
    async drain() {
      while (pending.length) await pending.shift();
    },
  };
}

export async function insertOffer(db, fields = {}) {
  const offer = {
    code: 'oferta-teste',
    name: 'Produto Teste',
    description: 'Descrição',
    anchor_price_cents: 9700,
    sale_price_cents: 3700,
    is_active: 1,
    out_of_stock: 0,
    thanks_url: '/obrigado',
    meta_pixel_id: null,
    meta_capi_token: null,
    email_enabled: 0,
    email_subject: null,
    email_body: null,
    email_access_url: null,
    ...fields,
  };
  const cols = Object.keys(offer);
  const res = await db.prepare(
    `INSERT INTO offers (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).bind(...cols.map((c) => offer[c])).run();
  return { id: res.meta.last_row_id, ...offer };
}

// Fetch global falso. Registra todas as chamadas e responde conforme o host.
// `mp` permite customizar a resposta de criação de pagamento.
export function installFakeFetch({ mp = {}, email = {} } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  let nextPaymentId = 900000001;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { 'content-type': 'application/json' },
    });
    if (url === 'https://api.mercadopago.com/v1/payments' && init.method === 'POST') {
      const id = nextPaymentId++;
      return jsonResponse({
        id,
        status: mp.status || 'pending',
        status_detail: mp.status_detail || 'pending_waiting_transfer',
        date_of_expiration: null,
        point_of_interaction: { transaction_data: { qr_code: 'PIX-' + id, qr_code_base64: '', ticket_url: '' } },
      }, 201);
    }
    if (url.startsWith('https://api.mercadopago.com/v1/payments/')) {
      const id = url.split('/').pop();
      return jsonResponse({ id: Number(id), status: mp.lookupStatus || 'pending' });
    }
    if (url.startsWith('https://graph.facebook.com/')) {
      return jsonResponse({ events_received: 1, fbtrace_id: 'trace-test' });
    }
    if (url.startsWith('https://api.cloudflare.com/client/v4/accounts/')) {
      if (email.fail) return jsonResponse({ success: false, errors: [{ code: 1000, message: 'fail' }] }, 500);
      return jsonResponse({
        success: true,
        result: { delivered: [], queued: [body && body.to], permanent_bounces: [] },
      });
    }
    return jsonResponse({ error: 'unexpected_url', url }, 599);
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
    only(prefix) { return calls.filter((c) => c.url.startsWith(prefix)); },
  };
}

export function jsonRequest(path, body, { method = 'POST', headers = {} } = {}) {
  return new Request('https://loja.example.com' + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
      'cf-connecting-ip': '203.0.113.10',
      ...headers,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
}
