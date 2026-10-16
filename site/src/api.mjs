// APIs públicas de rastreamento das páginas: eventos por seção, beacons de
// clique/popup, relay da CAPI e captura de lead.

import {
  MAX, UTM_KEYS,
  clean, json, nowBrasilia,
  logPageView, getUtmPage, normalizePhone,
  sendMetaCapiEvent, parseDevice, isBotRequest, pickCapiCustomData,
} from '../../shared/utils.js';
import { PAGES } from '../pages.config.mjs';
import { isValidOfferCode, loadOffer } from './offers.mjs';

const FUNNEL_RE = /^[a-z0-9_-]{1,40}$/i;

// =====================================================
//              /api/section-event (analytics por seção)
// =====================================================

const SECTION_EVENT_TYPES = new Set(['section_view', 'cta_click', 'max_scroll', 'time_on_page']);
const SLUG_RE = /^[a-z0-9_-]{1,60}$/i;
const MAX_EVENTS_PER_BATCH = 50;

function sanitizeSlug(value, maxLen = 60) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (!SLUG_RE.test(v)) return null;
  return v.toLowerCase().slice(0, maxLen);
}

export async function handleSectionEvent(request, env, ctx) {
  const ua = (request.headers.get('user-agent') || '').slice(0, 500);
  if (isBotRequest(request)) return new Response(null, { status: 204 });

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(null, { status: 204 });
  }
  if (!body || typeof body !== 'object') return new Response(null, { status: 204 });

  const rawUuid = String(body.session_uuid || '').trim();
  const sessionUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawUuid)
    ? rawUuid
    : null;
  if (!sessionUuid) return new Response(null, { status: 204 });

  const page = sanitizeSlug(body.page, 80);
  if (!page) return new Response(null, { status: 204 });
  const funnel = sanitizeSlug(body.funnel, 60);

  const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS_PER_BATCH) : [];
  if (events.length === 0) return new Response(null, { status: 204 });

  const ip = (request.headers.get('cf-connecting-ip') || '').slice(0, 64);
  const device = parseDevice(ua);
  const createdAt = nowBrasilia();

  const utms = body.utm && typeof body.utm === 'object' ? body.utm : {};
  const utm_source   = clean(utms.utm_source,   MAX.utm) || null;
  const utm_medium   = clean(utms.utm_medium,   MAX.utm) || null;
  const utm_campaign = clean(utms.utm_campaign, MAX.utm) || null;
  const utm_term     = clean(utms.utm_term,     MAX.utm) || null;
  const utm_content  = clean(utms.utm_content,  MAX.utm) || null;

  const stmt = env.DB.prepare(
    'INSERT INTO section_events (session_uuid, page, funnel, section, event_type, cta, last_visible_section, value, ip, user_agent, device, utm_source, utm_medium, utm_campaign, utm_term, utm_content, ts_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );

  const batch = [];
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const eventType = String(ev.type || '').trim();
    if (!SECTION_EVENT_TYPES.has(eventType)) continue;

    const section = ev.section != null ? sanitizeSlug(ev.section, 60) : null;
    const cta = ev.cta != null ? sanitizeSlug(ev.cta, 30) : null;
    const lastVis = ev.last_visible_section != null ? sanitizeSlug(ev.last_visible_section, 60) : null;
    const tsRaw = Number(ev.ts_ms);
    const tsMs = Number.isFinite(tsRaw) && tsRaw > 0 ? Math.floor(tsRaw) : Date.now();
    const valRaw = Number(ev.value);
    const value = Number.isFinite(valRaw) ? valRaw : null;

    if (eventType === 'cta_click' && !cta) continue;
    if ((eventType === 'section_view') && !section) continue;

    batch.push(stmt.bind(
      sessionUuid, page, funnel, section, eventType, cta, lastVis, value,
      ip, ua, device,
      utm_source, utm_medium, utm_campaign, utm_term, utm_content,
      tsMs, createdAt
    ));
  }

  if (batch.length === 0) return new Response(null, { status: 204 });

  const insert = async () => {
    try {
      await env.DB.batch(batch);
    } catch (err) {
      console.error('[section-event db]', err && err.message || err);
    }
  };
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(insert());
  else await insert();

  return new Response(null, { status: 204 });
}

// =====================================================
//     /api/checkout-click e /api/popup-open (beacons)
// =====================================================

// Grava um page_view sintético ('checkout' ou 'popup') para páginas que levam
// a um checkout externo ou abrem um popup, onde não há page_view do worker.
async function handleBeacon(request, env, ctx, page, defaultFunnel) {
  let funnel = defaultFunnel;
  let utmPage = null;
  try {
    const body = await request.clone().json();
    const raw = clean(body && body.funnel, 40);
    if (raw && FUNNEL_RE.test(raw)) funnel = raw.toLowerCase();
    const rawUtmPage = clean(body && body.utm_page, MAX.utm);
    if (rawUtmPage) utmPage = rawUtmPage;
  } catch { /* ignore */ }
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(logPageView(page, request, env, funnel, utmPage ? { utmPage } : null));
  }
  return new Response(null, { status: 204 });
}

