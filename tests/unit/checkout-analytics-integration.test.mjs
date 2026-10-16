import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const checkoutHtml = new URL('../../public/checkout.html', import.meta.url);
const workerSource = new URL('../../checkout/src/index.js', import.meta.url);
const migration = new URL('../../migrations/0001_init.sql', import.meta.url);

test('checkout worker persists first-party session analytics through a dedicated endpoint', async () => {
  const [worker, sql] = await Promise.all([
    readFile(workerSource, 'utf8'),
    readFile(migration, 'utf8'),
  ]);

  assert.match(sql, /CREATE TABLE IF NOT EXISTS checkout_sessions/);
  assert.match(sql, /visit_uuid\s+TEXT\s+NOT NULL UNIQUE/);
  assert.match(sql, /visible_ms/);
  assert.match(sql, /last_event/);
  assert.match(worker, /normalizeCheckoutAnalyticsEvent/);
  assert.match(worker, /handleCheckoutAnalytics/);
  assert.match(worker, /path === '\/api\/checkout-analytics'/);
  assert.match(worker, /ON CONFLICT\(visit_uuid\) DO UPDATE/);
  assert.match(worker, /getPageViewSession\(request\)/);
});

test('checkout emits lifecycle and friction signals without blocking navigation', async () => {
  const html = await readFile(checkoutHtml, 'utf8');

  assert.match(html, /\/api\/checkout-analytics/);
  assert.match(html, /document\.addEventListener\('visibilitychange'/);
  assert.match(html, /window\.addEventListener\('pagehide'/);
  assert.match(html, /window\.addEventListener\('pageshow'/);
  assert.match(html, /navigator\.sendBeacon/);
  assert.match(html, /sendAnalytics\('heartbeat'/);
  assert.match(html, /sendAnalytics\('validation_error'/);
  assert.match(html, /sendAnalytics\('payment_attempt'/);
  assert.match(html, /sendAnalytics\('method_selected'/);
  assert.match(html, /sendAnalytics\('bump_changed'/);
});

test('checkout analytics upserts one row per visit against the real schema', async () => {
  const { default: worker } = await import('../../checkout/src/index.js');
  const { createCheckoutDb, jsonRequest } = await import('./checkout-harness.mjs');
  const { db, dispose } = await createCheckoutDb();
  try {
    const visit = '2a9d1387-5f50-4d92-bcc2-44210f93e35d';
    const env = { DB: db };
    const send = (event, extra = {}) => worker.fetch(jsonRequest('/api/checkout-analytics', {
      visit_uuid: visit, event, offer_code: 'produto-teste', funnel: 'meu-funil', ...extra,
    }), env, {});
    assert.equal((await send('opened')).status, 200);
    await send('validation_error', { last_stage: 'email', visible_ms: 4000 });
    await send('payment_attempt', { last_stage: 'payment_attempt', method: 'pix', visible_ms: 9000 });
    const rows = (await db.prepare('SELECT * FROM checkout_sessions').all()).results;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].validation_errors, 1);
    assert.equal(rows[0].payment_attempts, 1);
    assert.equal(rows[0].visible_ms, 9000);
    assert.equal(rows[0].method, 'pix');
    assert.equal(rows[0].funnel, 'meu-funil');
    assert.equal(rows[0].last_event, 'payment_attempt');
  } finally {
    await dispose();
  }
});
