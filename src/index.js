// Ponto de entrada do Worker. Só roteia: cada módulo (checkout, dashboard,
// site) continua com o próprio `export default { fetch }`, como se fosse um
// Worker separado, e recebe apenas as variáveis de ambiente de que precisa.

import checkout from '../checkout/src/index.js';
import dashboard from '../dashboard/src/worker.js';
import site from '../site/src/index.js';
import { resolveModule } from './routes.mjs';
import { envFor } from './env-scope.mjs';

const INTERNAL_HEADER = 'x-internal-call';

// Chave aleatória por instância do Worker: só o atalho interno do dashboard a
// conhece, e o checkout recusa /internal/* sem ela. Gerada na primeira
// requisição porque o Workers não permite valores aleatórios no escopo global.
let internalKey = null;
function getInternalKey() {
  if (!internalKey) {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    internalKey = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return internalKey;
}

function checkoutEnv(env) {
  return { ...envFor('checkout', env), __INTERNAL_KEY: getInternalKey() };
}

function dashboardEnv(env, ctx) {
  const scoped = envFor('dashboard', env);
  // Substitui o antigo Service Binding: o dashboard pede reembolso e reenvio
  // de e-mail ao checkout, que é quem tem as credenciais.
  scoped.CHECKOUT_SERVICE = {
    fetch: (input, init) => {
      const request = new Request(input instanceof Request ? input : new Request(input, init));
      request.headers.set(INTERNAL_HEADER, getInternalKey());
      return checkout.fetch(request, checkoutEnv(env), ctx);
    },
  };
  return scoped;
}

// Requisições públicas nunca carregam o cabeçalho interno.
function stripInternalHeader(request) {
  if (!request.headers.has(INTERNAL_HEADER)) return request;
  const clean = new Request(request);
  clean.headers.delete(INTERNAL_HEADER);
  return clean;
}

export default {
  async fetch(incoming, env, ctx) {
    const request = stripInternalHeader(incoming);
    const { pathname } = new URL(request.url);
    const module = resolveModule(pathname);

    if (module === 'blocked') return new Response('Not found', { status: 404 });
    if (module === 'dashboard') return dashboard.fetch(request, dashboardEnv(env, ctx), ctx);
    if (module === 'checkout') return checkout.fetch(request, checkoutEnv(env), ctx);
    return site.fetch(request, envFor('site', env), ctx);
  },
};
