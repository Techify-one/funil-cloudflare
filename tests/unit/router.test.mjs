// Tabela de rotas e isolamento de variáveis por módulo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModule } from '../../src/routes.mjs';

test('cada caminho vai para o módulo certo (vence a entrada mais longa)', () => {
  const cases = {
    '/leads': 'dashboard', '/vendas': 'dashboard', '/funil': 'dashboard', '/meta': 'dashboard',
    '/painel': 'dashboard', '/paginas': 'dashboard', '/ofertas': 'dashboard', '/secoes': 'dashboard',
    '/dashboard': 'dashboard', '/dashboard/api/offers': 'dashboard', '/checkout-analytics': 'dashboard',
    '/checkout': 'checkout', '/checkout/produto-exemplo': 'checkout',
    '/api/checkout': 'checkout', '/api/checkout-event': 'checkout', '/api/checkout-analytics': 'checkout',
    '/api/mp/create-pix': 'checkout', '/api/mp/webhook': 'checkout',
    '/api/checkout-click': 'site', '/api/meta-event': 'site', '/api/section-event': 'site',
    '/api/popup-open': 'site', '/api/lead': 'site',
    '/': 'site', '/exemplo': 'site', '/obrigado': 'site', '/static/lp-tracking.js': 'site',
    '/internal/dashboard/refund': 'blocked', '/internal': 'blocked', '/internalx': 'blocked',
  };
  for (const [path, module] of Object.entries(cases)) {
    assert.equal(resolveModule(path), module, path);
  }
});

test('páginas cujo nome começa com uma rota do dashboard continuam livres', () => {
  for (const path of ['/metas', '/vendas-black', '/leadsx', '/ofertas-da-semana', '/funil-novo', '/checkoutx']) {
    assert.equal(resolveModule(path), 'site', path);
  }
});

test('cada módulo só enxerga as variáveis permitidas', async () => {
  const { envFor } = await import('../../src/env-scope.mjs');
  const env = {
    DB: 1, MP_ACCESS_TOKEN: 's', DASH_PASS: 's', META_ACCESS_TOKEN: 's', META_PIXEL_ACCESS_TOKEN: 's',
    CLOUDFLARE_EMAIL_API_TOKEN: 's', DEBUG_APPROVE_TOKEN: 's', NOVA_CHAVE_SECRETA: 's',
  };
  const dash = envFor('dashboard', env);
  assert.ok(!('MP_ACCESS_TOKEN' in dash) && !('CLOUDFLARE_EMAIL_API_TOKEN' in dash) && !('META_PIXEL_ACCESS_TOKEN' in dash) && !('DEBUG_APPROVE_TOKEN' in dash));
  const site = envFor('site', env);
  assert.ok(!('DASH_PASS' in site) && !('META_ACCESS_TOKEN' in site) && !('MP_ACCESS_TOKEN' in site));
  const co = envFor('checkout', env);
  assert.ok(!('DASH_PASS' in co) && !('META_ACCESS_TOKEN' in co));
  for (const m of ['checkout', 'dashboard', 'site']) assert.ok(!('NOVA_CHAVE_SECRETA' in envFor(m, env)), m);
});
