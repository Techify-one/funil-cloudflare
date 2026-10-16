import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workerUrl = new URL('../../dashboard/src/worker.js', import.meta.url);
const pageUrl = new URL('../../dashboard/src/checkout-analytics.html', import.meta.url);

test('dashboard exposes a checkout abandonment report and API', async () => {
  const [worker, page] = await Promise.all([
    readFile(workerUrl, 'utf8'),
    readFile(pageUrl, 'utf8'),
  ]);

  assert.match(worker, /CHECKOUT_ANALYTICS_HTML/);
  assert.match(worker, /path === "\/checkout-analytics"/);
  assert.match(worker, /path === "\/dashboard\/api\/checkout-analytics"/);
  assert.match(worker, /async function handleCheckoutAnalyticsReport/);
  assert.match(worker, /checkout_sessions/);
  assert.match(worker, /returned_to_site/);
  assert.match(worker, /abandoned_background/);
  assert.match(worker, /unknown_exit/);
  assert.match(page, /Por que abandonaram o checkout/);
  assert.match(page, /dashboard\/api\/checkout-analytics/);
  assert.match(page, /Etapa onde pararam/);
  assert.match(page, /Saída sem destino conhecido/);
  assert.match(page, /Voltou para outra página do site/);
});

test('the report is chosen per offer instead of a hardcoded one', async () => {
  const [worker, page] = await Promise.all([
    readFile(workerUrl, 'utf8'),
    readFile(pageUrl, 'utf8'),
  ]);

  // A página lista as ofertas e grava a escolha em ?offer= na URL.
  assert.match(page, /<select id="offer"/);
  assert.match(page, /fetch\('\/dashboard\/api\/offers'/);
  assert.match(page, /searchParams\.set\('offer',offerEl\.value\)/);
  assert.match(page, /searchParams\.get\('offer'\)/);
  assert.doesNotMatch(page, /&offer=[a-z]/, 'nenhum código de oferta fixo no front');

  // Sem ?offer=, o worker usa a oferta ativa criada mais recentemente; sem
  // nenhuma oferta, devolve um relatório vazio em vez de erro.
  assert.match(worker, /FROM offers WHERE is_active = 1 ORDER BY created_at DESC, id DESC LIMIT 1/);
  assert.match(worker, /offer: null,\s*generated_at/);
});
