// Módulo "site" do Worker: páginas de venda, /obrigado, APIs de rastreamento
// e arquivos estáticos de public/. O roteador (src/index.js) entrega aqui tudo
// que não é checkout nem dashboard.

import {
  clean, logPageView, serveHtmlNoCache, stripParamsRedirect, withPageViewTracking,
} from '../../shared/utils.js';
import {
  handleCheckoutClick, handleLead, handleMetaEvent, handlePopupOpen, handleSectionEvent,
} from './api.mjs';
import { handlePage } from './pages.mjs';

const FUNNEL_RE = /^[a-z0-9_-]{1,40}$/i;
const PAGE_SLUG_RE = /^[a-z0-9_-]{1,60}$/i;

const API_ROUTES = {
  '/api/section-event': handleSectionEvent,
  '/api/checkout-click': handleCheckoutClick,
  '/api/popup-open': handlePopupOpen,
  '/api/meta-event': handleMetaEvent,
  '/api/lead': handleLead,
};

function notFound() {
  return new Response('Página não encontrada', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function defaultPage(env) {
  const slug = clean(env && env.DEFAULT_PAGE, 60);
  return PAGE_SLUG_RE.test(slug) ? slug : 'exemplo';
}

function redirectTo(url, pathname) {
  const target = new URL(url.toString());
  target.pathname = pathname;
  return Response.redirect(target.toString(), 302);
}

async function serveThanks(request, env, ctx, url) {
  if (request.method === 'GET' && ctx && typeof ctx.waitUntil === 'function') {
    let funnel = 'lp';
    const raw = clean(url.searchParams.get('funnel'), 40);
    if (raw && FUNNEL_RE.test(raw)) funnel = raw.toLowerCase();
    ctx.waitUntil(logPageView('obrigado', request, env, funnel));
  }
  return serveHtmlNoCache(request, env, '/obrigado.html', { '__META_PIXEL_ID__': env.META_PIXEL_ID || '' });
}

async function serveStatic(request, env) {
  // Os HTML das páginas só podem sair pela rota /<slug>, que injeta Pixel,
  // window.__LP e registra a visita. Acesso direto ao arquivo fica bloqueado.
  if (new URL(request.url).pathname.startsWith('/pages/')) return notFound();
  const response = await env.ASSETS.fetch(request);
  if (response.status !== 404) return response;
  const last = new URL(request.url).pathname.split('/').pop() || '';
  return last.includes('.') ? response : notFound();
}

export default withPageViewTracking({
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Como na origem, as APIs só respondem a POST; outros métodos caem no 404.
    const api = API_ROUTES[path];
    if (api && request.method === 'POST') return api(request, env, ctx);

    const stripped = stripParamsRedirect(url);
    if (stripped) return stripped;

    if (path === '/') return redirectTo(url, '/' + defaultPage(env));

    if (path === '/obrigado') return serveThanks(request, env, ctx, url);

    const slug = path.slice(1);
    if (PAGE_SLUG_RE.test(slug)) {
      const response = await handlePage(request, env, ctx, slug);
      if (response) return response;
    }

    return serveStatic(request, env);
  },
});
