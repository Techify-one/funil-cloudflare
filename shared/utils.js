import { isBotRequest, pageViewRequestContext } from './bot-detection.mjs';
export { BOT_UA_RE, isBot, isBotRequest } from './bot-detection.mjs';

export const MAX = { name: 200, email: 200, phone: 50, method: 40, status: 40, utm: 255 };
export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
export const STRIP_PARAMS = ['src'];

// Classifica o device em 3 buckets a partir do User-Agent. Tablet é testado
// antes de mobile (Android tablet bate em ambos).
export function parseDevice(ua) {
  const s = String(ua || '');
  if (/iPad|Tablet|Kindle|PlayBook|Silk/i.test(s)) return 'tablet';
  if (/Android/i.test(s) && !/Mobile/i.test(s)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod|Windows Phone|BlackBerry|Opera Mini/i.test(s)) return 'mobile';
  return 'desktop';
}

// Valor de configuração da instância (variável de ambiente) já limpo. Um
// marcador do modelo que não foi substituído (ex.: __NOME__) conta como vazio.
export function configValue(value) {
  const v = String(value == null ? '' : value).trim();
  return /^__[A-Z0-9_]+__$/.test(v) ? '' : v;
}

export function nowBrasilia() {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return d.toISOString().replace('Z', '-03:00');
}

export function clean(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function rewriteToAsset(request, assetPath) {
  const url = new URL(request.url);
  url.pathname = assetPath;
  return new Request(url.toString(), request);
}

export async function serveHtmlNoCache(request, env, assetPath, replacements) {
  const assetResponse = await env.ASSETS.fetch(rewriteToAsset(request, assetPath));
  const headers = {
    'content-type': assetResponse.headers.get('content-type') || 'text/html; charset=utf-8',
    'cache-control': 'private, no-store, no-cache, max-age=0, must-revalidate',
    'pragma': 'no-cache',
    'expires': '0',
    'cdn-cache-control': 'no-store',
    'cloudflare-cdn-cache-control': 'no-store',
  };
  if (replacements && typeof replacements === 'object') {
    let html = await assetResponse.text();
    for (const [key, value] of Object.entries(replacements)) {
      // Substituição por função: o valor vem de env/D1 e pode conter padrões
      // especiais do String.replace ($&, $', $`), que não podem ser expandidos.
      const text = value == null ? '' : String(value);
      html = html.replaceAll(key, () => text);
    }
    return new Response(html, { status: assetResponse.status, headers });
  }
  const response = new Response(assetResponse.body, assetResponse);
  for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
  return response;
}

export function redirect(url, target) {
  const u = new URL(url);
  u.pathname = target;
  return Response.redirect(u.toString(), 302);
}

export function stripParamsRedirect(url) {
  const cleaned = new URL(url.toString());
  let changed = false;
  for (const p of STRIP_PARAMS) {
    if (cleaned.searchParams.has(p)) {
      cleaned.searchParams.delete(p);
      changed = true;
    }
  }
  return changed ? Response.redirect(cleaned.toString(), 302) : null;
}

export async function logPageView(page, request, env, funnel = null, opts = null) {
  try {
    if (isBotRequest(request)) return;
    const ua = (request.headers.get('user-agent') || '').slice(0, 500);
    const ip = request.headers.get('cf-connecting-ip') || '';
    const referrer = (request.headers.get('referer') || '').slice(0, 500);
    const createdAt = nowBrasilia();
    const funnelSlug = funnel ? String(funnel).slice(0, 40) : null;

    const utms = {};
    for (const key of UTM_KEYS) utms[key] = null;
    const fillFrom = (urlStr) => {
      try {
        const sp = new URL(urlStr).searchParams;
        for (const key of UTM_KEYS) {
          if (utms[key]) continue;
          const v = clean(sp.get(key), MAX.utm);
          if (v) utms[key] = v;
        }
      } catch { /* ignore */ }
    };
    fillFrom(request.url);
    if (referrer) fillFrom(referrer);

    let cookieUuid = '';
    try { cookieUuid = getCookie(request, PAGE_VIEW_SESSION_COOKIE); } catch { /* cookie inválido */ }
    const rawUuid = opts && opts.sessionUuid ? String(opts.sessionUuid) : cookieUuid;
    const sessionUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawUuid)
      ? rawUuid
      : null;

    let utmPage = null;
    const optUtmPage = opts && opts.utmPage ? clean(opts.utmPage, MAX.utm) : '';
    if (optUtmPage) {
      utmPage = optUtmPage;
    } else {
      try { utmPage = clean(new URL(request.url).pathname, MAX.utm) || null; } catch { /* ignore */ }
    }

    await env.DB.prepare(
      'INSERT INTO page_views (page, ip, user_agent, referrer, created_at, funnel, utm_source, utm_medium, utm_campaign, utm_term, utm_content, session_uuid, utm_page, request_context) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      page, ip, ua, referrer, createdAt, funnelSlug,
      utms.utm_source, utms.utm_medium, utms.utm_campaign, utms.utm_term, utms.utm_content,
      sessionUuid, utmPage, pageViewRequestContext(request)
    ).run();
  } catch (_) { /* best-effort */ }
}