export function handleCheckoutClick(request, env, ctx) {
  return handleBeacon(request, env, ctx, 'checkout', null);
}

export function handlePopupOpen(request, env, ctx) {
  return handleBeacon(request, env, ctx, 'popup', 'lp');
}

// =====================================================
//              /api/meta-event (relay da CAPI)
// =====================================================

const META_EVENTS = new Set(['PageView', 'ViewContent', 'InitiateCheckout', 'Lead', 'AddToCart', 'CompleteRegistration']);

function findPageBySource(source, pages = PAGES) {
  if (typeof source !== 'string' || !source) return null;
  for (const [slug, page] of Object.entries(pages)) {
    if ((page.source || slug) === source) return page;
  }
  return null;
}

// Mesmo pixel que a página usou no navegador (para a deduplicação funcionar):
// pixelId da página > pixel da oferta (offer_code) > META_PIXEL_ID. O token é o
// da oferta quando o pixel é o dela; nos outros casos sendMetaCapiEvent usa
// META_PIXEL_ACCESS_TOKEN.
export async function resolveCapiTarget(env, body, pages = PAGES) {
  const { target } = await resolveCapiContext(env, body, pages);
  return target;
}

// Resolve, no servidor, tudo o que o relay precisa: pixel/token (ver acima, a
// partir do offer_code), a página registrada (pelo `source`) e a oferta que dá
// o valor do evento: a oferta configurada na página (a mesma que precificou o
// Pixel no navegador via window.__LP) ou, sem página, a do offer_code.
async function resolveCapiContext(env, body, pages = PAGES) {
  const page = findPageBySource(body.source, pages);
  const bodyCode = typeof body.offer_code === 'string' ? body.offer_code.trim() : '';
  const offer = isValidOfferCode(bodyCode) ? await loadOffer(env, bodyCode) : null;
  const offerPixel = offer && offer.meta_pixel_id ? String(offer.meta_pixel_id).trim() : '';
  const pagePixel = page && page.pixelId ? String(page.pixelId).trim() : '';
  const pixelId = pagePixel || offerPixel || null;
  const accessToken = pixelId && pixelId === offerPixel ? (offer.meta_capi_token || null) : null;

  let valueOffer = offer;
  const pageOffer = page && typeof page.offer === 'string' ? page.offer.trim() : '';
  if (isValidOfferCode(pageOffer) && pageOffer.toLowerCase() !== bodyCode.toLowerCase()) {
    valueOffer = await loadOffer(env, pageOffer);
  }
  return { page, offer: valueOffer, target: { pixel_id: pixelId, access_token: accessToken } };
}

const META_CUSTOM_DATA_KEYS = ['content_name', 'content_ids', 'content_type', 'content_category', 'num_items'];
// PageView segue sem valor (o Pixel do navegador também não manda); nos demais
// eventos o valor, quando existe, vem sempre do servidor.
const UNVALUED_META_EVENTS = new Set(['PageView']);

// Valor confiável do evento: `value` da página registrada (pages.config) ou o
// preço da oferta no banco. null quando nenhum dos dois existe.
function trustedEventValue(page, offer) {
  if (page && typeof page.value === 'number' && Number.isFinite(page.value) && page.value >= 0) return page.value;
  const cents = offer ? Number(offer.sale_price_cents) : NaN;
  return Number.isFinite(cents) && cents >= 0 ? cents / 100 : null;
}

// custom_data montado no servidor: só chaves conhecidas do cliente; value e
// currency nunca vêm do navegador. Eventos ligados a uma oferta/página levam
// o valor confiável e a moeda BRL; sem oferta/página o evento segue sem valor.
export function buildMetaCustomData(eventName, raw, { page = null, offer = null } = {}) {
  const data = pickCapiCustomData(raw, META_CUSTOM_DATA_KEYS);
  const value = UNVALUED_META_EVENTS.has(eventName) ? null : trustedEventValue(page, offer);
  if (value !== null) {
    data.value = Math.round(value * 100) / 100;
    data.currency = 'BRL';
  }
  return data;
}

function safeEventSourceUrl(value) {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim().slice(0, 1000);
  return /^https?:\/\//i.test(raw) ? raw : undefined;
}

function optionalText(value, max) {
  return typeof value === 'string' ? clean(value, max) || undefined : undefined;
}

