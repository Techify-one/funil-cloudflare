import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workerUrl = new URL('../../dashboard/src/worker.js', import.meta.url);
const pageUrl = new URL('../../dashboard/src/vendas.html', import.meta.url);
const routerUrl = new URL('../../src/index.js', import.meta.url);
const routesUrl = new URL('../../src/routes.mjs', import.meta.url);
const checkoutWorkerUrl = new URL('../../checkout/src/index.js', import.meta.url);
const schemaUrl = new URL('../../migrations/0001_init.sql', import.meta.url);

test('sales menu exposes a confirmed full-refund action', async () => {
  const page = await readFile(pageUrl, 'utf8');

  assert.match(page, /id="row-menu-refund"/);
  assert.match(page, /Reembolsar no Mercado Pago/);
  assert.match(page, /Confirma o reembolso integral/);
  assert.match(page, /Esta ação não pode ser desfeita/);
  assert.match(page, /\/dashboard\/api\/sales\/\$\{encodeURIComponent\(lead\.id\)\}\/refund/);
  assert.match(page, /operation_id: crypto\.randomUUID\(\)/);
});

test('dashboard delegates refunds to the checkout module through CHECKOUT_SERVICE', async () => {
  const [worker, router, routes, checkoutWorker] = await Promise.all([
    readFile(workerUrl, 'utf8'),
    readFile(routerUrl, 'utf8'),
    readFile(routesUrl, 'utf8'),
    readFile(checkoutWorkerUrl, 'utf8'),
  ]);

  assert.match(worker, /salesRefundMatch/);
  assert.match(worker, /handleSaleRefund/);
  assert.match(worker, /env\.CHECKOUT_SERVICE\.fetch/);
  assert.match(worker, /\/internal\/dashboard\/refund/);
  // O roteador injeta o CHECKOUT_SERVICE e bloqueia /internal para o público.
  assert.match(router, /scoped\.CHECKOUT_SERVICE = \{/);
  assert.match(routes, /prefix: '\/internal', module: 'blocked'/);
  assert.match(checkoutWorker, /path === '\/internal\/dashboard\/refund'/);
  assert.match(checkoutWorker, /createMpFullRefund/);
  assert.match(checkoutWorker, /status: 'refunded'/);
});

test('refund ledger allows only one active record per payment', async () => {
  const sql = await readFile(schemaUrl, 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS payment_refunds/);
  assert.match(sql, /payment_id\s+INTEGER NOT NULL UNIQUE/);
  assert.match(sql, /operation_id\s+TEXT\s+NOT NULL/);
  assert.match(sql, /attempt_count/);
});

test('confirmation e-mail resend is delegated to the checkout module like refunds', async () => {
  const [worker, page, checkoutWorker] = await Promise.all([
    readFile(workerUrl, 'utf8'),
    readFile(pageUrl, 'utf8'),
    readFile(checkoutWorkerUrl, 'utf8'),
  ]);

  // Painel: item do menu da linha e botão do modal de disparos.
  assert.equal(page.match(/Reenviar e-mail de confirmação/g).length, 2);
  assert.match(page, /\/dashboard\/api\/sales\/\$\{encodeURIComponent\(lead\.id\)\}\/resend-email/);
  assert.match(page, /email: "E-mail", capi: "Meta CAPI \(Purchase\)"/);
  assert.match(page, /E-mail de confirmação da oferta/);
  assert.match(page, /\(desabilitado na oferta\)/);

  // Worker: rota nova, encaminhada ao checkout com o mesmo formato do reembolso.
  assert.match(worker, /\\\/resend-email\$\//);
  assert.match(worker, /async function handleResendEmail\(request, env, idStr\)/);
  assert.match(worker, /new URL\("\/internal\/dashboard\/resend-email", request\.url\)/);
  assert.match(worker, /body: JSON\.stringify\(\{ lead_id: leadId \}\)/);
  assert.match(worker, /email_enabled: Number\(t\.offer\.email_enabled\) === 1/);
  assert.match(worker, /email_subject:/);
  assert.match(checkoutWorker, /path === '\/internal\/dashboard\/resend-email'/);
});