export function getUtmPage(request, preferred) {
  const p = clean(preferred, MAX.utm);
  if (p) return p;
  try { return clean(new URL(request.url).pathname, MAX.utm) || null; } catch { return null; }
}

export async function findPendingLeadIdByIp(env, ip) {
  if (!ip) return null;
  try {
    const row = await env.DB
      .prepare("SELECT id FROM leads WHERE ip = ? AND (status IS NULL OR status != 'comprou') ORDER BY id DESC LIMIT 1")
      .bind(ip)
      .first();
    return row && row.id ? row.id : null;
  } catch (err) {
    console.error('[findPendingLeadIdByIp]', err && err.message || err);
    return null;
  }
}

// Telefone só com dígitos (chave canônica de dedup de lead). Ver phone_norm.
export function normalizePhone(phone) {
  return String(phone == null ? '' : phone).replace(/\D/g, '');
}

// Dedup canônico de lead: telefone normalizado (phone_norm) > e-mail.
// NÃO deduplica por IP de propósito: em CGNAT/4G/wifi compartilhado pessoas
// distintas saem pelo mesmo IP, e fundir leads por IP corrompe a atribuição
// (congela o funil de uma pessoa na tentativa de outra). Telefone e e-mail
// identificam a pessoa de fato; IP não.
export async function resolveLeadId(env, { phone, email } = {}) {
  try {
    const pn = normalizePhone(phone);
    if (pn.length >= 10) {
      const row = await env.DB
        .prepare("SELECT id FROM leads WHERE phone_norm = ? ORDER BY id DESC LIMIT 1")
        .bind(pn).first();
      if (row && row.id) return row.id;
    }
    const em = String(email || '').trim().toLowerCase();
    if (em) {
      const row = await env.DB
        .prepare("SELECT id FROM leads WHERE LOWER(email) = ? ORDER BY id DESC LIMIT 1")
        .bind(em).first();
      if (row && row.id) return row.id;
    }
    return null;
  } catch (err) {
    console.error('[resolveLeadId]', err && err.message || err);
    return null;
  }
}

// Idempotência pra checkout fake (out_of_stock): re-cliques/retries não devem
// criar leads 'comprou' duplicados. Procura lead 'comprou' recente pelo mesmo
// IP ou e-mail antes de inserir uma nova row.
export async function findRecentPurchaseLeadId(env, { ip, email }, maxAgeMinutes = 60) {
  if (!ip && !email) return null;
  const cutoffMs = Date.now() - (maxAgeMinutes * 60 + 3 * 60 * 60) * 1000;
  const cutoff = new Date(cutoffMs).toISOString().replace('Z', '-03:00');
  try {
    let row;
    if (ip && email) {
      row = await env.DB
        .prepare("SELECT id FROM leads WHERE status = 'comprou' AND (ip = ? OR LOWER(email) = LOWER(?)) AND created_at >= ? ORDER BY id DESC LIMIT 1")
        .bind(ip, email, cutoff).first();
    } else if (ip) {
      row = await env.DB
        .prepare("SELECT id FROM leads WHERE status = 'comprou' AND ip = ? AND created_at >= ? ORDER BY id DESC LIMIT 1")
        .bind(ip, cutoff).first();
    } else {
      row = await env.DB
        .prepare("SELECT id FROM leads WHERE status = 'comprou' AND LOWER(email) = LOWER(?) AND created_at >= ? ORDER BY id DESC LIMIT 1")
        .bind(email, cutoff).first();
    }
    return row && row.id ? row.id : null;
  } catch (err) {
    console.error('[findRecentPurchaseLeadId]', err && err.message || err);
    return null;
  }
}