export async function handleMetaEvent(request, env, ctx) {
  let body = null;
  try { body = await request.json(); } catch { /* ignore */ }
  if (!body || typeof body.event_name !== 'string' || typeof body.event_id !== 'string') {
    return json({ ok: false, error: 'invalid_payload' }, 400);
  }
  if (!META_EVENTS.has(body.event_name)) {
    return json({ ok: false, error: 'invalid_event' }, 400);
  }
  const eventId = clean(body.event_id, 100);
  if (!eventId) return json({ ok: false, error: 'invalid_payload' }, 400);

  const capiEvent = async () => {
    try {
      const { page, offer, target } = await resolveCapiContext(env, body);
      // Só campos conhecidos seguem adiante: pixel, token e test_event_code
      // nunca vêm do cliente (META_TEST_EVENT_CODE da instância continua valendo).
      const payload = {
        event_name: body.event_name,
        event_id: eventId,
        event_source_url: safeEventSourceUrl(body.event_source_url),
        custom_data: buildMetaCustomData(body.event_name, body.custom_data, { page, offer }),
        email: optionalText(body.email, MAX.email),
        phone: optionalText(body.phone, MAX.phone),
        name: optionalText(body.name, MAX.name),
        pixel_id: target.pixel_id,
        access_token: target.access_token,
      };
      const result = await sendMetaCapiEvent(request, env, payload);
      if (!result || !result.ok) {
        console.error('[meta-event] capi failed', JSON.stringify({
          event_name: body.event_name, error: result && result.error, detail: result && result.detail,
        }));
      }
      return result;
    } catch (err) {
      console.error('[meta-event] relay error', String(err && err.message || err).slice(0, 300));
      return null;
    }
  };

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(capiEvent());
  }
  return new Response(null, { status: 204 });
}

// =====================================================
//              /api/lead (captura de lead por formulário)
// =====================================================

const LEAD_STATUSES = new Set(['lead']);
export const MAX_LEAD_BODY_BYTES = 8 * 1024;

// Lê o corpo com limite de bytes, sem confiar só no content-length. Retorna
// null quando o corpo passa do limite.
async function readLimitedText(request, maxBytes) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maxBytes) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (_) { /* ignore */ }
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(all);
}

export async function handleLead(request, env) {
  // Robôs são descartados em silêncio, como no /api/section-event.
  if (isBotRequest(request)) return new Response(null, { status: 204 });

  const text = await readLimitedText(request, MAX_LEAD_BODY_BYTES);
  if (text === null) return json({ ok: false, error: 'payload_too_large' }, 413);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  if (!data || typeof data !== 'object') return json({ ok: false, error: 'invalid_json' }, 400);

  // Honeypot opcional: o formulário pode ter um campo oculto "website" que
  // pessoas não preenchem. Preenchido = robô: responde sucesso sem gravar.
  if (data.website != null && String(data.website).trim() !== '') {
    return json({ ok: true });
  }

  const name = clean(data.name, MAX.name);
  const email = clean(data.email, MAX.email);
  const phone = clean(data.phone, MAX.phone);

  if (!name || !email || !phone) {
    return json({ ok: false, error: 'missing_fields' }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ ok: false, error: 'invalid_email' }, 400);
  }
  if (phone.replace(/\D/g, '').length < 10) {
    return json({ ok: false, error: 'invalid_phone' }, 400);
  }

  const ip = request.headers.get('cf-connecting-ip') || '';
  const ua = (request.headers.get('user-agent') || '').slice(0, 500);

  const utms = {};
  for (const key of UTM_KEYS) {
    const v = clean(data[key], MAX.utm);
    utms[key] = v || null;
  }
  const utmPage = getUtmPage(request, data.utm_page);

  const rawFunnel = clean(data.funnel, 40);
  const funnel = rawFunnel && FUNNEL_RE.test(rawFunnel) ? rawFunnel.toLowerCase() : 'lp';
  const rawStatus = clean(data.status, MAX.status);
  const status = LEAD_STATUSES.has(rawStatus) ? rawStatus : 'lead';
  const rawOffer = clean(data.offer, 64);
  const product = isValidOfferCode(rawOffer) ? rawOffer.toLowerCase() : null;
  const meta = {
    meta_campaign_id: clean(data.meta_campaign_id, 40) || null,
    meta_adset_id: clean(data.meta_adset_id, 40) || null,
    meta_ad_id: clean(data.meta_ad_id, 40) || null,
    fbclid: clean(data.fbclid, 255) || null,
  };

  try {
    const now = nowBrasilia();
    const ins = await env.DB.prepare(
      'INSERT INTO leads (name, email, phone, phone_norm, method, status, utm_source, utm_medium, utm_campaign, utm_term, utm_content, ip, user_agent, created_at, updated_at, funnel, utm_page, product, meta_campaign_id, meta_adset_id, meta_ad_id, fbclid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      name, email, phone, normalizePhone(phone) || null, 'form', status,
      utms.utm_source, utms.utm_medium, utms.utm_campaign, utms.utm_term, utms.utm_content,
      ip, ua, now, now, funnel, utmPage, product,
      meta.meta_campaign_id, meta.meta_adset_id, meta.meta_ad_id, meta.fbclid
    ).run();
    const id = (ins && ins.meta && ins.meta.last_row_id) || null;
    return json({ ok: true, id });
  } catch (err) {
    console.error('[lead] insert failed', String(err && err.message || err).slice(0, 300));
    return json({ ok: false, error: 'db_error' }, 500);
  }
}
