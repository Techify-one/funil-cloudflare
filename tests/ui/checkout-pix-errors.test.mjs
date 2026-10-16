import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const offer = {
  id: 101,
  code: 'pix-error-test',
  name: 'Oferta Pix',
  description: '',
  anchor_price_cents: 0,
  sale_price_cents: 1990,
  out_of_stock: false,
  thanks_url: '/obrigado',
  meta_pixel_id: '123456789',
  order_bumps: [],
};

test('explains an invalid Pix email in Portuguese without exposing gateway codes', async (t) => {
  let pixRequests = 0;
  const template = await readFile(new URL('../../public/checkout.html', import.meta.url), 'utf8');
  const html = template
    .replaceAll('__OFFER_JSON__', JSON.stringify(offer))
    .replaceAll('__META_PIXEL_ID__', offer.meta_pixel_id)
    .replaceAll('__MP_PK_VAL__', 'TEST-PUBLIC-KEY')
    .replaceAll('__BRAND_NAME__', 'Loja Teste')
    .replaceAll('__GUARANTEE_DAYS__', '7');

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('content-type', req.url === '/' ? 'text/html; charset=utf-8' : 'application/json');
    if (req.method === 'GET' && req.url === '/') return res.end(html);
    if (req.url === '/api/mp/create-pix') {
      pixRequests += 1;
      res.statusCode = 502;
      return res.end(JSON.stringify({
        ok: false,
        error: 'mp_create_failed',
        detail: 'payer.email must be a valid email',
      }));
    }
    return res.end(JSON.stringify({ ok: true, id: 7 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => server.close());

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route(/^https?:\/\//, async (route) => {
    if (route.request().url().startsWith('http://127.0.0.1:' + port)) return route.continue();
    return route.abort();
  });
  await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'domcontentloaded' });

  await page.fill('#name', 'Cliente Teste');
  await page.fill('#email', 'cliente@gmail.comm');
  await page.fill('#phone', '11999999999');
  await page.click('#tab-pix');
  await page.click('#btn-pay-pix');

  assert.equal(pixRequests, 0);
  assert.match(await page.locator('#err-email').textContent(), /use \.com, não \.comm/i);

  // Também garante que uma eventual rejeição equivalente do gateway seja traduzida.
  await page.fill('#email', 'cliente@example.com');
  await page.click('#btn-pay-pix');
  await page.waitForSelector('#modal-error', { state: 'visible' });

  assert.equal(pixRequests, 1);
  assert.equal(await page.locator('#modal-error-title').textContent(), 'Não foi possível gerar o PIX');
  const message = await page.locator('#modal-error-body').textContent();
  assert.match(message, /Confira o e-mail informado/i);
  assert.match(message, /\.com.*\.comm/is);
  assert.doesNotMatch(message, /mp_create_failed|payer\.email|valid email/i);
});