export async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input).trim().toLowerCase());
  const buf = await crypto.subtle.digest('SHA-256', data);
  const arr = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, '0');
  return out;
}

export function getCookie(request, name) {
  const cookie = request.headers.get('cookie') || '';
  const parts = cookie.split(/;\s*/);
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i > 0 && p.slice(0, i) === name) return decodeURIComponent(p.slice(i + 1));
  }
  return '';
}

const PAGE_VIEW_SESSION_COOKIE = 'tx_session_uuid';
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getPageViewSession(request) {
  let existing = '';
  try { existing = getCookie(request, PAGE_VIEW_SESSION_COOKIE); } catch { /* cookie inválido */ }
  if (SESSION_UUID_RE.test(existing)) return { uuid: existing, isNew: false };
  return { uuid: crypto.randomUUID(), isNew: true };
}

export function withPageViewSessionCookie(response, session) {
  if (!session || !session.isNew || !SESSION_UUID_RE.test(String(session.uuid || ''))) return response;
  const headers = new Headers(response.headers);
  headers.append(
    'set-cookie',
    `${PAGE_VIEW_SESSION_COOKIE}=${encodeURIComponent(session.uuid)}; Path=/; Max-Age=2592000; SameSite=Lax; Secure`,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Disponibiliza o mesmo UUID para o primeiro pageview e a resposta HTML, sem
// estado global. Requisições que não são GET passam pelo handler original.
export function withPageViewTracking(worker) {
  return {
    ...worker,
    async fetch(request, env, ctx) {
      if (request.method !== 'GET') return worker.fetch(request, env, ctx);
      const session = getPageViewSession(request);
      if (!session.isNew) return worker.fetch(request, env, ctx);
      const headers = new Headers(request.headers);
      // Primeiro na lista para substituir também um cookie anterior inválido.
      headers.set('cookie', `${PAGE_VIEW_SESSION_COOKIE}=${session.uuid}; ${headers.get('cookie') || ''}`);
      const trackedRequest = new Request(request, { headers });
      const response = await worker.fetch(trackedRequest, env, ctx);
      if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return response;
      return withPageViewSessionCookie(response, session);
    },
  };
}

// Comparação de segredos em tempo constante (não vaza, pelo tempo de resposta,
// quantos caracteres iniciais batem). Usa crypto.subtle.timingSafeEqual quando
// o runtime oferece (Workers) e, fora dele, um laço XOR sobre todos os bytes.
// Comprimentos diferentes retornam false sem atalho dependente do conteúdo.
export function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const left = enc.encode(String(a == null ? '' : a));
  const right = enc.encode(String(b == null ? '' : b));
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (left.length === right.length && subtle && typeof subtle.timingSafeEqual === 'function') {
    try { return subtle.timingSafeEqual(left, right); } catch (_) { /* cai no laço manual */ }
  }
  const len = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < len; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

// Chaves de custom_data que um evento vindo do navegador pode carregar até a
// CAPI. value e currency nunca são copiados daqui: quem chama define o valor
// confiável (preço da oferta) e força a moeda.
const CAPI_CUSTOM_DATA_RULES = {
  content_name: (v) => capiText(v, 200),
  content_category: (v) => capiText(v, 100),
  content_type: (v) => {
    const t = capiText(v, 20);
    return t === 'product' || t === 'product_group' ? t : undefined;
  },
  content_ids: (v) => {
    if (!Array.isArray(v)) return undefined;
    const ids = v.slice(0, 20).map((id) => capiText(id, 100)).filter(Boolean);
    return ids.length ? ids : undefined;
  },
  num_items: (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 100 ? n : undefined;
  },
  order_id: (v) => {
    const t = capiText(v, 100);
    return t && /^[A-Za-z0-9._:-]+$/.test(t) ? t : undefined;
  },
};

function capiText(value, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = clean(value, max);
  return text || undefined;
}

// Copia de `raw` só as chaves de `allowedKeys` (subconjunto de
// CAPI_CUSTOM_DATA_RULES), cada uma higienizada. Qualquer outra chave do
// cliente (value, currency, test_event_code, campos arbitrários) é descartada.
export function pickCapiCustomData(raw, allowedKeys) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const key of allowedKeys) {
    const rule = CAPI_CUSTOM_DATA_RULES[key];
    if (!rule || !Object.prototype.hasOwnProperty.call(src, key)) continue;
    const value = rule(src[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function metaCapiDispatchOutcome(result) {
  if (result && result.ok === true) return { status: 'sent', error: null };
  const error = result && result.error ? String(result.error).slice(0, 300) : 'meta_capi_unknown_error';
  return { status: 'failed', error };
}

export async function sendMetaCapiEvent(request, env, body) {
  // body.pixel_id permite rotear o evento pra um pixel específico (pixel da oferta).
  // É definido server-side pelo handler (não vem do cliente); fallback no pixel da instância.
  const pixelId = body.pixel_id || configValue(env.META_PIXEL_ID);
  // body.access_token permite usar o token da conta dona do pixel (multi-conta).
  // É definido server-side pelo handler (nunca vem do cliente); fallback no token da instância.
  const token = body.access_token || configValue(env.META_PIXEL_ACCESS_TOKEN);
  if (!pixelId || !token) {
    return { ok: false, error: 'meta_capi_not_configured' };
  }

  const ip = request.headers.get('cf-connecting-ip') || '';
  const ua = (request.headers.get('user-agent') || '').slice(0, 500);
  const fbp = getCookie(request, '_fbp');
  const fbc = getCookie(request, '_fbc');
  const referer = request.headers.get('referer') || '';
  const sourceUrl = (body.event_source_url && typeof body.event_source_url === 'string')
    ? body.event_source_url
    : referer || request.url;

  const userData = { client_ip_address: ip, client_user_agent: ua };
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;
  if (body.email) userData.em = [await sha256Hex(body.email)];
  if (body.phone) {
    const digits = String(body.phone).replace(/\D/g, '');
    if (digits) userData.ph = [await sha256Hex(digits)];
  }
  if (body.name) {
    const parts = String(body.name).trim().split(/\s+/);
    if (parts[0]) userData.fn = [await sha256Hex(parts[0])];
    if (parts.length > 1) userData.ln = [await sha256Hex(parts.slice(1).join(' '))];
  }

  const eventTime = Math.floor(Date.now() / 1000);
  const eventName = String(body.event_name).slice(0, 50);
  const eventId = String(body.event_id).slice(0, 100);
  const customData = (body.custom_data && typeof body.custom_data === 'object') ? body.custom_data : {};

  const payload = {
    data: [{
      event_name: eventName,
      event_time: eventTime,
      event_id: eventId,
      action_source: 'website',
      event_source_url: sourceUrl,
      user_data: userData,
      custom_data: customData,
    }],
  };
  // Código de teste do Gerenciador de Eventos: vem do evento ou, se a instância
  // definir META_TEST_EVENT_CODE, vale para todo evento server-side.
  const testEventCode = configValue(body.test_event_code) || configValue(env && env.META_TEST_EVENT_CODE);
  if (testEventCode) payload.test_event_code = testEventCode.slice(0, 100);

  const apiVer = env.META_API_VERSION || 'v25.0';
  const url = `https://graph.facebook.com/${apiVer}/${pixelId}/events?access_token=${encodeURIComponent(token)}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let responseBody = null;
    try { responseBody = await response.json(); } catch (_) { /* ignore invalid JSON */ }
    if (!response.ok) {
      return {
        ok: false,
        error: `meta_capi_http_${response.status}`,
        detail: responseBody && responseBody.error && responseBody.error.message
          ? String(responseBody.error.message).slice(0, 300)
          : null,
      };
    }
    if (!responseBody || Number(responseBody.events_received) < 1) {
      return { ok: false, error: 'meta_capi_event_not_accepted' };
    }
    return {
      ok: true,
      events_received: Number(responseBody.events_received),
      fbtrace_id: responseBody.fbtrace_id || null,
    };
  } catch (error) {
    return {
      ok: false,
      error: 'meta_capi_network_error',
      detail: String(error && error.message || error).slice(0, 300),
    };
  }
}
