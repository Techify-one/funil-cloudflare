// Navegador real (Chromium via Playwright) abrindo /exemplo servido pelo Worker
// no Miniflare: confere o link do checkout montado pelo lp-tracking.js, a CAPI
// do InitiateCheckout com offer_code e o envio dos eventos por seção.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { BROWSER_UA, rows, startSite, waitFor } from '../integration/site-harness.mjs';

function jsonBody(request) {
  try { return JSON.parse(request.postData() || 'null'); } catch { return null; }
}

test('CTA da página leva ao checkout com atribuição e dispara CAPI e eventos de seção', async (t) => {
  const { mf, db, baseUrl } = await startSite({ http: true });
  t.after(() => mf.dispose());
  const origin = new URL(baseUrl).origin;

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  // UA de celular comum: o filtro de bots descarta o UA padrão do Chromium headless.
  const context = await browser.newContext({ userAgent: BROWSER_UA, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  const metaEvents = [];
  const sectionBatches = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname === '/api/meta-event') metaEvents.push(jsonBody(request));
    if (pathname === '/api/section-event') sectionBatches.push(jsonBody(request));
  });

  // Nada sai para a internet; o checkout (outro módulo) é substituído por uma página simples.
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/checkout/')) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>checkout</title><h1>checkout</h1>' });
    }
    return route.continue();
  });

  const incoming = 'utm_source=x&utm_medium=paid&utm_campaign=CP01&utm_content=ad1&fbclid=abc123';
  const response = await page.goto(`${origin}/exemplo?${incoming}`, { waitUntil: 'load' });
  assert.equal(response.status(), 200);
  assert.equal(await page.evaluate(() => window.__LP && window.__LP.offer), 'produto-exemplo');

  // PageView + ViewContent saem para a CAPI assim que o script carrega.
  await waitFor(() => metaEvents.some((e) => e && e.event_name === 'ViewContent'));
  const viewContent = metaEvents.find((e) => e && e.event_name === 'ViewContent');
  assert.equal(viewContent.offer_code, 'produto-exemplo');
  assert.equal(viewContent.source, 'exemplo');
  assert.deepEqual(viewContent.custom_data, { content_name: 'Produto Exemplo', content_type: 'product', value: 97, currency: 'BRL' });

  // Rola a página aos poucos até o fim (seções + marcos de scroll) e volta ao
  // topo; o lote de eventos sai em até 4 s.
  const sectionFlush = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/section-event', { timeout: 10000 });
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y <= height; y += 300) {
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(40);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await sectionFlush;

  const navigation = page.waitForURL('**/checkout/**', { timeout: 8000 });
  await page.locator('a[data-cta="hero"]').click();
  await navigation;

  const target = new URL(page.url());
  assert.equal(target.pathname, '/checkout/produto-exemplo');
  assert.deepEqual(Object.fromEntries(target.searchParams), {
    utm_source: 'x', utm_medium: 'paid', utm_campaign: 'CP01', utm_content: 'ad1', fbclid: 'abc123',
    funnel: 'exemplo', utm_page: '/exemplo-v1', utm_content_cta: 'hero',
  });
  assert.equal(
    target.search,
    `?${incoming}&funnel=exemplo&utm_page=%2Fexemplo-v1&utm_content_cta=hero`,
    'parâmetros de entrada preservados na ordem original',
  );

  await waitFor(() => metaEvents.some((e) => e && e.event_name === 'InitiateCheckout'));
  const ic = metaEvents.find((e) => e && e.event_name === 'InitiateCheckout');
  assert.equal(ic.offer_code, 'produto-exemplo');
  assert.equal(ic.custom_data.content_category, 'hero');
  assert.equal(ic.custom_data.value, 97);
  assert.match(ic.event_id, /^initiatecheckout-\d+-[0-9a-z]+$/);
  assert.ok(!('pixel_id' in ic) && !('access_token' in ic));

  await waitFor(() => sectionBatches.some((b) => b && b.events.some((e) => e.type === 'cta_click')));
  const all = sectionBatches.filter(Boolean);
  for (const batch of all) {
    assert.equal(batch.page, 'exemplo-v1');
    assert.equal(batch.funnel, 'exemplo');
    assert.equal(batch.utm.utm_campaign, 'CP01');
    assert.match(batch.session_uuid, /^[0-9a-f-]{36}$/);
  }
  const events = all.flatMap((b) => b.events);
  const seen = new Set(events.filter((e) => e.type === 'section_view').map((e) => e.section));
  for (const section of ['hero', 'problema', 'oferta', 'rodape']) assert.ok(seen.has(section), `section_view ${section}`);
  assert.ok(events.some((e) => e.type === 'max_scroll' && e.value === 100));
  const click = events.find((e) => e.type === 'cta_click');
  assert.equal(click.cta, 'hero');
  assert.ok(click.last_visible_section);

  // O Worker gravou tudo no D1.
  const stored = await waitFor(() => rows(db, "SELECT * FROM section_events WHERE event_type = 'cta_click'").then((r) => r[0]));
  assert.equal(stored.page, 'exemplo-v1');
  assert.equal(stored.cta, 'hero');
  assert.equal(stored.device, 'mobile');
  const views = await rows(db, "SELECT funnel, utm_page, utm_campaign FROM page_views WHERE page = 'exemplo'");
  assert.deepEqual(views.map((v) => ({ ...v })), [{ funnel: 'exemplo', utm_page: '/exemplo-v1', utm_campaign: 'CP01' }]);
});
