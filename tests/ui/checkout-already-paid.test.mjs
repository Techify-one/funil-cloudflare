// O servidor responde already_paid sem payment_id/lead_id (chamada não
// autenticada). O checkout precisa continuar levando o comprador ao /obrigado
// com funil, UTMs e IDs de atribuição da Meta, sem gerar Pix.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const offer = {
  id: 77,
  code: 'ja-comprou',
  name: 'Oferta já comprada',
  description: '',
  anchor_price_cents: 0,
  sale_price_cents: 3700,
  out_of_stock: false,
  thanks_url: '/obrigado',
  meta_pixel_id: '123456789',
  order_bumps: [],
};

test('already_paid without ids still redirects to the thanks page with attribution', async (t) => {
  let pixRequests = 0;
  const template = await readFile(new URL('../../public/checkout.html', import.meta.url), 'utf8');
  const html = template
    .replaceAll('__OFFER_JSON__', () => JSON.stringify(offer))
    .replaceAll('__META_PIXEL_ID__', () => offer.meta_pixel_id)
    .replaceAll('__MP_PK_VAL__', () => 'TEST-PUBLIC-KEY')
    .replaceAll('__BRAND_NAME__', () => 'Loja Teste')
    .replaceAll('__GUARANTEE_DAYS__', () => '7');

  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drena o corpo */ }
    const path = (req.url || '').split('?')[0];
    if (req.method === 'GET' && path === '/checkout') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(html);
    }
    if (req.method === 'GET' && path === '/obrigado') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end('<!doctype html><title>Obrigado</title><h1 id="thanks">Obrigado</h1>');
    }
    res.setHeader('content-type', 'application/json');
    if (path === '/api/mp/create-pix') {
      pixRequests += 1;
      return res.end(JSON.stringify({ ok: true, already_paid: true }));
    }
    return res.end(JSON.stringify({ ok: true, id: 5 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route(/^https?:\/\//, async (route) => {
    if (route.request().url().startsWith(origin)) return route.continue();
    return route.abort();
  });

  await page.goto(`${origin}/checkout?funnel=meu-funil&utm_source=fb&utm_campaign=CP01&fbclid=abc123`, { waitUntil: 'domcontentloaded' });
  await page.fill('#name', 'Cliente Teste');
  await page.fill('#email', 'cliente@example.com');
  await page.fill('#phone', '11999999999');
  await page.click('#tab-pix');
  await page.click('#btn-pay-pix');
  await page.waitForURL(/\/obrigado\?/, { timeout: 15000 });

  const url = new URL(page.url());
  assert.equal(url.pathname, '/obrigado');
  assert.equal(url.searchParams.get('pid'), '');
  assert.equal(url.searchParams.get('funnel'), 'meu-funil');
  assert.equal(url.searchParams.get('utm_source'), 'fb');
  assert.equal(url.searchParams.get('utm_campaign'), 'CP01');
  assert.equal(url.searchParams.get('fbclid'), 'abc123');
  assert.equal(pixRequests, 1);
  assert.equal(await page.locator('#thanks').textContent(), 'Obrigado');
});
