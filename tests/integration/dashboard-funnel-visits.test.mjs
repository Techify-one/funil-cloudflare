// Contagem de visitas do /funil (total x únicas), filtro de robôs e de IPs,
// rodando o Worker inteiro (src/index.js) no Miniflare com o schema real.
// As visitas entram pelas páginas que existem no projeto: o checkout e, quando
// o módulo site/ já existe, a página de exemplo dele.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response as MfResponse } from 'miniflare';
import * as botDetection from '../../shared/bot-detection.mjs';

const { humanPageViewFilter, historicalBotBackfillSql } = botDetection;
const AD_REVIEW_UA = botDetection.AD_REVIEW_BROWSER_UA;

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ORIGIN = 'https://painel.example.com';
const PASS = 'senha-de-teste';
const AUTH = 'Basic ' + Buffer.from(`admin:${PASS}`).toString('base64');
const HAS_SITE = existsSync(join(ROOT, 'site/src/index.js'));
const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
// Sinais de borda de um visitante comum (o Miniflare repassa `cf` ao Worker).
const HUMAN_CF = { asn: 28126, country: 'BR', botManagement: { score: 99, corporateProxy: false, verifiedBot: false } };

const siteStub = {
  name: 'site-stub',
  setup(b) {
    b.onResolve({ filter: /(^|\/)site\/src\/index\.js$/ }, () => (
      HAS_SITE ? null : { path: 'site-stub', namespace: 'site-stub' }
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

test('sinais de robô da Cloudflare sobrevivem ao wrapper do cookie da primeira visita', async (t) => {
  const bundle = await build({
    stdin: {
      resolveDir: ROOT,
      contents: `import { withPageViewTracking, logPageView } from './shared/utils.js';
        export default withPageViewTracking({ async fetch(request) {
          let recorded = 0;
          const DB = { prepare: () => ({ bind: () => ({ run: async () => { recorded++; } }) }) };
          await logPageView('exemplo', request, { DB }, 'exemplo');
          return new Response(JSON.stringify({ recorded }), { headers: { 'content-type': 'text/html' } });
        } });`,
    },
    bundle: true, write: false, format: 'esm', logLevel: 'silent',
  });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-04-01' });
  t.after(() => mf.dispose());
  const cases = [
    [{ botManagement: { verifiedBot: true, score: 99 } }, 0],
    [{ botManagement: { score: 1 } }, 0],
    [{ verifiedBotCategory: 'Ads Verification' }, 0],
    [{ botManagement: { score: 99 } }, 1],
    [{ botManagement: { score: 1, corporateProxy: true } }, 1],
  ];
  for (const [cf, recorded] of cases) {
    const response = await mf.dispatchFetch('https://example.com/exemplo', { headers: { 'user-agent': 'Mozilla/5.0 Chrome/152.0.0.0 Safari/537.36' }, cf });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).recorded, recorded, JSON.stringify(cf));
    assert.match(response.headers.get('set-cookie') || '', /tx_session_uuid=/, 'a resposta HTML recebe o cookie de sessão');
  }
});

test('o funil conta recargas, visitantes únicos, robôs e IPs bloqueados', async (t) => {
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

  // Funil "exemplo": página de venda -> checkout -> e-mail -> compra.
  await db.exec(`
    INSERT INTO funnels (id, slug, name, is_default) VALUES (1, 'exemplo', 'LP Exemplo', 1);
    INSERT INTO funnel_steps (funnel_id, position, key, label, source, match_value) VALUES (1, 1, 'lp', 'LP', 'page_view', 'exemplo'), (1, 2, 'checkout', 'Checkout', 'page_view', 'checkout'), (1, 3, 'lead', 'Email', 'lead_status', 'email'), (1, 4, 'purchase', 'Compra', 'order', 'approved');
    INSERT INTO offers (id, code, name, sale_price_cents, is_active) VALUES (1, 'produto-exemplo', 'Produto Exemplo', 1990, 1);
    INSERT INTO settings (key, value) VALUES ('blocked_ips', '["192.0.2.99"]');
  `);

  // Página de venda: a do site quando existe; senão a visita é gravada direto.
  async function visitLanding(query = '', cookie = '', options = {}) {
    if (HAS_SITE) return visit('/exemplo' + query, cookie, options);
    const uuid = (cookie.match(/tx_session_uuid=([^;]+)/) || [])[1] || crypto.randomUUID();
    const ua = options.headers?.['user-agent'] ?? BROWSER;
    if (options.method === 'HEAD' || options.adReview || /bot|curl|python|headless/i.test(ua)) return uuid;
    const campaign = new URLSearchParams(query.replace(/^\?/, '')).get('utm_campaign');
    await db.prepare(`INSERT INTO page_views (page, funnel, ip, user_agent, created_at, utm_campaign, session_uuid)
      VALUES ('exemplo', 'exemplo', '192.0.2.1', ?, ?, ?, ?)`).bind(ua, new Date().toISOString(), campaign, uuid).run();
    return uuid;
  }

  // Cada navegação vira uma requisição real ao Worker; os page_views são
  // gravados em waitUntil, então esperamos o banco refletir a escrita.
  async function visit(path, cookie = '', options = {}) {
    const before = (await db.prepare('SELECT COUNT(*) AS n FROM page_views').first()).n;
    const response = await mf.dispatchFetch(ORIGIN + path, {
      method: options.method || 'GET', redirect: 'manual', cf: options.cf || HUMAN_CF,
      headers: { 'user-agent': BROWSER, 'cf-connecting-ip': '192.0.2.1', cookie, ...options.headers },
    });
    await response.arrayBuffer();
    assert.equal(response.status, 200, path);
    if (options.expectWrite !== false) {
      for (let i = 0; i < 50; i++) {
        if ((await db.prepare('SELECT COUNT(*) AS n FROM page_views').first()).n > before) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return response.headers.get('set-cookie')?.match(/tx_session_uuid=([^;]+)/)?.[1]
      || cookie.match(/tx_session_uuid=([^;]+)/)?.[1];
  }
  async function report(params = '') {
    const response = await mf.dispatchFetch(`${ORIGIN}/dashboard/api/funnel?funnel=exemplo&range=all${params}`, { headers: { authorization: AUTH } });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  }
  const counts = (data) => data.steps.map((step) => step.value);

  await t.test('F5 conta duas vezes por padrão e uma vez no modo de visitantes únicos', async () => {
    const uuid = await visitLanding('?utm_campaign=reload');
    assert.match(uuid, /^[0-9a-f-]{36}$/i);
    const cookie = `tx_session_uuid=${uuid}`;
    assert.equal(await visitLanding('?utm_campaign=reload', cookie), uuid);
    assert.equal(await visit('/checkout/produto-exemplo?funnel=exemplo&utm_campaign=reload', cookie), uuid);
    assert.equal(await visit('/checkout/produto-exemplo?funnel=exemplo&utm_campaign=reload', cookie), uuid);
    assert.deepEqual(counts(await report()), [2, 2, 0, 0]);
    const unique = await report('&unique_visits=1');
    assert.equal(unique.unique_visits, true);
    assert.deepEqual(counts(unique), [1, 1, 0, 0]);
    assert.deepEqual(counts(await report('&unique_visits=0')), [2, 2, 0, 0]);
    await visitLanding('?utm_campaign=reload'); // Outro navegador, mesmo IP/UA.
    assert.deepEqual(counts(await report('&unique_visits=1')), [2, 1, 0, 0]);
    const contextRow = await db.prepare("SELECT request_context FROM page_views WHERE page = 'checkout' AND session_uuid = ? LIMIT 1").bind(uuid).first();
    assert.equal(JSON.parse(contextRow.request_context).asn, 28126, 'contexto de borda gravado para auditoria');
  });

  await t.test('quem entra direto no checkout mantém o identificador entre recargas', async () => {
    const uuid = await visit('/checkout/produto-exemplo?funnel=exemplo');
    await visit('/checkout/produto-exemplo?funnel=exemplo', `tx_session_uuid=${uuid}`);
    assert.deepEqual(counts(await report()), [3, 4, 0, 0]);
    assert.deepEqual(counts(await report('&unique_visits=1')), [2, 2, 0, 0]);
  });

  await t.test('identidades legadas, filtros e compras mantêm a semântica', async () => {
    await db.prepare(`
      INSERT INTO page_views (page, funnel, ip, user_agent, created_at, utm_campaign) VALUES
        ('exemplo', 'exemplo', '192.0.2.5', 'Legacy Browser', '2026-09-01 10:00:00', 'legacy'),
        ('exemplo', 'exemplo', '192.0.2.5', 'Legacy Browser', '2026-09-01 11:00:00', 'legacy'),
        ('exemplo', 'exemplo', '192.0.2.5', 'Different Browser', '2026-09-01 12:00:00', 'legacy'),
        ('exemplo', 'exemplo', NULL, NULL, '2026-09-01 12:00:00', 'legacy'),
        ('exemplo', 'exemplo', '', '', '2026-09-01 12:00:00', 'legacy'),
        ('exemplo', 'exemplo', '192.0.2.99', 'Blocked Browser', '2026-09-01 12:00:00', 'legacy'),
        ('exemplo', 'outro', '192.0.2.5', 'Legacy Browser', '2026-09-01 12:00:00', 'legacy')
    `).run();
    await db.exec(`
      INSERT INTO leads (name, email, phone, method, funnel, status, created_at) VALUES ('Comprador', 'buyer@example.test', '', '', 'exemplo', 'email', '2026-09-01'), ('Comprador', 'buyer@example.test', '', '', 'exemplo', 'email', '2026-09-01');
      INSERT INTO orders (gateway, funnel_id, status, payer_email, amount_cents, created_at) VALUES ('mercadopago', 1, 'approved', 'buyer@example.test', 1990, '2026-09-01'), ('mercadopago', 1, 'approved', 'buyer@example.test', 1990, '2026-09-01');
    `);
    assert.deepEqual(counts(await report('&utm_campaign=legacy')), [5, 0, 0, 0]);
    assert.deepEqual(counts(await report('&utm_campaign=legacy&unique_visits=1')), [4, 0, 0, 0]);
    assert.deepEqual(counts(await report('&utm_campaign=legacy&unique_visits=1&include_internal=1')), [5, 0, 0, 0]);
    const dateFilter = '&utm_campaign=legacy&start=2026-09-01T10:30:00Z&end=2026-09-01T11:30:00Z';
    assert.deepEqual(counts(await report(dateFilter + '&unique_visits=1')), [1, 0, 0, 0]);
    assert.deepEqual(counts(await report()).slice(2), [1, 1]);
    const unique = await report('&unique_visits=1');
    assert.deepEqual(counts(unique).slice(2), [1, 1]);
    assert.equal(unique.business_metrics.received_cents, 3980);
    assert.equal(unique.business_metrics.approved_orders, 2);
    assert.deepEqual(counts(await report('&unique_visits=1&end=2000-01-01')), [0, 0, 0, 0]);
    const response = await mf.dispatchFetch(`${ORIGIN}/dashboard/api/funnel/utms?funnel=exemplo&range=all&unique_visits=1`, { headers: { authorization: AUTH } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).values.utm_campaign.find((entry) => entry.value === 'legacy').count, 4);
  });

  await t.test('HEAD, robôs e cookies inválidos não quebram o registro', async () => {
    const before = counts(await report());
    await visitLanding('', '', { method: 'HEAD', expectWrite: false });
    await visit('/checkout/produto-exemplo?funnel=exemplo', '', { method: 'HEAD', expectWrite: false });
    await visitLanding('', '', { headers: { 'user-agent': 'Googlebot' }, expectWrite: false });
    await visit('/checkout/produto-exemplo?funnel=exemplo', '', { headers: { 'user-agent': 'GPTBot/1.4' }, expectWrite: false });
    assert.deepEqual(counts(await report()), before);
    const uuid = await visit('/checkout/produto-exemplo?funnel=exemplo', 'tx_session_uuid=%E0%A4%A');
    assert.match(uuid, /^[0-9a-f-]{36}$/i);
    await visit('/checkout/produto-exemplo?funnel=exemplo', `tx_session_uuid=${uuid}`);
    const result = await db.prepare('SELECT COUNT(*) AS n FROM page_views WHERE session_uuid = ?').bind(uuid).first();
    assert.equal(result.n, 2);
  });

  await t.test('robôs históricos ficam fora dos totais, dos únicos e das opções de UTM', async () => {
    const ua = 'Mozilla/5.0 (Linux; Android 15) Chrome/152 Mobile Safari/537.36 [FB_IAB/FB4A;]';
    const signatures = [ua + ' meta-externalads/1.1', 'Cloudflare-Healthchecks/1.0', 'GPTBot/1.4', 'curl/8.5.0', 'HeadlessChrome/147.0.0.0'];
    const insert = db.prepare("INSERT INTO page_views (page, funnel, ip, user_agent, created_at, utm_campaign) VALUES (?, 'exemplo', '192.0.2.1', ?, '2026-09-01', 'bot-filter')");
    for (const page of ['exemplo', 'checkout']) {
      for (const signature of signatures) await insert.bind(page, signature).run();
      await insert.bind(page, ua).run();
      await insert.bind(page, ua).run(); // F5 humano no mesmo IP.
      await insert.bind(page, ua + ' Instagram (CUBOT; KINGKONG POWER)').run();
    }
    await db.prepare(historicalBotBackfillSql('page_views')).run();
    assert.deepEqual(counts(await report('&utm_campaign=bot-filter')), [3, 3, 0, 0]);
    assert.deepEqual(counts(await report('&utm_campaign=bot-filter&include_internal=1')), [3, 3, 0, 0]);
    assert.deepEqual(counts(await report('&utm_campaign=bot-filter&unique_visits=1&include_internal=1')), [2, 2, 0, 0]);
    await db.prepare("INSERT INTO page_views (page, funnel, user_agent, created_at, utm_campaign) VALUES ('exemplo', 'exemplo', 'GPTBot/1.4', '2026-09-01', 'only-bots')").run();
    await db.prepare(historicalBotBackfillSql('page_views')).run();
    const response = await mf.dispatchFetch(`${ORIGIN}/dashboard/api/funnel/utms?funnel=exemplo&range=all&include_internal=1`, { headers: { authorization: AUTH } });
    assert.equal(response.status, 200);
    const campaigns = (await response.json()).values.utm_campaign;
    assert.equal(campaigns.find((row) => row.value === 'bot-filter').count, 6);
    assert.equal(campaigns.some((row) => row.value === 'only-bots'), false);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM page_views WHERE utm_campaign = 'bot-filter'").first()).n, 16, 'o histórico bruto é mantido');
    const filtered = await db.prepare('SELECT COUNT(*) AS n FROM page_views pv WHERE utm_campaign = ?' + humanPageViewFilter('pv')).bind('bot-filter').first();
    assert.equal(filtered.n, 6);
    const reasons = await db.prepare("SELECT DISTINCT bot_reason FROM page_views WHERE is_bot = 1 AND utm_campaign = 'bot-filter' ORDER BY bot_reason").all();
    assert.deepEqual(reasons.results.map((row) => row.bot_reason), ['ai_fetcher', 'browser_automation', 'cloudflare_crawler', 'http_client', 'meta_crawler']);
  });

  await t.test('robôs recebem as páginas mas não geram visitas nem analytics do checkout', async () => {
    const before = await db.prepare('SELECT COUNT(*) AS n FROM page_views').first();
    const sessionsBefore = await db.prepare('SELECT COUNT(*) AS n FROM checkout_sessions').first();
    for (const ua of ['meta-externalads/1.1', 'Cloudflare-Healthchecks/1.0', 'GPTBot/1.4', 'python-requests/2.34.2']) {
      await visitLanding('', '', { headers: { 'user-agent': ua }, expectWrite: false });
      await visit('/checkout/produto-exemplo?funnel=exemplo', '', { headers: { 'user-agent': ua }, expectWrite: false });
      const response = await mf.dispatchFetch(ORIGIN + '/api/checkout-analytics', {
        method: 'POST', cf: HUMAN_CF, headers: { 'user-agent': ua, 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'opened', visit_uuid: '2a9d1387-5f50-4d92-bcc2-44210f93e35d', offer_code: 'produto-exemplo' }),
      });
      await response.arrayBuffer();
      assert.equal(response.status, 200);
    }
    assert.deepEqual(await db.prepare('SELECT COUNT(*) AS n FROM page_views').first(), before);
    assert.deepEqual(await db.prepare('SELECT COUNT(*) AS n FROM checkout_sessions').first(), sessionsBefore);
  });

  await t.test('revisores de anúncio mascarados não somam visitas e recargas humanas continuam contando', { skip: !AD_REVIEW_UA && 'perfil de revisão de anúncios não exportado' }, async () => {
    const cookie = 'tx_session_uuid=916712b2-dbbf-421f-afb8-018ed8662d38';
    const campaign = '?funnel=exemplo&utm_source=fb&utm_medium=paid&utm_campaign=ad-review-live';
    const headers = { 'user-agent': AD_REVIEW_UA, referer: 'https://www.facebook.com/' };
    for (const cf of [{ asn: 16509, country: 'US' }, { asn: 32934, country: 'US' }]) {
      await visitLanding(campaign, cookie, { headers, cf, expectWrite: false, adReview: true });
      await visit('/checkout/produto-exemplo' + campaign, cookie, { headers, cf, expectWrite: false });
      const response = await mf.dispatchFetch(ORIGIN + '/api/checkout-analytics', {
        method: 'POST', cf, headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'opened', visit_uuid: '7c1f0d4e-2a3b-4c5d-8e9f-0a1b2c3d4e5f', offer_code: 'produto-exemplo' }),
      });
      await response.arrayBuffer();
      assert.equal(response.status, 200);
    }
    assert.deepEqual(counts(await report('&utm_campaign=ad-review-live&include_internal=1')).slice(0, 2), [0, 0]);
    for (let reload = 0; reload < 2; reload++) {
      const options = { headers, cf: { asn: 28126, country: 'BR' } };
      await visitLanding(campaign, cookie, options);
      await visit('/checkout/produto-exemplo' + campaign, cookie, options);
    }
    assert.deepEqual(counts(await report('&utm_campaign=ad-review-live')).slice(0, 2), [2, 2]);
    assert.deepEqual(counts(await report('&utm_campaign=ad-review-live&unique_visits=1')).slice(0, 2), [1, 1]);
    const row = await db.prepare("SELECT request_context FROM page_views WHERE page = 'checkout' AND utm_campaign='ad-review-live' LIMIT 1").first();
    assert.equal(JSON.parse(row.request_context).asn, 28126);
  });
});
