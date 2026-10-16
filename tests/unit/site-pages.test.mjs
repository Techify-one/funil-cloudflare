// Lógica pura do módulo site/: sorteio de variante, montagem do window.__LP e
// escolha do pixel/token da CAPI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHeadInject, buildPageConfig, findPage, pickVariant } from '../../site/src/pages.mjs';
import { resolveCapiTarget } from '../../site/src/api.mjs';
import { PAGES } from '../../site/pages.config.mjs';

const AB = { funnel: 'ab', offer: 'oferta-ab', variants: { 1: '/pages/ab/v1.html', 2: '/pages/ab/v2.html' }, split: [1, 2] };

function req(cookie = '') {
  return new Request('https://site.example.com/ab', { headers: cookie ? { cookie } : {} });
}

function fakeDb(offers) {
  return {
    prepare() {
      return {
        bind(code) {
          return { first: async () => offers[code] || null };
        },
      };
    },
  };
}

test('página exemplo registrada com o contrato esperado', () => {
  assert.deepEqual(PAGES.exemplo, {
    funnel: 'exemplo', offer: 'produto-exemplo', variants: { 1: '/pages/exemplo/v1.html' }, split: [1],
  });
  assert.equal(findPage('constructor'), null);
  assert.equal(findPage('nao-existe'), null);
});

test('pickVariant: ?v força, cookie fixa, sorteio respeita o split', () => {
  const url = (q) => new URL('https://site.example.com/ab' + q);
  assert.equal(pickVariant(url('?v=2'), req('lp_ab_v=1'), 'ab', AB), 2);
  assert.equal(pickVariant(url('?v=3'), req('lp_ab_v=1'), 'ab', AB), 1, 'variante inexistente em ?v é ignorada');
  assert.equal(pickVariant(url(''), req('lp_ab_v=2'), 'ab', AB), 2);
  const onlyTwo = { ...AB, split: [2] };
  assert.equal(pickVariant(url(''), req('lp_ab_v=1'), 'ab', onlyTwo), 2, 'cookie fora do split é ressorteado');
  assert.equal(pickVariant(url('?v=1'), req(), 'ab', onlyTwo), 1, 'preview alcança variante fora do split');
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(pickVariant(url(''), req(), 'ab', AB));
  assert.deepEqual([...seen].sort(), [1, 2]);
});

test('buildPageConfig: pixel da página > da oferta > ambiente; conteúdo e valor da oferta', async () => {
  const env = { META_PIXEL_ID: '999', DB: fakeDb({ 'oferta-ab': { name: 'Oferta AB', sale_price_cents: 4990, meta_pixel_id: '111' } }) };
  assert.deepEqual(await buildPageConfig(env, 'ab', AB, 2), {
    pixelId: '111', page: 'ab', funnel: 'ab', utmPage: '/ab-v2', offer: 'oferta-ab',
    source: 'ab', content: 'Oferta AB', value: 49.9, currency: 'BRL',
  });
  const custom = await buildPageConfig(env, 'ab', { ...AB, pixelId: '222', content: 'X', value: 10, source: 'fonte' }, 1);
  assert.equal(custom.pixelId, '222');
  assert.equal(custom.content, 'X');
  assert.equal(custom.value, 10);
  assert.equal(custom.source, 'fonte');
  const noDb = await buildPageConfig({ META_PIXEL_ID: '999' }, 'ab', AB, 1);
  assert.equal(noDb.pixelId, '999');
  assert.equal(noDb.value, 0);
});

test('buildHeadInject escapa < no JSON e omite o Pixel sem id', () => {
  const html = buildHeadInject('123', { content: '</script><b>' });
  assert.ok(html.includes("fbq('init','123')"));
  assert.ok(html.includes('\\u003c/script>'));
  assert.ok(!html.includes('</script><b>'));
  const noPixel = buildHeadInject('', { page: 'x' });
  assert.ok(!noPixel.includes('fbq('));
  assert.ok(noPixel.includes('window.__LP={"page":"x"}'));
});

test('resolveCapiTarget nunca usa pixel/token do cliente', async () => {
  const env = { DB: fakeDb({ 'com-pixel': { meta_pixel_id: '111', meta_capi_token: 'tok' }, 'sem-pixel': { meta_pixel_id: null } }) };
  const pages = { ab: { ...AB, pixelId: '222' }, outra: { offer: 'com-pixel', variants: { 1: '/x' } } };
  assert.deepEqual(await resolveCapiTarget(env, { offer_code: 'com-pixel', pixel_id: '666', access_token: 'x' }, pages), { pixel_id: '111', access_token: 'tok' });
  assert.deepEqual(await resolveCapiTarget(env, { offer_code: 'sem-pixel' }, pages), { pixel_id: null, access_token: null });
  assert.deepEqual(await resolveCapiTarget(env, { offer_code: 'com-pixel', source: 'ab' }, pages), { pixel_id: '222', access_token: null });
  assert.deepEqual(await resolveCapiTarget(env, { offer_code: 'DROP TABLE;' }, pages), { pixel_id: null, access_token: null });
});
