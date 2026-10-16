// Compras simuladas (oferta esgotada): o checkout grava um snapshot imutável e o
// dashboard mostra o valor como "simulado", nunca como receita. Roda o Worker
// inteiro (src/index.js) no Miniflare com o schema de migrations/0001_init.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response as MfResponse } from 'miniflare';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ORIGIN = 'https://painel.example.com';
const PASS = 'senha-de-teste';
const AUTH = 'Basic ' + Buffer.from(`admin:${PASS}`).toString('base64');
const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const HUMAN_CF = { asn: 28126, country: 'BR', botManagement: { score: 99, corporateProxy: false, verifiedBot: false } };

const siteStub = {
  name: 'site-stub',
  setup(b) {
    b.onResolve({ filter: /(^|\/)site\/src\/index\.js$/ }, () => (
      existsSync(join(ROOT, 'site/src/index.js')) ? null : { path: 'site-stub', namespace: 'site-stub' }
    ));
    b.onLoad({ filter: /.*/, namespace: 'site-stub' }, () => ({
      contents: 'export default { async fetch() { return new Response("Not found", { status: 404 }); } };',
      loader: 'js',
    }));
  },
};

function schemaStatements() {
  const sql = readFileSync(join(ROOT, 'migrations/0001_init.sql'), 'utf8')
    .split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
  return sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}

function assetsBinding(request) {
  const { pathname } = new URL(request.url);
  const file = join(ROOT, 'public', pathname.replace(/^\/+/, ''));
  if (!file.startsWith(join(ROOT, 'public')) || !existsSync(file)) return new MfResponse('Not found', { status: 404 });
  return new MfResponse(readFileSync(file), { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

test('legado estimado, sessão de outra oferta, snapshot novo e repetição da compra simulada', async (t) => {
  const bundle = await build({
    entryPoints: [join(ROOT, 'src/index.js')],
    bundle: true, write: false, format: 'esm', loader: { '.html': 'text' },
    plugins: [siteStub], logLevel: 'silent',
  });
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-04-01',
    d1Databases: ['DB'], bindings: { DASH_PASS: PASS }, serviceBindings: { ASSETS: assetsBinding },
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const statement of schemaStatements()) await db.prepare(statement).run();

  await db.exec(`
    INSERT INTO offers (id, code, name, sale_price_cents, is_active, out_of_stock) VALUES (8, 'combo', 'Combo', 990, 1, 1);
    INSERT INTO order_bumps (id, offer_id, name, description, price_cents, is_active, position) VALUES (7, 8, 'Suporte', 'Descrição', 500, 1, 0);
    INSERT INTO leads (id, name, email, phone, method, status, product, created_at, updated_at) VALUES (2115, 'Legado', '', '', '', 'comprou', 'combo', '2026-10-05', '2026-10-05');
    INSERT INTO checkout_sessions (visit_uuid, lead_id, offer_code, method, bump_selected, last_stage, started_at, last_seen_at) VALUES ('legacy', 2115, 'combo', 'pix', 0, 'payment_attempt', '2026-10-05', '2026-10-05');
  `);

  const dashboard = async (path) => {
    const response = await mf.dispatchFetch(ORIGIN + path, { headers: { authorization: AUTH } });
    const body = path.includes('/export') ? await response.text() : await response.json();
    assert.equal(response.status, 200, typeof body === 'string' ? body : JSON.stringify(body));
    return body;
  };
  const history = (id) => dashboard(`/dashboard/api/sales/${id}/history`);

  let legacy = await history(2115);
  assert.equal(legacy.lead.method, 'Pix');
  assert.equal(legacy.last_payment_amount_cents, 990);
  assert.equal(legacy.value_source, 'legacy_estimated');
  assert.equal(legacy.is_fake_checkout, true);
  await db.prepare("UPDATE checkout_sessions SET offer_code = 'foreign'").run();
  legacy = await history(2115);
  assert.equal(legacy.last_payment_amount_cents, null, 'sessão de outra oferta nunca empresta valor');

  const data = {
    name: 'Teste', email: 'test@example.com', phone: '11999999999', status: 'comprou',
    offer_code: 'combo', method: 'card', order_bump_ids: [7], expected_total_cents: 1490, amount_cents: 1,
  };
  const purchase = async () => {
    const response = await mf.dispatchFetch(ORIGIN + '/api/checkout', {
      method: 'POST', cf: HUMAN_CF,
      headers: { 'content-type': 'application/json', 'user-agent': BROWSER, 'cf-connecting-ip': '192.0.2.10' },
      body: JSON.stringify(data),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  data.id = (await purchase()).id;
  assert.ok(Number.isInteger(data.id));
  await db.prepare('UPDATE offers SET sale_price_cents = 9999').run();
  assert.equal((await purchase()).id, data.id, 'repetir a compra devolve o mesmo lead');

  const fresh = await history(data.id);
  assert.equal(fresh.lead.method, 'Cartão');
  assert.equal(fresh.last_payment_amount_cents, 1490, 'o snapshot guarda o total do momento da compra');
  assert.equal(fresh.value_source, 'fake_snapshot');
  assert.equal(fresh.fake_order_bumps[0].name, 'Suporte');
  assert.ok(fresh.events.some((event) => event.type === 'fake_checkout'));

  const search = await dashboard('/dashboard/api/sales/search?q=Teste');
  const sale = search.results.find((row) => row.id === data.id);
  assert.ok(sale, JSON.stringify(search));
  assert.equal(sale.last_payment_amount_cents, 1490);
  assert.equal(sale.is_fake_checkout, true);
  assert.equal(sale.value_source, 'fake_snapshot');
  assert.equal(sale.can_refund, false, 'compra simulada não tem pagamento a reembolsar');

  const csv = await dashboard('/dashboard/api/sales/export');
  assert.match(csv, /Simulado, sem receita/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM payments').first()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM fake_checkout_purchases').first()).n, 1);
});
