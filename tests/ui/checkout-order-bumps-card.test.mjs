import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const offer = {
  id: 100, code: 'order-bump-card-test', name: 'Oferta cartão', description: '',
  anchor_price_cents: 0, sale_price_cents: 3700, out_of_stock: false,
  thanks_url: '/obrigado', meta_pixel_id: '123456789',
  order_bumps: [
    { id: 21, name: 'Bump cartão', description: 'Complemento', price_cents: 900, is_active: 1, position: 0 },
  ],
};

test('uses bump-inclusive total for card installments and card request', async (t) => {
  let cardBody = null;
  const template = await readFile(new URL('../../public/checkout.html', import.meta.url), 'utf8');
  const html = template.replaceAll('__OFFER_JSON__', JSON.stringify(offer))
    .replaceAll('__META_PIXEL_ID__', offer.meta_pixel_id).replaceAll('__MP_PK_VAL__', 'TEST-PUBLIC-KEY')
    .replaceAll('__BRAND_NAME__', 'Loja Teste').replaceAll('__GUARANTEE_DAYS__', '7');

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    res.setHeader('content-type', req.url === '/' ? 'text/html; charset=utf-8' : 'application/json');
    if (req.method === 'GET' && req.url === '/') return res.end(html);
    if (req.url === '/api/mp/create-card') {
      cardBody = JSON.parse(raw);
      return res.end(JSON.stringify({ ok: true, payment_id: 'card-test', status: 'pending', lead_id: 8, amount_cents: 4600 }));
    }
    if (req.url?.startsWith('/api/mp/status')) return res.end(JSON.stringify({ ok: true, status: 'pending', amount_cents: 4600 }));
    return res.end(JSON.stringify({ ok: true, id: 8 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => server.close());

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    class FakeField {
      mount() { return this; }
      on(name, callback) { if (name === 'binChange') setTimeout(() => callback({ bin: '411111' }), 20); }
    }
    window.MercadoPago = class {
      constructor() {
        this.fields = {
          create: () => new FakeField(),
          createCardToken: async () => ({ id: 'test-card-token' }),
        };
      }
      async getPaymentMethods() { return { results: [{ id: 'visa', name: 'Visa', issuer: { id: '25' } }] }; }
      async getInstallments({ amount }) {
        return [{ payer_costs: [{ installments: 1, installment_amount: Number(amount), total_amount: Number(amount), installment_rate: 0 }] }];
      }
    };
  });
  await page.route(/^https?:\/\//, async (route) => {
    if (route.request().url().startsWith(`http://127.0.0.1:${port}`)) return route.continue();
    return route.abort();
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('.order-bump-checkbox').check();
  await page.fill('#name', 'Cliente Teste');
  await page.fill('#email', 'cliente@example.com');
  await page.fill('#phone', '11999999999');
  await page.click('#tab-card');
  await page.fill('#cardholderName', 'Cliente Teste');
  await page.fill('#cardholderDoc', '52998224725');
  await page.waitForFunction(() => document.querySelector('#installments')?.textContent.includes('46,00'));
  assert.match(await page.locator('#installments').textContent(), /46,00/);
  await page.click('#btn-pay-card');
  await page.waitForResponse((r) => r.url().endsWith('/api/mp/create-card'));

  assert.deepEqual(cardBody.order_bump_ids, [21]);
  assert.equal(cardBody.expected_total_cents, 4600);
  assert.equal(cardBody.installments, 1);
  assert.equal(cardBody.payment_method_id, 'visa');
  assert.equal(await page.locator('.order-bump-checkbox').isDisabled(), true);
});
