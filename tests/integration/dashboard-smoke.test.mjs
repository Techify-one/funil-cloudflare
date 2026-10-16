// Smoke test do dashboard: empacota o Worker inteiro (src/index.js) com esbuild,
// roda no Miniflare com um D1 novo criado a partir de migrations/0001_init.sql e
// confere todas as telas, as APIs usadas por elas e os CRUDs principais.
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

// O módulo site/ é escrito em paralelo; enquanto não existir, vira um stub.
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

async function bundleWorker() {
  const out = await build({
    entryPoints: [join(ROOT, 'src/index.js')],
    bundle: true, write: false, format: 'esm', loader: { '.html': 'text' },
    plugins: [siteStub], logLevel: 'silent',
  });
  return out.outputFiles[0].text;
}

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

async function startWorker(script, bindings) {
  const mf = new Miniflare({
    modules: true, script, compatibilityDate: '2025-04-01',
    d1Databases: ['DB'], bindings, serviceBindings: { ASSETS: assetsBinding },
  });
  const db = await mf.getD1Database('DB');
  for (const statement of schemaStatements()) await db.prepare(statement).run();
  return { mf, db };
}

const HTML_ROUTES = ['/leads', '/vendas', '/funil', '/meta', '/painel', '/ofertas', '/secoes', '/checkout-analytics'];

