import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { getPageViewSession, withPageViewSessionCookie } from '../../shared/utils.js';

const checkoutPagePath = new URL('../../public/checkout.html', import.meta.url);

test('page-view session is created once and reused from the first-party cookie', () => {
  const first = getPageViewSession(new Request('https://loja.example.com/pagina'));
  assert.match(first.uuid, /^[0-9a-f-]{36}$/i);
  assert.equal(first.isNew, true);

  const response = withPageViewSessionCookie(new Response('ok'), first);
  const setCookie = response.headers.get('set-cookie') || '';
  assert.match(setCookie, new RegExp(`tx_session_uuid=${first.uuid}`));
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /SameSite=Lax/);

  const second = getPageViewSession(new Request('https://loja.example.com/checkout/produto-teste', {
    headers: { cookie: `tx_session_uuid=${first.uuid}` },
  }));
  assert.deepEqual(second, { uuid: first.uuid, isNew: false });
});

test('thank-you URL preserves funnel, UTMs and Meta attribution identifiers', async () => {
  const html = await readFile(checkoutPagePath, 'utf8');
  assert.match(html, /target\.searchParams\.set\('funnel', FUNNEL\)/);
  assert.match(html, /for \(const key of UTM_KEYS\)/);
  assert.match(html, /for \(const key of META_KEYS\)/);
  assert.match(html, /target\.searchParams\.set\('pid', paymentId \|\| ''\)/);
});

test('checkout page view takes the funnel only from ?funnel=, never from the referer', async () => {
  const { default: worker } = await import('../../checkout/src/index.js');
  const { createCheckoutDb, assetsBinding, makeCtx, insertOffer } = await import('./checkout-harness.mjs');
  const { db, dispose } = await createCheckoutDb();
  try {
    await insertOffer(db, { code: 'produto-teste' });
    const env = { DB: db, ASSETS: assetsBinding() };
    const browserUa = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

    const ctx1 = makeCtx();
    const withReferer = await worker.fetch(new Request('https://loja.example.com/checkout/produto-teste', {
      headers: { 'user-agent': browserUa, referer: 'https://loja.example.com/obrigado' },
    }), env, ctx1);
    assert.equal(withReferer.status, 200);
    await ctx1.drain();

    const ctx2 = makeCtx();
    await worker.fetch(new Request('https://loja.example.com/checkout/produto-teste?funnel=Meu-Funil&utm_page=/lp', {
      headers: { 'user-agent': browserUa },
    }), env, ctx2);
    await ctx2.drain();

    const rows = (await db.prepare('SELECT page, funnel, utm_page FROM page_views ORDER BY id').all()).results;
    assert.deepEqual(rows, [
      { page: 'checkout', funnel: null, utm_page: '/checkout/produto-teste' },
      { page: 'checkout', funnel: 'meu-funil', utm_page: '/lp' },
    ]);
  } finally {
    await dispose();
  }
});
