// Páginas de venda: sorteio/fixação de variante, injeção do Pixel + window.__LP
// e do lp-tracking.js, e registro do page_view com utm_page por variante.

import { getCookie, logPageView } from '../../shared/utils.js';
import { PAGES } from '../pages.config.mjs';
import { loadOffer } from './offers.mjs';

const TRACKING_SCRIPT = '<script src="/static/lp-tracking.js"></script>';
const STICKY_MAX_AGE = 2592000; // 30 dias

const FBQ_BOOT =
  "!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');";

export function findPage(slug, pages = PAGES) {
  if (!slug || !Object.prototype.hasOwnProperty.call(pages, slug)) return null;
  return pages[slug] || null;
}

function variantIds(page) {
  return Object.keys(page.variants || {}).map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

function splitPool(page) {
  const ids = variantIds(page);
  const pool = Array.isArray(page.split) ? page.split.map(Number).filter((n) => ids.includes(n)) : [];
  return pool.length ? pool : ids;
}

export function cookieName(slug) {
  return 'lp_' + slug + '_v';
}

// ?v=N força uma variante (preview/teste) e gruda no cookie; senão o cookie
// mantém o visitante na mesma variante; senão sorteia do split.
export function pickVariant(url, request, slug, page) {
  const ids = variantIds(page);
  const q = url.searchParams.get('v');
  if (q && /^\d{1,3}$/.test(q) && ids.includes(Number(q))) return Number(q);
  const pool = splitPool(page);
  const c = getCookie(request, cookieName(slug));
  if (c && /^\d{1,3}$/.test(c) && pool.includes(Number(c))) return Number(c);
  return pool[Math.floor(Math.random() * pool.length)];
}

function pixelIdSafe(value) {
  const v = String(value == null ? '' : value).trim();
  return /^\d{1,30}$/.test(v) ? v : '';
}

export function buildHeadInject(pixelId, cfg) {
  const cfgJson = JSON.stringify(cfg).replace(/</g, '\\u003c');
  if (!pixelId) return '<script>window.__LP=' + cfgJson + ';</script>';
  return (
    '<script>' +
    FBQ_BOOT +
    "fbq('init','" + pixelId + "');fbq('track','PageView');" +
    'window.__LP=' + cfgJson + ';' +
    '</script>' +
    '<noscript><img height="1" width="1" style="display:none" ' +
    'src="https://www.facebook.com/tr?id=' + pixelId + '&ev=PageView&noscript=1"/></noscript>'
  );
}

export function utmPageFor(slug, variant) {
  return '/' + slug + '-v' + variant;
}

export async function buildPageConfig(env, slug, page, variant) {
  const offer = page.offer ? await loadOffer(env, page.offer) : null;
  const pixelId = pixelIdSafe(page.pixelId) || pixelIdSafe(offer && offer.meta_pixel_id) || pixelIdSafe(env.META_PIXEL_ID);
  const offerValue = offer && Number.isFinite(Number(offer.sale_price_cents)) ? Number(offer.sale_price_cents) / 100 : 0;
  const cfg = {
    pixelId,
    page: slug,
    funnel: page.funnel || slug,
    utmPage: utmPageFor(slug, variant),
    offer: page.offer || '',
    source: page.source || slug,
    content: page.content || (offer && offer.name) || slug,
    value: typeof page.value === 'number' ? page.value : offerValue,
    currency: 'BRL',
  };
  return cfg;
}

// Substituições por função: headInject carrega nome/preço da oferta vindos do
// banco, e um replacement em string expandiria padrões como $&, $' e $`.
export function injectHtml(html, headInject) {
  let out = html;
  if (out.includes('</head>')) out = out.replace('</head>', () => headInject + '</head>');
  else out = headInject + out;
  if (out.includes('</body>')) out = out.replace('</body>', () => TRACKING_SCRIPT + '</body>');
  else out = out + TRACKING_SCRIPT;
  return out;
}

async function serveVariant(request, env, slug, page, variant) {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = page.variants[variant];
  assetUrl.search = '';
  const assetResp = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET' }));
  if (!assetResp.ok) return assetResp;

  const cfg = await buildPageConfig(env, slug, page, variant);
  const html = injectHtml(await assetResp.text(), buildHeadInject(cfg.pixelId, cfg));

  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'private, no-store, no-cache, max-age=0, must-revalidate',
    'pragma': 'no-cache',
    'expires': '0',
    'cdn-cache-control': 'no-store',
    'cloudflare-cdn-cache-control': 'no-store',
    'x-lp-variant': String(variant),
  });
  // Sticky por 30 dias, só no path da página.
  headers.append(
    'set-cookie',
    cookieName(slug) + '=' + variant + '; Path=/' + slug + '; Max-Age=' + STICKY_MAX_AGE + '; SameSite=Lax; Secure'
  );
  return new Response(html, { status: 200, headers });
}

// Responde a /<slug> quando o slug está registrado; null caso contrário.
export async function handlePage(request, env, ctx, slug, pages = PAGES) {
  const page = findPage(slug, pages);
  if (!page) return null;
  const url = new URL(request.url);
  const variant = pickVariant(url, request, slug, page);
  if (!variant) return null;
  if (request.method === 'GET' && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(logPageView(slug, request, env, page.funnel || slug, { utmPage: utmPageFor(slug, variant) }));
  }
  return serveVariant(request, env, slug, page, variant);
}
