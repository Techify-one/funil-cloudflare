import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const offer = {
  id: 99,
  code: 'order-bump-test',
  name: 'Oferta de teste',
  description: 'Checkout automatizado',
  anchor_price_cents: 9700,
  sale_price_cents: 3700,
  out_of_stock: false,
  thanks_url: '/obrigado',
  meta_pixel_id: '123456789',
  order_bumps: [
    { id: 11, name: 'Bump A', description: 'Complemento A', price_cents: 900, is_active: 1, position: 0 },
    { id: 12, name: 'Bump B', description: 'Complemento B', price_cents: 1200, is_active: 1, position: 1 },
    { id: 13, name: 'Bump C', description: 'Complemento C', price_cents: 500, is_active: 1, position: 2 },
  ],
};

test('renders three order bumps, updates total, and sends selected ids in PIX request', async (t) => {
  let pixBody = null;
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
    const body = Buffer.concat(chunks).toString('utf8');
    res.setHeader('content-type', req.url === '/' ? 'text/html; charset=utf-8' : 'application/json');
    if (req.method === 'GET' && req.url === '/') return res.end(html);
    if (req.url === '/api/mp/create-pix') {
      pixBody = JSON.parse(body);
      return res.end(JSON.stringify({ ok: true, payment_id: 'test-pix', lead_id: 7, qr_code: 'PIX-CODE', qr_code_base64: '', amount_cents: 5800 }));
    }
    if (req.url?.startsWith('/api/mp/status')) return res.end(JSON.stringify({ ok: true, status: 'pending', amount_cents: 5800 }));
    return res.end(JSON.stringify({ ok: true, id: 7 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route(/^https?:\/\//, async (route) => {
    if (route.request().url().startsWith(`http://127.0.0.1:${server.address().port}`)) return route.continue();
    return route.abort();
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });

  assert.equal(await page.locator('.order-bump-checkbox').count(), 3);
  assert.equal(await page.locator('#checkout-total-value').textContent(), 'R$ 37,00');
  await page.locator('.order-bump-checkbox').nth(0).check();
  await page.locator('.order-bump-checkbox').nth(1).check();
  assert.equal(await page.locator('#checkout-total-value').textContent(), 'R$ 58,00');
  assert.match(await page.locator('#selected-bumps-summary').textContent(), /Bump A/);
  assert.match(await page.locator('#selected-bumps-summary').textContent(), /Bump B/);

  await page.fill('#name', 'Cliente Teste');
  await page.fill('#email', 'cliente@example.com');
  await page.fill('#phone', '11999999999');
  await page.click('#tab-pix');
  await page.click('#btn-pay-pix');
  await page.waitForSelector('#qr-code-text');

  assert.deepEqual(pixBody.order_bump_ids, [11, 12]);
  assert.equal(pixBody.expected_total_cents, 5800);
  assert.equal(pixBody.offer_code, 'order-bump-test');
  assert.equal(await page.locator('.order-bump-checkbox').first().isDisabled(), true);
});
