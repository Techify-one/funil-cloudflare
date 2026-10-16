// Teste de fumaça contra a instância publicada (https://APP_HOSTNAME).
import { loadEnv, resolveConfig, fail, ok, step } from './lib/env.mjs';

const cfg = resolveConfig(loadEnv());
const base = process.env.SMOKE_BASE_URL || `https://${cfg.APP_HOSTNAME}`;
const auth = 'Basic ' + Buffer.from(`${cfg.DASH_USER}:${cfg.DASH_PASS || ''}`).toString('base64');
let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    failures += 1;
    console.log(`  ✖ ${name}: ${err.message}`);
  }
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

step(`Teste de fumaça em ${base}`);

await check('painel exige senha', async () => {
  const r = await fetch(`${base}/painel`, { redirect: 'manual' });
  expect(r.status === 401, `esperado 401, veio ${r.status}`);
});

for (const path of ['/painel', '/leads', '/vendas', '/funil', '/meta', '/ofertas', '/secoes', '/checkout-analytics']) {
  await check(`${path} abre com senha`, async () => {
    const r = await fetch(base + path, { headers: { Authorization: auth } });
    expect(r.status === 200, `esperado 200, veio ${r.status}`);
  });
}

await check('API de ofertas responde', async () => {
  const r = await fetch(`${base}/dashboard/api/offers`, { headers: { Authorization: auth } });
  expect(r.ok, `HTTP ${r.status}`);
});

await check('rota interna bloqueada', async () => {
  const r = await fetch(`${base}/internal/dashboard/refund`, { method: 'POST' });
  expect(r.status === 404, `esperado 404, veio ${r.status}`);
});

await check('página inicial redireciona para a página padrão', async () => {
  const r = await fetch(`${base}/`, { redirect: 'manual' });
  expect([301, 302].includes(r.status), `HTTP ${r.status}`);
});

const page = cfg.DEFAULT_PAGE;
await check(`página /${page} com Pixel e rastreamento`, async () => {
  const r = await fetch(`${base}/${page}?utm_source=smoke&utm_campaign=smoke`);
  expect(r.status === 200, `HTTP ${r.status}`);
  const html = await r.text();
  expect(html.includes("fbq('init'"), 'sem fbq init');
  expect(html.includes('window.__LP'), 'sem window.__LP');
  expect(html.includes('/static/lp-tracking.js'), 'sem lp-tracking.js');
});

await check('script de rastreamento publicado', async () => {
  const r = await fetch(`${base}/static/lp-tracking.js`);
  expect(r.status === 200, `HTTP ${r.status}`);
});

await check('checkout sem oferta responde', async () => {
  const r = await fetch(`${base}/checkout`);
  expect(r.status === 200, `HTTP ${r.status}`);
});

await check('ingestão de eventos de seção', async () => {
  const r = await fetch(`${base}/api/section-event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (smoke)' },
    body: JSON.stringify({ events: [] }),
  });
  expect(r.status < 500, `HTTP ${r.status}`);
});

if (failures) fail(`${failures} verificação(ões) falharam.`);
console.log('\nTudo certo.');
