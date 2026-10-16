// Tabela de rotas do Worker único. Cada entrada aponta um caminho para um
// módulo. Vence a entrada mais longa (ex.: /checkout-analytics é do dashboard
// mesmo começando com /checkout).
//
// Por padrão uma entrada casa o caminho exato e seus subcaminhos
// ('/vendas' casa '/vendas' e '/vendas/...', mas não '/vendas-black', que
// continua livre para uma página). `loose: true` casa qualquer sufixo colado,
// como os padrões '/api/checkout*' das rotas originais.

export const ROUTES = [
  // Dashboard (Basic Auth)
  { prefix: '/dashboard', module: 'dashboard' },
  { prefix: '/leads', module: 'dashboard' },
  { prefix: '/vendas', module: 'dashboard' },
  { prefix: '/funil', module: 'dashboard' },
  { prefix: '/meta', module: 'dashboard' },
  { prefix: '/painel', module: 'dashboard' },
  { prefix: '/paginas', module: 'dashboard' },
  { prefix: '/ofertas', module: 'dashboard' },
  { prefix: '/secoes', module: 'dashboard' },
  { prefix: '/checkout-analytics', module: 'dashboard' },

  // Checkout (Mercado Pago, CAPI do checkout, analytics do checkout)
  { prefix: '/checkout', module: 'checkout' },
  { prefix: '/api/checkout', module: 'checkout', loose: true }, // /api/checkout, -event, -analytics
  { prefix: '/api/mp', module: 'checkout' },

  // Site: APIs de rastreamento das páginas
  { prefix: '/api/meta-event', module: 'site' },
  { prefix: '/api/section-event', module: 'site' },
  { prefix: '/api/checkout-click', module: 'site' },
  { prefix: '/api/popup-open', module: 'site' },
  { prefix: '/api/lead', module: 'site' },

  // Endpoints internos nunca são públicos.
  { prefix: '/internal', module: 'blocked', loose: true },
];

const SORTED = [...ROUTES].sort((a, b) => b.prefix.length - a.prefix.length);

function matches(route, pathname) {
  if (route.loose) return pathname.startsWith(route.prefix);
  return pathname === route.prefix || pathname.startsWith(route.prefix + '/');
}

// Tudo que não casa nenhuma entrada é do site (páginas, /obrigado, assets).
export function resolveModule(pathname) {
  for (const route of SORTED) {
    if (matches(route, pathname)) return route.module;
  }
  return 'site';
}