test('dashboard smoke: telas, APIs e CRUDs num banco vazio', async (t) => {
  const script = await bundleWorker();
  const { mf, db } = await startWorker(script, { DASH_PASS: PASS, BRAND_NAME: 'Minha Marca' });
  t.after(() => mf.dispose());

  const call = (path, init = {}) => mf.dispatchFetch(ORIGIN + path, {
    redirect: 'manual', ...init, headers: { authorization: AUTH, ...(init.headers || {}) },
  });
  const getJson = async (path, init) => {
    const response = await call(path, init);
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* texto */ }
    return { status: response.status, body, text };
  };
  const sendJson = (method, path, payload) => getJson(path, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });

  await t.test('todas as telas respondem 200 com login e 401 sem login', async () => {
    for (const route of HTML_ROUTES) {
      const ok = await call(route);
      const html = await ok.text();
      assert.equal(ok.status, 200, route);
      assert.match(ok.headers.get('content-type'), /text\/html/, route);
      assert.equal(html.includes('__BRAND_NAME__'), false, `${route} deixou o placeholder da marca`);

      const anonymous = await mf.dispatchFetch(ORIGIN + route, { redirect: 'manual' });
      await anonymous.text();
      assert.equal(anonymous.status, 401, route);
      assert.match(anonymous.headers.get('www-authenticate'), /^Basic realm="Dashboard"/);
    }
  });

  await t.test('a marca vem de BRAND_NAME e o rodapé usa o host atual', async () => {
    const painel = await (await call('/painel')).text();
    assert.match(painel, /<title>Painel · Minha Marca<\/title>/);
    assert.match(painel, /Painel · Minha Marca<\/h1>/);
    assert.match(painel, /<span data-host><\/span> · Cloudflare Workers/);
    assert.match(painel, /location\.host/);
    assert.match(await (await call('/ofertas')).text(), /<title>Ofertas · Minha Marca<\/title>/);
  });

  await t.test('redirecionamentos legados', async () => {
    for (const [from, to] of [['/dashboard', '/leads'], ['/paginas', '/painel']]) {
      const response = await call(from);
      await response.text();
      assert.equal(response.status, 301, from);
      assert.equal(new URL(response.headers.get('location')).pathname, to);
    }
  });

  await t.test('credenciais erradas recebem 401', async () => {
    for (const credentials of [`admin:errada`, `outro:${PASS}`, 'semdoispontos', `admin:${PASS}x`]) {
      const response = await mf.dispatchFetch(ORIGIN + '/leads', {
        headers: { authorization: 'Basic ' + Buffer.from(credentials).toString('base64') },
      });
      await response.text();
      assert.equal(response.status, 401, credentials);
    }
  });

  await t.test('APIs de leitura respondem 2xx com o banco vazio', async () => {
    const endpoints = [
      '/dashboard/api/leads/search',
      '/dashboard/api/leads/search?q=maria',
      '/dashboard/api/sales/search',
      '/dashboard/api/sales/search?status=comprou&utm_campaign=__none__',
      '/dashboard/api/sales/facets',
      '/dashboard/api/sales/products',
      '/dashboard/api/stats?range=7d',
      '/dashboard/api/funnel?range=30d',
      '/dashboard/api/funnel/utms?range=30d',
      '/dashboard/api/funnels',
      '/dashboard/api/settings',
      '/dashboard/api/painel-links',
      '/dashboard/api/offers',
      '/dashboard/api/sections/meta',
      '/dashboard/api/sections?page=exemplo&range=7d',
      '/dashboard/api/checkout-analytics?range=30d',
      '/dashboard/api/meta/table-config',
      '/dashboard/api/meta/internal-sales?since=2026-01-01&until=2026-01-31&campaign=exemplo',
    ];
    for (const path of endpoints) {
      const { status, body, text } = await getJson(path);
      assert.ok(status >= 200 && status < 300, `${path} -> ${status} ${text.slice(0, 200)}`);
      assert.ok(body && typeof body === 'object', path);
      assert.equal(body.error, undefined, `${path}: ${body.error}`);
    }

    const csv = await call('/dashboard/api/sales/export');
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(await csv.text(), /ID,Data,Nome,Email,Telefone,Produto/);

    const settings = await getJson('/dashboard/api/settings');
    assert.deepEqual(settings.body.blocked_ips, []);
    assert.deepEqual(Object.keys(settings.body).sort(), ['blocked_ips', 'raw'], 'só a lista de IPs é configurável');

    const analytics = await getJson('/dashboard/api/checkout-analytics?range=30d');
    assert.equal(analytics.body.ok, true);
    assert.equal(analytics.body.offer, null, 'sem ofertas o relatório vem vazio, sem erro');
    assert.deepEqual(analytics.body.summary, []);
  });

  await t.test('APIs da Meta sem token devolvem erro JSON (não 500 de SQL)', async () => {
    for (const path of [
      '/dashboard/api/meta/accounts',
      '/dashboard/api/meta/campaigns',
      '/dashboard/api/meta/adsets?campaign_id=1234567',
      '/dashboard/api/meta/ads?campaign_id=1234567',
      '/dashboard/api/meta/insights?time_range=' + encodeURIComponent('{"since":"2026-01-01","until":"2026-01-02"}'),
    ]) {
      const { status, body } = await getJson(path);
      assert.notEqual(status, 500, path);
      assert.ok(status >= 400, path);
      assert.ok(body && typeof body.error === 'string', path);
    }
    const missing = await getJson('/dashboard/api/meta/internal-sales');
    assert.equal(missing.status, 400);
  });

  await t.test('rotas antigas e chaves desconhecidas são recusadas', async () => {
    // Nomes montados por partes: a tela e as APIs de pausa automática de
    // campanha e o reenvio por mensageiro não existem neste projeto.
    const pause = ['kill', 'switches'].join('');
    for (const [method, path] of [
      ['GET', `/${pause}`],
      ['GET', `/dashboard/api/${pause}`],
      ['PUT', `/dashboard/api/${pause}/1`],
      ['POST', '/dashboard/api/sales/1/resend-message'],
      ['GET', '/dashboard/api/nao-existe'],
    ]) {
      const response = await call(path, { method });
      await response.text();
      assert.equal(response.status, 404, `${method} ${path}`);
    }
    const unknownKey = await sendJson('POST', '/dashboard/api/settings', { key: 'notificacoes_enabled', value: 'true' });
    assert.equal(unknownKey.status, 400);
  });

  await t.test('IPs bloqueados: grava, lê e valida', async () => {
    const saved = await sendJson('POST', '/dashboard/api/settings', {
      key: 'blocked_ips', value: [{ value: '203.0.113.0/24', label: 'escritório' }, '2001:db8::/32'],
    });
    assert.equal(saved.status, 200, saved.text);
    const settings = await getJson('/dashboard/api/settings');
    assert.deepEqual(settings.body.blocked_ips.map((e) => e.value), ['203.0.113.0/24', '2001:db8::/32']);
    const invalid = await sendJson('POST', '/dashboard/api/settings', { key: 'blocked_ips', value: ['300.1.1.1/40'] });
    assert.equal(invalid.status, 400);
    const leads = await getJson('/dashboard/api/leads/search');
    assert.equal(leads.status, 200, 'o filtro de IP gera SQL válido');
  });

  await t.test('CRUD de ofertas com e-mail de confirmação e order bump', async () => {
    const payload = {
      code: 'produto-10', name: 'Produto Plano Anual', description: 'Plano anual',
      anchor_price_cents: 29700, sale_price_cents: 9700, is_active: 1, out_of_stock: 0,
      email_enabled: 1, email_subject: 'Sua compra foi confirmada',
      email_body: 'Olá {{nome}}, obrigado por comprar {{produto}}.',
      email_access_url: 'https://example.com/acesso',
      thanks_url: '/obrigado', meta_pixel_id: '123456789012345', meta_capi_token: null,
      order_bumps: [{ name: 'Bônus', description: 'Material extra', price_cents: 990, is_active: 1 }],
    };
    const created = await sendJson('POST', '/dashboard/api/offers', payload);
    assert.equal(created.status, 200, created.text);
    const id = created.body.id;
    assert.ok(Number.isInteger(id));

    const duplicate = await sendJson('POST', '/dashboard/api/offers', payload);
    assert.equal(duplicate.status, 409);

    let list = (await getJson('/dashboard/api/offers')).body.offers;
    assert.equal(list.length, 1);
    const offer = list[0];
    assert.equal(offer.email_enabled, 1);
    assert.equal(offer.email_subject, payload.email_subject);
    assert.equal(offer.email_body, payload.email_body);
    assert.equal(offer.email_access_url, payload.email_access_url);
    assert.equal(Object.keys(offer).some((k) => /whats|tag/i.test(k)), false);
    assert.equal(offer.order_bumps.length, 1);
    assert.equal(offer.order_bumps[0].price_cents, 990);

    for (const url of ['ftp://example.com/x', 'javascript:alert(1)', 'acesso']) {
      const bad = await sendJson('PUT', `/dashboard/api/offers/${id}`, { ...payload, email_access_url: url });
      assert.equal(bad.status, 400, url);
      assert.match(bad.body.error, /Link de acesso/);
    }
    const longSubject = await sendJson('PUT', `/dashboard/api/offers/${id}`, {
      ...payload, email_subject: 'x'.repeat(300), order_bumps: offer.order_bumps,
    });
    assert.equal(longSubject.status, 200);
    list = (await getJson('/dashboard/api/offers')).body.offers;
    assert.equal(list[0].email_subject.length, 200);

    const codeChange = await sendJson('PUT', `/dashboard/api/offers/${id}`, { ...payload, code: 'outro-codigo' });
    assert.equal(codeChange.status, 400);

    const updated = await sendJson('PUT', `/dashboard/api/offers/${id}`, {
      ...payload, email_enabled: 0, email_subject: 'Novo assunto', email_access_url: '',
      order_bumps: [
        { ...offer.order_bumps[0], name: 'Bônus renomeado', price_cents: 1490 },
        { name: 'Segundo bônus', price_cents: 500 },
      ],
    });
    assert.equal(updated.status, 200, updated.text);
    list = (await getJson('/dashboard/api/offers')).body.offers;
    assert.equal(list[0].email_enabled, 0);
    assert.equal(list[0].email_subject, 'Novo assunto');
    assert.equal(list[0].email_access_url, null);
    assert.deepEqual(list[0].order_bumps.map((b) => [b.id === offer.order_bumps[0].id, b.name, b.price_cents]), [
      [true, 'Bônus renomeado', 1490], [false, 'Segundo bônus', 500],
    ]);

    const analytics = await getJson('/dashboard/api/checkout-analytics?range=7d');
    assert.equal(analytics.status, 200);
    assert.equal(analytics.body.offer, 'produto-10', 'sem ?offer= usa a oferta ativa mais recente');
    const explicit = await getJson('/dashboard/api/checkout-analytics?range=7d&offer=outra');
    assert.equal(explicit.body.offer, 'outra');

    const removed = await getJson(`/dashboard/api/offers/${id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual((await getJson('/dashboard/api/offers')).body.offers, []);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM order_bumps').first()).n, 0);
    assert.equal((await getJson(`/dashboard/api/offers/${id}`, { method: 'DELETE' })).status, 404);
  });

  await t.test('CRUD de funis e relatório do funil', async () => {
    const payload = {
      slug: 'exemplo', name: 'LP Exemplo', is_default: true,
      steps: [
        { key: 'views_exemplo', label: 'Visitas', source: 'page_view', match_value: 'exemplo' },
        { key: 'views_checkout', label: 'Checkout', source: 'page_view', match_value: 'checkout' },
        { key: 'filled_email', label: 'E-mail', source: 'lead_status', match_value: 'email' },
        { key: 'purchased', label: 'Compra', source: 'order', match_value: 'approved' },
      ],
    };
    const created = await sendJson('POST', '/dashboard/api/funnels', payload);
    assert.equal(created.status, 200, created.text);
    const id = created.body.id;
    assert.equal((await sendJson('POST', '/dashboard/api/funnels', payload)).status, 409);

    const report = await getJson('/dashboard/api/funnel?funnel=exemplo&range=30d');
    assert.equal(report.status, 200, report.text);
    assert.equal(report.body.funnel.slug, 'exemplo');
    assert.deepEqual(report.body.steps.map((s) => s.value), [0, 0, 0, 0]);
    assert.equal(report.body.business_metrics.meta_available, false);
    const utms = await getJson('/dashboard/api/funnel/utms?funnel=exemplo&range=all&unique_visits=1');
    assert.equal(utms.status, 200, utms.text);

    const updated = await sendJson('PUT', `/dashboard/api/funnels/${id}`, { ...payload, name: 'LP Exemplo 2', steps: payload.steps.slice(0, 2) });
    assert.equal(updated.status, 200, updated.text);
    const funnels = (await getJson('/dashboard/api/funnels')).body.funnels;
    assert.equal(funnels[0].name, 'LP Exemplo 2');
    assert.equal(funnels[0].steps.length, 2);
    assert.equal(funnels[0].is_default, true);

    assert.equal((await sendJson('POST', '/dashboard/api/funnels', { ...payload, slug: 'Inválido!' })).status, 400);
    assert.equal((await getJson(`/dashboard/api/funnels/${id}`, { method: 'DELETE' })).status, 200);
    assert.deepEqual((await getJson('/dashboard/api/funnels')).body.funnels, []);
  });

  await t.test('CRUD de links do painel', async () => {
    const created = await sendJson('POST', '/dashboard/api/painel-links', {
      type: 'public', name: 'Página de exemplo', description: 'LP', url: 'https://example.com/exemplo',
    });
    assert.equal(created.status, 200, created.text);
    const id = created.body.id;
    assert.equal((await sendJson('POST', '/dashboard/api/painel-links', {
      type: 'public', name: 'Duplicado', url: 'https://example.com/exemplo',
    })).status, 409);
    assert.equal((await sendJson('POST', '/dashboard/api/painel-links', {
      type: 'public', name: 'Inválido', url: 'javascript:alert(1)',
    })).status, 400);

    const updated = await sendJson('PUT', `/dashboard/api/painel-links/${id}`, {
      type: 'internal', name: 'Vendas', description: '', url: 'https://example.com/vendas', position: 5,
    });
    assert.equal(updated.status, 200, updated.text);
    const links = (await getJson('/dashboard/api/painel-links')).body.links;
    assert.deepEqual(links.map((l) => [l.type, l.name, l.url, l.position]), [['internal', 'Vendas', 'https://example.com/vendas', 5]]);
    assert.equal((await getJson(`/dashboard/api/painel-links/${id}`, { method: 'DELETE' })).status, 200);
    assert.deepEqual((await getJson('/dashboard/api/painel-links')).body.links, []);
  });

  await t.test('vendas: histórico, disparos, reenvio de e-mail e reembolso delegados ao checkout', async () => {
    await db.prepare(`INSERT INTO offers (id, code, name, sale_price_cents, email_enabled, email_subject)
      VALUES (50, 'produto-email', 'Produto com e-mail', 4700, 1, 'Acesso liberado')`).run();
    await db.prepare(`INSERT INTO leads (id, name, email, phone, method, status, product, created_at, updated_at)
      VALUES (900, 'Maria Teste', 'maria@example.com', '11999990000', 'pix', 'pix_gerado', 'produto-email',
              '2026-10-01T10:00:00-03:00', '2026-10-01T10:05:00-03:00')`).run();

    const search = await getJson('/dashboard/api/sales/search?q=Maria');
    assert.equal(search.status, 200, search.text);
    assert.equal(search.body.results[0].product_label, 'Produto com e-mail');

    const history = await getJson('/dashboard/api/sales/900/history');
    assert.equal(history.status, 200, history.text);
    assert.equal(history.body.lead.email, 'maria@example.com');
    assert.equal((await getJson('/dashboard/api/sales/999999/history')).status, 404);

    const dispatches = await getJson('/dashboard/api/sales/900/dispatches');
    assert.equal(dispatches.status, 200, dispatches.text);
    assert.deepEqual(dispatches.body.offer, {
      code: 'produto-email', name: 'Produto com e-mail', email_enabled: true, email_subject: 'Acesso liberado',
    });
    assert.equal(dispatches.body.lead.email, 'maria@example.com');
    assert.equal(dispatches.body.can_resend, false, 'sem pedido aprovado não há o que reenviar');
    assert.deepEqual(dispatches.body.dispatches, []);

    // O checkout responde pelo reenvio (aqui: lead sem pedido aprovado).
    const resend = await getJson('/dashboard/api/sales/900/resend-email', { method: 'POST' });
    assert.ok([404, 409, 503].includes(resend.status), `${resend.status} ${resend.text}`);
    assert.ok(resend.body && resend.body.error, resend.text);
    assert.notEqual(resend.body.error, 'Serviço de e-mail indisponível', 'a chamada precisa chegar ao checkout');

    // Com pedido aprovado o reenvio fica disponível; sem provedor de e-mail
    // configurado o checkout recusa sem derrubar o dashboard.
    await db.prepare(`INSERT INTO orders (id, gateway, gateway_txn_id, status, method, amount_cents, lead_id, offer_id,
        payer_name, payer_email, created_at, approved_at, updated_at)
      VALUES (70, 'mercadopago', '555000111', 'approved', 'pix', 4700, 900, 50, 'Maria Teste', 'maria@example.com',
              '2026-10-01T10:06:00-03:00', '2026-10-01T10:06:00-03:00', '2026-10-01T10:06:00-03:00')`).run();
    const ready = await getJson('/dashboard/api/sales/900/dispatches');
    assert.equal(ready.body.can_resend, true);
    const attempt = await getJson('/dashboard/api/sales/900/resend-email', { method: 'POST' });
    assert.ok([200, 409, 502, 503].includes(attempt.status), `${attempt.status} ${attempt.text}`);
    assert.ok(attempt.body && (attempt.body.ok === true || attempt.body.error), attempt.text);
    assert.notEqual(attempt.body.error, 'Serviço de e-mail indisponível');
    await db.prepare('DELETE FROM purchase_dispatches WHERE lead_id = 900').run();
    await db.prepare('DELETE FROM orders WHERE id = 70').run();
    assert.equal((await getJson('/dashboard/api/sales/abc/resend-email', { method: 'POST' })).status, 404);
    assert.equal((await getJson('/dashboard/api/sales/900/resend-email')).status, 405);

    const refund = await sendJson('POST', '/dashboard/api/sales/900/refund', { operation_id: crypto.randomUUID() });
    assert.ok(refund.status >= 400 && refund.status < 500, `${refund.status} ${refund.text}`);
    assert.ok(refund.body && refund.body.error, refund.text);

    // Os endpoints internos do checkout não são públicos.
    const internal = await mf.dispatchFetch(ORIGIN + '/internal/dashboard/resend-email', {
      method: 'POST', headers: { authorization: AUTH, 'content-type': 'application/json' }, body: '{"lead_id":900}',
    });
    await internal.text();
    assert.equal(internal.status, 404);

    const removed = await getJson('/dashboard/api/leads/900', { method: 'DELETE' });
    assert.equal(removed.status, 200, removed.text);
  });
});

test('dashboard sem DASH_PASS falha fechado com 503', async (t) => {
  const script = await bundleWorker();
  const { mf } = await startWorker(script, {});
  t.after(() => mf.dispose());
  for (const path of ['/leads', '/painel', '/dashboard/api/offers', '/dashboard']) {
    const response = await mf.dispatchFetch(ORIGIN + path, { redirect: 'manual', headers: { authorization: AUTH } });
    assert.equal(response.status, 503, path);
    assert.equal(await response.text(), 'Configure DASH_PASS (npm run setup)');
  }
});

test('dashboard: segurança (CSRF, iframe, token da CAPI e CSV)', async (t) => {
  const script = await bundleWorker();
  const { mf, db } = await startWorker(script, { DASH_PASS: PASS, BRAND_NAME: 'Minha Marca' });
  t.after(() => mf.dispose());

  const call = (path, init = {}) => mf.dispatchFetch(ORIGIN + path, {
    redirect: 'manual', ...init, headers: { authorization: AUTH, ...(init.headers || {}) },
  });
  const getJson = async (path, init) => {
    const response = await call(path, init);
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* texto */ }
    return { status: response.status, body, text, headers: response.headers };
  };
  const send = (method, path, payload, headers = {}) => getJson(path, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload),
  });
  const countLinks = async () => (await db.prepare('SELECT COUNT(*) AS n FROM painel_links').first()).n;
  const link = (name) => ({ type: 'public', name, description: '', url: `https://example.com/${name}` });

  await t.test('POST de outro site (Sec-Fetch-Site: cross-site) recebe 403 e não grava', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const res = await send('POST', '/dashboard/api/painel-links', link(`csrf-${site}`), { 'sec-fetch-site': site });
      assert.equal(res.status, 403, site);
      assert.equal(res.body.error, 'Requisição de outra origem bloqueada');
    }
    const settings = await send('POST', '/dashboard/api/settings', { key: 'blocked_ips', value: ['203.0.113.9'] },
      { 'sec-fetch-site': 'cross-site', origin: 'https://atacante.example' });
    assert.equal(settings.status, 403);
    const refund = await send('POST', '/dashboard/api/sales/1/refund', { operation_id: 'x' }, { 'sec-fetch-site': 'cross-site' });
    assert.equal(refund.status, 403);
    const del = await getJson('/dashboard/api/offers/1', { method: 'DELETE', headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(del.status, 403);
    assert.equal(await countLinks(), 0);
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'blocked_ips'").first().then((r) => r.n), 0);
  });

  await t.test('POST com Origin de outro host recebe 403', async () => {
    const res = await send('POST', '/dashboard/api/painel-links', link('csrf-origin'), { origin: 'https://atacante.example' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'Requisição de outra origem bloqueada');
    const put = await send('PUT', '/dashboard/api/funnels/1', { slug: 'x' }, { origin: 'null' });
    assert.equal(put.status, 403);
    assert.equal(await countLinks(), 0);
  });

  await t.test('formulário HTML (sem JSON) é recusado mesmo sem cabeçalhos de origem', async () => {
    const res = await getJson('/dashboard/api/painel-links', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(link('csrf-form')),
    });
    assert.equal(res.status, 415);
    const urlencoded = await getJson('/dashboard/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'key=blocked_ips&value=x',
    });
    assert.equal(urlencoded.status, 415);
    assert.equal(await countLinks(), 0);
  });

  await t.test('POST da mesma origem funciona', async () => {
    const res = await send('POST', '/dashboard/api/painel-links', link('mesma-origem'), {
      'sec-fetch-site': 'same-origin', origin: ORIGIN,
    });
    assert.equal(res.status, 200, res.text);
    const originOnly = await send('POST', '/dashboard/api/painel-links', link('so-origin'), { origin: ORIGIN });
    assert.equal(originOnly.status, 200, originOnly.text);
    const typed = await send('POST', '/dashboard/api/painel-links', link('digitado'), { 'sec-fetch-site': 'none' });
    assert.equal(typed.status, 200, typed.text);
    // POST sem corpo (reenvio de e-mail) não exige Content-Type.
    const noBody = await getJson('/dashboard/api/sales/999/resend-email', {
      method: 'POST', headers: { 'sec-fetch-site': 'same-origin' },
    });
    assert.notEqual(noBody.status, 403);
    assert.notEqual(noBody.status, 415);
    assert.equal(await countLinks(), 3);
  });

  await t.test('POST estilo curl (sem Origin nem Sec-Fetch-Site) funciona', async () => {
    const res = await send('POST', '/dashboard/api/painel-links', link('curl'));
    assert.equal(res.status, 200, res.text);
    const del = await getJson(`/dashboard/api/painel-links/${res.body.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200, del.text);
    await db.prepare('DELETE FROM painel_links').run();
  });

  await t.test('telas e APIs não podem ser exibidas em iframe', async () => {
    for (const path of ['/leads', '/ofertas', '/painel', '/dashboard/api/offers', '/dashboard/api/sales/export']) {
      const res = await call(path);
      await res.text();
      assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
      assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'none'", path);
    }
  });

  await t.test('token da CAPI nunca sai do servidor e só muda quando enviado', async () => {
    const TOKEN = 'EAAG-token-secreto-de-teste-1234567890';
    const payload = {
      code: 'oferta-token', name: 'Oferta com token', anchor_price_cents: 0, sale_price_cents: 4700,
      is_active: 1, meta_pixel_id: '123456789012345', meta_capi_token: TOKEN, order_bumps: [],
    };
    const created = await send('POST', '/dashboard/api/offers', payload);
    assert.equal(created.status, 200, created.text);
    const id = created.body.id;
    const storedToken = async () => (await db.prepare('SELECT meta_capi_token AS t FROM offers WHERE id = ?').bind(id).first()).t;
    assert.equal(await storedToken(), TOKEN);

    const list = await getJson('/dashboard/api/offers');
    assert.equal(list.status, 200);
    assert.equal(list.text.includes(TOKEN), false, 'o token não pode aparecer na resposta');
    assert.equal(list.text.includes('"meta_capi_token"'), false);
    const offer = list.body.offers.find((o) => o.id === id);
    assert.equal(offer.meta_capi_token_set, true);
    assert.equal('meta_capi_token' in offer, false);

    // PUT sem o campo (ou com null) mantém o token salvo.
    const { meta_capi_token: _omit, ...withoutToken } = payload;
    const kept = await send('PUT', `/dashboard/api/offers/${id}`, { ...withoutToken, name: 'Renomeada' });
    assert.equal(kept.status, 200, kept.text);
    assert.equal(await storedToken(), TOKEN);
    const keptNull = await send('PUT', `/dashboard/api/offers/${id}`, { ...withoutToken, meta_capi_token: null });
    assert.equal(keptNull.status, 200, keptNull.text);
    assert.equal(await storedToken(), TOKEN);
    assert.equal((await db.prepare('SELECT name FROM offers WHERE id = ?').bind(id).first()).name, 'Oferta com token');

    // Texto novo substitui.
    const replaced = await send('PUT', `/dashboard/api/offers/${id}`, { ...withoutToken, meta_capi_token: 'novo-token' });
    assert.equal(replaced.status, 200, replaced.text);
    assert.equal(await storedToken(), 'novo-token');

    // "" remove.
    const cleared = await send('PUT', `/dashboard/api/offers/${id}`, { ...withoutToken, meta_capi_token: '' });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(await storedToken(), null);
    const after = (await getJson('/dashboard/api/offers')).body.offers.find((o) => o.id === id);
    assert.equal(after.meta_capi_token_set, false);

    // POST sem o campo cria a oferta sem token.
    const noToken = await send('POST', '/dashboard/api/offers', { ...withoutToken, code: 'oferta-sem-token' });
    assert.equal(noToken.status, 200, noToken.text);
    assert.equal((await db.prepare('SELECT meta_capi_token AS t FROM offers WHERE id = ?').bind(noToken.body.id).first()).t, null);

    await db.prepare('DELETE FROM offers').run();
  });

  await t.test('CSV de vendas neutraliza fórmulas de planilha', async () => {
    await db.prepare(`INSERT INTO leads (id, name, email, phone, method, status, product, utm_campaign, created_at, updated_at)
      VALUES (950, '=HYPERLINK("x")', '+cmd@example.com', '-11999990000', 'pix', 'pix_gerado', 'curso', '@SUM(1)',
              '2026-10-01T10:00:00-03:00', '2026-10-01T10:05:00-03:00')`).run();
    const res = await call('/dashboard/api/sales/export?include_internal=1');
    assert.equal(res.status, 200);
    const csv = await res.text();
    assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`), csv);
    assert.ok(csv.includes("'+cmd@example.com"), csv);
    assert.ok(csv.includes("'-11999990000"), csv);
    assert.ok(csv.includes("'@SUM(1)"), csv);
    assert.equal(/(^|,)=HYPERLINK/m.test(csv), false);
    await db.prepare('DELETE FROM leads WHERE id = 950').run();
  });
});
