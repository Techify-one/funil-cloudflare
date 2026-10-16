import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseOffer = {
  id: 102, code: 'guarantee-test', name: 'Produto Garantia', description: '',
  anchor_price_cents: 0, sale_price_cents: 4900, out_of_stock: false,
  thanks_url: '/obrigado', meta_pixel_id: '123456789', order_bumps: [],
};

async function serveCheckout(t, { offer = baseOffer, guaranteeDays = '7', onCheckout } = {}) {
  const template = await readFile(new URL('../../public/checkout.html', import.meta.url), 'utf8');
  const html = template
    .replaceAll('__OFFER_JSON__', JSON.stringify(offer))
    .replaceAll('__META_PIXEL_ID__', offer.meta_pixel_id)
    .replaceAll('__MP_PK_VAL__', 'TEST-PUBLIC-KEY')
    .replaceAll('__BRAND_NAME__', 'Loja Teste')
    .replaceAll('__GUARANTEE_DAYS__', guaranteeDays);
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('content-type', req.url === '/' ? 'text/html; charset=utf-8' : 'application/json');
    if (req.method === 'GET' && req.url === '/') return res.end(html);
    if (req.url === '/api/checkout' && onCheckout) onCheckout(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    return res.end(JSON.stringify({ ok: true, id: 9 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route(/^https?:\/\//, async (route) => {
    if (route.request().url().startsWith('http://127.0.0.1:' + port)) return route.continue();
    return route.abort();
  });
  await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'domcontentloaded' });
  return page;
}

test('shows the configured guarantee period and the brand in the title', async (t) => {
  const page = await serveCheckout(t, { guaranteeDays: '15' });
  assert.equal(await page.title(), 'Checkout | Loja Teste');
  assert.equal(await page.locator('#guarantee-box b').textContent(), 'Garantia de 15 dias');
});

test('hides the guarantee block when GUARANTEE_DAYS is 0', async (t) => {
  const page = await serveCheckout(t, { guaranteeDays: '0' });
  await page.waitForSelector('#checkout-total-value');
  assert.equal(await page.locator('#guarantee-box').count(), 0);
  assert.equal(await page.locator('.guarantee-box').count(), 0);
});

test('out-of-stock offer records the intent and shows the neutral suspension message', async (t) => {
  const bodies = [];
  const page = await serveCheckout(t, {
    offer: { ...baseOffer, out_of_stock: true },
    onCheckout: (body) => bodies.push(body),
  });
  await page.fill('#name', 'Cliente Teste');
  await page.fill('#email', 'cliente@example.com');
  await page.fill('#phone', '11999999999');
  await page.click('#tab-pix');
  await page.click('#btn-pay-pix');
  await page.waitForSelector('#modal-error', { state: 'visible', timeout: 10000 });

  assert.equal(await page.locator('#modal-error-title').textContent(), 'PIX indisponível no momento.');
  assert.match(await page.locator('#modal-error-body').textContent(), /As vendas deste produto estão temporariamente suspensas\./);
  const purchase = bodies.find((b) => b.status === 'comprou');
  assert.ok(purchase, 'must record the simulated purchase intent');
  assert.equal(purchase.method, 'pix');
  assert.equal(purchase.offer_code, 'guarantee-test');
  assert.deepEqual(Object.keys(purchase).filter((k) => k.endsWith('_token')), []);
});
