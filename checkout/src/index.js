import {
  MAX, UTM_KEYS,
  clean, json, nowBrasilia, configValue,
  serveHtmlNoCache, stripParamsRedirect, rewriteToAsset,
  logPageView, findRecentPurchaseLeadId, getUtmPage,
  metaCapiDispatchOutcome, sendMetaCapiEvent, normalizePhone, resolveLeadId,
  getPageViewSession, withPageViewSessionCookie, isBotRequest,
  pickCapiCustomData, constantTimeEqual,
} from '../../shared/utils.js';
import { upsertOrder } from '../../shared/orders.js';
import {
  normalizeSelectedBumpIds,
  calculateCheckoutSelection,
  buildPaymentItems,
} from '../../shared/order-bumps.mjs';
import {
  buildPurchaseEmail,
  sendTransactionalEmail,
  isEmailConfigured,
} from '../../shared/email.mjs';
import { initialStoredCardStatus } from '../../shared/payment-status.mjs';
import { normalizeCheckoutAnalyticsEvent } from '../../shared/checkout-analytics.mjs';
import { buildFakePurchase } from '../../shared/fake-checkout.mjs';

// Status aceitos pelo endpoint público /api/checkout. 'reembolsado' só nasce
// do fluxo interno de reembolso e 'comprou' só vale para o checkout fake
// (oferta out_of_stock): compra real é registrada pelo pagamento aprovado.
const VALID_LEAD_STATUSES = new Set(['nome', 'email', 'telefone', 'escolheu_metodo', 'pix_gerado', 'comprou']);

const VALID_PAYMENT_ERROR_STAGES = new Set(['pix_create', 'card_create', 'card_rejected', 'card_token', 'network']);

async function logPaymentError(env, request, {
  leadId, offerId, stage, errorCode, errorDetail, funnel, utms, utmPage,
}) {
  try {
    if (!VALID_PAYMENT_ERROR_STAGES.has(stage)) return;
    const ip = request ? (request.headers.get('cf-connecting-ip') || '') : '';
    const ua = request ? (request.headers.get('user-agent') || '').slice(0, 500) : '';
    const u = utms || {};
    await env.DB.prepare(
      `INSERT INTO payment_errors
        (lead_id, offer_id, stage, error_code, error_detail, funnel,
         utm_source, utm_medium, utm_campaign, utm_term, utm_content, utm_page,
         ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      leadId || null, offerId || null, stage,
      (errorCode || '').toString().slice(0, 120),
      (errorDetail || '').toString().slice(0, 500),
      funnel || null,
      u.utm_source || null, u.utm_medium || null, u.utm_campaign || null,
      u.utm_term || null, u.utm_content || null, utmPage || null,
      ip, ua, nowBrasilia()
    ).run();
  } catch (_) { /* best-effort */ }
}

const METHOD_LABELS = {
  'pix': 'Pix',
  'Pix': 'Pix',
  'card': 'Cartão',
  'credit_card': 'Cartão',
  'Cartão': 'Cartão',
};

function methodLabel(method) {
  if (!method) return 'Pix';
  return METHOD_LABELS[method] || METHOD_LABELS[String(method).toLowerCase()] || 'Pix';
}

// =====================================================
//              Helpers
// =====================================================

function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let out = '';
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, '0');
  return out;
}

function isValidOfferCode(code) {
  return typeof code === 'string' && /^[a-z0-9_-]{1,64}$/i.test(code);
}

export function isValidCheckoutEmail(value) {
  const email = String(value || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;

  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  if (!/^[a-z0-9.-]+$/i.test(domain) || domain.includes('..')) return false;
  const labels = domain.split('.');
  if (labels.some((label) => !label || label.startsWith('-') || label.endsWith('-'))) return false;

  // Erros de digitação frequentes que passam na validação sintática simples,
  // mas são recusados pelo Mercado Pago (ex.: gmail.comm).
  const tld = labels[labels.length - 1];
  return !new Set(['comm', 'con', 'coom', 'cpm']).has(tld);
}

function refererPathSameOrigin(request) {
  try {
    const ref = request.headers.get('referer');
    if (!ref) return null;
    const refUrl = new URL(ref);
    const reqUrl = new URL(request.url);
    if (refUrl.host !== reqUrl.host) return null;
    return refUrl.pathname || null;
  } catch {
    return null;
  }
}

async function loadOfferByCode(env, code) {
  if (!isValidOfferCode(code)) return null;
  try {
    const row = await env.DB
      .prepare('SELECT id, code, name, description, anchor_price_cents, sale_price_cents, is_active, out_of_stock, thanks_url, meta_pixel_id, meta_capi_token FROM offers WHERE code = ? LIMIT 1')
      .bind(code.toLowerCase())
      .first();
    if (!row || !row.is_active) return null;
    const bumps = await env.DB.prepare(
      'SELECT id, offer_id, name, description, price_cents, is_active, position FROM order_bumps WHERE offer_id = ? AND is_active = 1 ORDER BY position, id'
    ).bind(row.id).all();
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description || '',
      anchor_price_cents: row.anchor_price_cents || 0,
      sale_price_cents: row.sale_price_cents,
      out_of_stock: Number(row.out_of_stock) === 1,
      thanks_url: row.thanks_url || null,
      order_bumps: bumps.results || [],
      // Pixel + token vivem na oferta, com fallback no pixel/token da instância
      // (env). O pixel é público; o token é SECRETO e NUNCA pode ir pro
      // cliente: ver toPublicOffer().
      meta_pixel_id: row.meta_pixel_id || null,
      meta_capi_token: row.meta_capi_token || null,
    };
  } catch {
    return null;
  }
}

function resolveCheckoutSelection(offer, rawIds) {
  const normalized = normalizeSelectedBumpIds(rawIds);
  if (!normalized.ok) return normalized;
  return calculateCheckoutSelection(offer.sale_price_cents, offer.order_bumps || [], normalized.ids);
}

function paymentOrderBumpStatements(env, mpPaymentId, selectedBumps) {
  return selectedBumps.map((bump) => env.DB.prepare(
    `INSERT INTO payment_order_bumps
       (payment_id, order_bump_id, name_snapshot, description_snapshot, price_cents)
     SELECT id, (SELECT id FROM order_bumps WHERE id = ?), ?, ?, ?
     FROM payments WHERE mp_payment_id = ?`
  ).bind(bump.id, bump.name, bump.description || null, bump.price_cents, String(mpPaymentId)));
}

// Pixel da oferta (público). Sem pixel na oferta, usa o da instância.
function offerPixel(offer, env) {
  return (offer && offer.meta_pixel_id) || configValue(env && env.META_PIXEL_ID) || null;
}

// Pixel + token da CAPI da oferta. Campos nulos caem no fallback da instância
// (META_PIXEL_ID / META_PIXEL_ACCESS_TOKEN) dentro de sendMetaCapiEvent.
function offerCapi(offer) {
  return {
    pixel_id: (offer && offer.meta_pixel_id) || null,
    access_token: (offer && offer.meta_capi_token) || null,
  };
}

// Versão da oferta segura pra enviar ao cliente: remove o token da CAPI.
function toPublicOffer(offer) {
  if (!offer) return null;
  const { meta_capi_token, ...pub } = offer; // descarta o token; meta_pixel_id (público) fica
  return pub;
}

// Dias de garantia exibidos no checkout. '0' esconde o bloco de garantia.
export function guaranteeDays(env) {
  const raw = configValue(env && env.GUARANTEE_DAYS);
  if (raw === '') return '30';
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 3650 ? String(n) : '30';
}

function escapeHtmlText(value) {
  return String(value == null ? '' : value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function serveCheckoutPage(request, env, offerOrNull, assetPath = '/checkout.html') {
  const assetResponse = await env.ASSETS.fetch(rewriteToAsset(request, assetPath));
  let html = await assetResponse.text();
  const publicOffer = toPublicOffer(offerOrNull);
  const offerJson = publicOffer ? JSON.stringify(publicOffer).replace(/</g, '\\u003c') : 'null';
  html = html
    .replaceAll('__OFFER_JSON__', () => offerJson)
    .replaceAll('__BRAND_NAME__', () => escapeHtmlText(configValue(env.BRAND_NAME).slice(0, 80) || 'Checkout'))
    .replaceAll('__GUARANTEE_DAYS__', () => guaranteeDays(env))
    .replaceAll('__META_PIXEL_ID__', () => offerPixel(offerOrNull, env) || '')
    .replaceAll('__MP_PK_VAL__', () => configValue(env.MP_PUBLIC_KEY));
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store, no-cache, max-age=0, must-revalidate',
      'pragma': 'no-cache',
      'expires': '0',
      'cdn-cache-control': 'no-store',
      'cloudflare-cdn-cache-control': 'no-store',
    },
  });
}

// Registra um disparo pós-compra (CAPI/e-mail) em purchase_dispatches.
// Best-effort: nunca derruba o fluxo de compra/reenvio.
async function logDispatch(env, d) {
  try {
    await env.DB.prepare(
      `INSERT INTO purchase_dispatches
         (order_id, lead_id, offer_id, channel, status, triggered_by, destination, message, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      d.order_id ?? null,
      d.lead_id ?? null,
      d.offer_id ?? null,
      d.channel,
      d.status,
      d.triggered_by || 'auto',
      d.destination ?? null,
      d.message ?? null,
      d.error ?? null
    ).run();
  } catch (_) { /* nunca derruba o fluxo */ }
}

// =====================================================
//              Mercado Pago
// =====================================================

async function mpFetch(env, path, init = {}) {
  const token = env.MP_ACCESS_TOKEN;
  if (!token) throw new Error('MP_ACCESS_TOKEN not configured');
  const headers = Object.assign({
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
  }, init.headers || {});
  const resp = await fetch('https://api.mercadopago.com' + path, {
    ...init,
    headers,
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: resp.ok, status: resp.status, data };
}

// Texto que aparece na fatura do cartão. O Mercado Pago aceita até 13
// caracteres; sem STATEMENT_DESCRIPTOR o campo é omitido (vale o padrão da conta).
export function statementDescriptor(env) {
  const raw = configValue(env && env.STATEMENT_DESCRIPTOR)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 13)
    .trim();
  return raw || null;
}

// Pagador enviado ao Mercado Pago. O e-mail de fallback usa o domínio da
// própria instância (hostname da requisição) para não depender de marca fixa.
function buildMpPayer({ payerEmail, payerName, externalRef, hostname }) {
  const host = /^[a-z0-9.-]+$/i.test(String(hostname || '')) ? String(hostname).toLowerCase() : 'example.com';
  return {
    email: payerEmail || ('cliente+' + externalRef + '@' + host),
    first_name: (payerName || '').split(' ').slice(0, 1).join(' ') || 'Cliente',
    last_name: (payerName || '').split(' ').slice(1).join(' ') || 'Cliente',
  };
}

async function createMpPixPayment(env, { amountCents, description, items, payerEmail, payerName, externalRef, notificationUrl, hostname }) {
  const amount = Number((amountCents / 100).toFixed(2));
  const body = {
    transaction_amount: amount,
    description,
    payment_method_id: 'pix',
    payer: buildMpPayer({ payerEmail, payerName, externalRef, hostname }),
    additional_info: {
      items: items || [{
        id: externalRef,
        title: description,
        description: description,
        category_id: 'learnings',
        quantity: 1,
        unit_price: amount,
      }],
    },
    external_reference: externalRef,
    notification_url: notificationUrl || undefined,
  };
  const descriptor = statementDescriptor(env);
  if (descriptor) body.statement_descriptor = descriptor;
  const idempotencyKey = randomHex(16);
  const { ok, status, data } = await mpFetch(env, '/v1/payments', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  });
  if (!ok) {
    const msg = (data && (data.message || data.error)) || ('mp_error_' + status);
    const err = new Error(msg);
    err.mpStatus = status;
    throw err;
  }
  return data;
}

async function createMpCardPayment(env, {
  amountCents, description, items, payerEmail, payerName, externalRef, notificationUrl,
  token, installments, paymentMethodId, issuerId, identificationType, identificationNumber, hostname,
}) {
  const amount = Number((amountCents / 100).toFixed(2));
  const body = {
    transaction_amount: amount,
    description,
    token,
    installments: Math.max(1, parseInt(installments, 10) || 1),
    payment_method_id: paymentMethodId,
    payer: {
      ...buildMpPayer({ payerEmail, payerName, externalRef, hostname }),
      identification: identificationNumber ? {
        type: identificationType || 'CPF',
        number: String(identificationNumber).replace(/\D/g, ''),
      } : undefined,
    },
    additional_info: {
      items: items || [{
        id: externalRef,
        title: description,
        description: description,
        category_id: 'learnings',
        quantity: 1,
        unit_price: amount,
      }],
    },
    external_reference: externalRef,
    notification_url: notificationUrl || undefined,
  };
  if (issuerId) body.issuer_id = String(issuerId);
  const descriptor = statementDescriptor(env);
  if (descriptor) body.statement_descriptor = descriptor;
  const idempotencyKey = randomHex(16);
  const { ok, status, data } = await mpFetch(env, '/v1/payments', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  });
  if (!ok) {
    const msg = (data && (data.message || data.error)) || ('mp_error_' + status);
    console.error('MP_CARD_FAIL', JSON.stringify({
      status,
      response: data,
      sent: { ...body, token: token ? '<redacted>' : null, payer: { ...body.payer, identification: body.payer.identification ? { type: body.payer.identification.type, number: '<redacted>' } : undefined } },
    }));
    const err = new Error(msg);
    err.mpStatus = status;
    err.mpData = data;
    throw err;
  }
  return data;
}

// Detalhe de erro do gateway que pode ir ao navegador: só a mensagem que o
// próprio Mercado Pago devolveu (o front usa para reconhecer e-mail inválido).
// Falhas internas (credencial ausente, rede, exceções) viram um texto genérico;
// o detalhe completo fica no log e em payment_errors.
function publicGatewayDetail(err) {
  if (!err || err.mpStatus == null) return 'gateway_unavailable';
  return String(err.message || '').slice(0, 200) || 'gateway_unavailable';
}

async function getMpPayment(env, mpPaymentId) {
  const { ok, status, data } = await mpFetch(env, '/v1/payments/' + encodeURIComponent(mpPaymentId), { method: 'GET' });
  if (!ok) throw new Error('mp_lookup_failed_' + status);
  return data;
}

// Reembolso integral: o campo `amount` deve ser omitido segundo a API do
// Mercado Pago. A chave de idempotência vem da operação registrada em D1.
export async function createMpFullRefund(env, paymentId, idempotencyKey) {
  const { ok, status, data } = await mpFetch(
    env,
    '/v1/payments/' + encodeURIComponent(paymentId) + '/refunds',
    {
      method: 'POST',
      headers: { 'X-Idempotency-Key': idempotencyKey },
      body: '{}',
    },
  );
  if (!ok) {
    const cause = Array.isArray(data && data.cause) ? data.cause[0] : null;
    const err = new Error(
      String((cause && cause.description) || (data && (data.message || data.error)) || ('mp_refund_failed_' + status)).slice(0, 300),
    );
    err.mpStatus = status;
    err.mpCode = String((cause && cause.code) || (data && data.code) || status).slice(0, 80);
    throw err;
  }
  return data || {};
}

async function claimPaymentRefund(env, payment, operationId) {
  const now = nowBrasilia();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO payment_refunds
       (payment_id, lead_id, mp_payment_id, operation_id, status, amount_cents, requested_at, updated_at)
     VALUES (?, ?, ?, ?, 'requested', ?, ?, ?)`
  ).bind(
    payment.id, payment.lead_id, payment.mp_payment_id, operationId,
    payment.amount_cents, now, now,
  ).run();
  if ((inserted && inserted.meta && inserted.meta.changes) > 0) {
    return { claimed: true, status: 'requested' };
  }

  const existing = await env.DB.prepare(
    `SELECT id, status, refund_id, amount_cents, operation_id
       FROM payment_refunds WHERE payment_id = ? LIMIT 1`
  ).bind(payment.id).first();
  if (!existing) return { claimed: false, status: 'unknown' };

  // Uma falha confirmada pode ser tentada novamente. O compare-and-set garante
  // que somente uma requisição concorrente assume a nova tentativa.
  if (existing.status === 'failed') {
    const retried = await env.DB.prepare(
      `UPDATE payment_refunds
          SET operation_id = ?, status = 'requested', attempt_count = attempt_count + 1,
              error_code = NULL, error_detail = NULL, requested_at = ?,
              completed_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'failed'`
    ).bind(operationId, now, now, existing.id).run();
    if ((retried && retried.meta && retried.meta.changes) > 0) {
      return { claimed: true, status: 'requested' };
    }
  }

  const fresh = await env.DB.prepare(
    `SELECT status, refund_id, amount_cents
       FROM payment_refunds WHERE payment_id = ? LIMIT 1`
  ).bind(payment.id).first();
  return { claimed: false, ...(fresh || existing) };
}

async function updatePaymentRefund(env, paymentId, fields) {
  const now = nowBrasilia();
  await env.DB.prepare(
    `UPDATE payment_refunds
        SET status = ?, refund_id = COALESCE(?, refund_id),
            amount_cents = COALESCE(?, amount_cents),
            error_code = ?, error_detail = ?, completed_at = ?, updated_at = ?
      WHERE payment_id = ?`
  ).bind(
    fields.status,
    fields.refundId || null,
    fields.amountCents ?? null,
    fields.errorCode || null,
    fields.errorDetail || null,
    fields.completed ? now : null,
    now,
    paymentId,
  ).run();
}

// =====================================================
//   Endpoints internos (/internal/*): contrato com o roteador (src/index.js)
//
//   Defesa em profundidade: além do roteador bloquear /internal para o
//   público, o checkout só atende /internal/* quando a chamada prova que veio
//   do shim CHECKOUT_SERVICE:
//     1. O roteador gera uma chave aleatória por isolate e a entrega ao
//        checkout em env.__INTERNAL_KEY (apenas no env do checkout).
//     2. Nas chamadas do shim, o roteador envia o cabeçalho
//        `x-internal-call: <chave>`.
//     3. O roteador remove `x-internal-call` de toda requisição pública antes
//        de despachá-la a qualquer módulo.
//   Sem env.__INTERNAL_KEY (ausente ou com menos de 16 caracteres) ou com
//   cabeçalho diferente, /internal/* responde 404, como se a rota não
//   existisse. A comparação da chave é feita em tempo constante.
// =====================================================

export const INTERNAL_CALL_HEADER = 'x-internal-call';

export function isAuthorizedInternalCall(request, env) {
  const key = env && typeof env.__INTERNAL_KEY === 'string' ? env.__INTERNAL_KEY : '';
  if (key.length < 16) return false;
  const provided = request.headers.get(INTERNAL_CALL_HEADER) || '';
  return constantTimeEqual(provided, key);
}

function internalNotFound() {
  return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
}

// Chamado exclusivamente pelo dashboard através do shim CHECKOUT_SERVICE
// (ver contrato acima): o roteador bloqueia /internal para o público e o
// fetch do checkout exige o cabeçalho interno antes de chegar aqui.
async function handleDashboardRefund(request, env) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 2048) return json({ ok: false, error: 'payload_too_large' }, 413);

  let body = null;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }
  const leadId = Number(body && body.lead_id);
  const operationId = String((body && body.operation_id) || '');
  if (!Number.isInteger(leadId) || leadId <= 0) {
    return json({ ok: false, error: 'invalid_lead_id' }, 400);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
    return json({ ok: false, error: 'invalid_operation_id' }, 400);
  }

  const payment = await env.DB.prepare(
    `SELECT id, lead_id, mp_payment_id, status, amount_cents
       FROM payments
      WHERE lead_id = ? AND status = 'approved'
      ORDER BY COALESCE(approved_at, updated_at) DESC, id DESC
      LIMIT 1`
  ).bind(leadId).first();

  if (!payment || !/^\d{1,32}$/.test(String(payment.mp_payment_id || ''))) {
    const previous = await env.DB.prepare(
      `SELECT pr.status, pr.refund_id, pr.amount_cents
         FROM payment_refunds pr
        WHERE pr.lead_id = ?
        ORDER BY pr.id DESC LIMIT 1`
    ).bind(leadId).first();
    if (previous && previous.status === 'approved') {
      return json({ ok: true, already_refunded: true, status: 'approved', refund_id: previous.refund_id || null, amount_cents: previous.amount_cents ?? null });
    }
    if (previous && (previous.status === 'requested' || previous.status === 'in_process')) {
      return json({ ok: true, processing: true, status: previous.status, refund_id: previous.refund_id || null, amount_cents: previous.amount_cents ?? null }, 202);
    }
    return json({ ok: false, error: 'sale_not_refundable', message: 'Esta venda não possui um pagamento aprovado do Mercado Pago disponível para reembolso.' }, 409);
  }

  let currentPayment;
  try {
    currentPayment = await getMpPayment(env, payment.mp_payment_id);
  } catch (err) {
    console.error(JSON.stringify({ message: 'mercado_pago_refund_lookup_failed', payment_id: payment.id, error: String(err && err.message || err).slice(0, 160) }));
    return json({ ok: false, error: 'mercado_pago_unavailable', message: 'Não foi possível consultar o pagamento no Mercado Pago. Tente novamente.' }, 502);
  }

  const currentStatus = String((currentPayment && currentPayment.status) || '').toLowerCase();
  if (currentStatus === 'refunded') {
    await processPaymentUpdate(env, null, request, currentPayment);
    return json({ ok: true, already_refunded: true, status: 'approved', amount_cents: payment.amount_cents });
  }
  if (currentStatus !== 'approved') {
    await processPaymentUpdate(env, null, request, currentPayment);
    return json({ ok: false, error: 'payment_not_approved', message: 'O pagamento não está aprovado no Mercado Pago e não pode ser reembolsado agora.' }, 409);
  }

  const claim = await claimPaymentRefund(env, payment, operationId);
  if (!claim.claimed) {
    if (claim.status === 'approved') {
      return json({ ok: true, already_refunded: true, status: 'approved', refund_id: claim.refund_id || null, amount_cents: claim.amount_cents ?? payment.amount_cents });
    }
    if (claim.status === 'requested' || claim.status === 'in_process') {
      return json({ ok: true, processing: true, status: claim.status, refund_id: claim.refund_id || null, amount_cents: claim.amount_cents ?? payment.amount_cents }, 202);
    }
    return json({ ok: false, error: 'refund_conflict', message: 'Já existe outra tentativa de reembolso para este pagamento.' }, 409);
  }

  let refund;
  try {
    refund = await createMpFullRefund(env, payment.mp_payment_id, operationId);
  } catch (err) {
    const detail = String(err && err.message || err).slice(0, 300);
    await updatePaymentRefund(env, payment.id, {
      status: 'failed', errorCode: err && err.mpCode, errorDetail: detail, completed: true,
    });
    console.error(JSON.stringify({ message: 'mercado_pago_refund_failed', payment_id: payment.id, mp_status: err && err.mpStatus, code: err && err.mpCode }));
    return json({ ok: false, error: 'mercado_pago_refund_failed', message: detail }, 502);
  }

  const refundId = refund && refund.id != null ? String(refund.id) : null;
  const amountCents = Number.isFinite(Number(refund && refund.amount))
    ? Math.round(Number(refund.amount) * 100)
    : payment.amount_cents;
  const refundStatus = String((refund && refund.status) || '').toLowerCase();
  const completed = refundStatus === 'approved';

  if (completed) {
    // A resposta do endpoint de reembolso já confirmou a operação. Atualizamos
    // imediatamente payments/orders; o webhook posterior é idempotente.
    await processPaymentUpdate(env, null, request, { ...currentPayment, id: payment.mp_payment_id, status: 'refunded' });
  }
  await updatePaymentRefund(env, payment.id, {
    status: completed ? 'approved' : 'in_process',
    refundId,
    amountCents,
    completed,
  });

  return json({
    ok: true,
    processing: !completed,
    status: completed ? 'approved' : 'in_process',
    refund_id: refundId,
    payment_id: String(payment.mp_payment_id),
    amount_cents: amountCents,
  }, completed ? 200 : 202);
}

// =====================================================
//              Lead helpers
// =====================================================

function buildLeadEventId(leadId) {
  return leadId ? ('lead-' + leadId) : null;
}

function fireLeadCapi(request, env, ctx, { offer, leadId, name, email, phone }) {
  const eventId = buildLeadEventId(leadId);
  if (!eventId) return;
  const { pixel_id, access_token } = offerCapi(offer);
  const task = sendMetaCapiEvent(request, env, {
    event_name: 'Lead',
    event_id: eventId,
    pixel_id,
    access_token,
    custom_data: {
      value: offer ? offer.sale_price_cents / 100 : undefined,
      currency: 'BRL',
      content_name: offer ? offer.name : undefined,
    },
    email, phone, name,
  }).catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
}

// Extrai os IDs de atribuição Meta do body do checkout (vindos da URL da LP:
// &meta_campaign_id={{campaign.id}}&meta_adset_id={{adset.id}}&meta_ad_id={{ad.id}};
// fbclid a Meta anexa sozinha no clique). Atribuição por ID é robusta a renomear
// anúncio (o nome em utm_term pode mudar; o ID não).
function readMetaIds(data) {
  return {
    meta_campaign_id: clean(data && data.meta_campaign_id, 40) || null,
    meta_adset_id: clean(data && data.meta_adset_id, 40) || null,
    meta_ad_id: clean(data && data.meta_ad_id, 40) || null,
    fbclid: clean(data && data.fbclid, 255) || null,
  };
}

// Esta pessoa já tem uma compra APROVADA desta mesma oferta? Match por pessoa
// (telefone normalizado > e-mail) cruzando `payments` aprovados da mesma offer_id.
// Usado pra impedir que um comprador volte ao checkout e gere um 2º Pix (o que
// criaria uma lead nova 'pix_gerado' e faria a venda aparecer como "pix gerado"
// de novo no /vendas). Defensivo: nunca lança.
async function findPaidPaymentForOffer(env, { phone, email, offerId }) {
  try {
    if (!offerId) return null;
    const pn = normalizePhone(phone);
    const pnBind = pn.length >= 10 ? pn : '';
    const em = String(email || '').trim().toLowerCase();
    if (!pnBind && !em) return null;
    const row = await env.DB.prepare(
      `SELECT p.mp_payment_id AS pid, p.lead_id AS lead_id
         FROM payments p
         JOIN leads l ON l.id = p.lead_id
        WHERE p.offer_id = ? AND p.status = 'approved'
          AND ( (? != '' AND l.phone_norm = ?) OR (? != '' AND LOWER(l.email) = ?) )
        ORDER BY p.approved_at DESC, p.id DESC
        LIMIT 1`
    ).bind(offerId, pnBind, pnBind, em, em).first();
    return row && row.pid ? { paymentId: row.pid, leadId: row.lead_id || null } : null;
  } catch (_) {
    return null;
  }
}

async function upsertLead(env, request, { name, email, phone, status, offer, utms, funnel, utmPage: utmPageInput, metaIds }) {
  const ip = request.headers.get('cf-connecting-ip') || '';
  const ua = (request.headers.get('user-agent') || '').slice(0, 500);
  const utmPage = clean(utmPageInput, MAX.utm) || refererPathSameOrigin(request) || '/checkout';
  const now = nowBrasilia();
  const m = metaIds || {};
  const phoneNorm = normalizePhone(phone) || null;

  // Dedup canônico: telefone > email (sem IP, ver resolveLeadId).
  let leadId = await resolveLeadId(env, { phone, email });
  if (leadId) {
    const upd = await env.DB.prepare(
      `UPDATE leads SET
         name = ?, email = ?, phone = ?, phone_norm = COALESCE(?, phone_norm), status = ?,
         method = COALESCE(?, method),
         utm_source = COALESCE(?, utm_source),
         utm_medium = COALESCE(?, utm_medium),
         utm_campaign = COALESCE(?, utm_campaign),
         utm_term = COALESCE(?, utm_term),
         utm_content = COALESCE(?, utm_content),
         utm_page = COALESCE(utm_page, ?),
         funnel = COALESCE(funnel, ?),
         meta_campaign_id = COALESCE(meta_campaign_id, ?),
         meta_adset_id = COALESCE(meta_adset_id, ?),
         meta_ad_id = COALESCE(meta_ad_id, ?),
         fbclid = COALESCE(fbclid, ?),
         product = ?,
         updated_at = ?
       WHERE id = ? AND status != 'comprou'`
    ).bind(
      name, email, phone, phoneNorm, status,
      status === 'comprou' ? 'Pix' : null,
      utms.utm_source, utms.utm_medium, utms.utm_campaign, utms.utm_term, utms.utm_content,
      utmPage, funnel,
      m.meta_campaign_id || null, m.meta_adset_id || null, m.meta_ad_id || null, m.fbclid || null,
      offer ? offer.code : null, now, leadId
    ).run();
    const changes = (upd && upd.meta && upd.meta.changes) || 0;
    if (changes > 0) return leadId;
  }

  if (status === 'comprou') {
    const existing = await findRecentPurchaseLeadId(env, { ip, email });
    if (existing) return existing;
  }

  const ins = await env.DB.prepare(
    'INSERT INTO leads (name, email, phone, phone_norm, method, status, utm_source, utm_medium, utm_campaign, utm_term, utm_content, ip, user_agent, created_at, updated_at, funnel, utm_page, product, meta_campaign_id, meta_adset_id, meta_ad_id, fbclid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    name, email, phone, phoneNorm, status === 'comprou' ? 'Pix' : '', status,
    utms.utm_source, utms.utm_medium, utms.utm_campaign, utms.utm_term, utms.utm_content,
    ip, ua, now, now, funnel, utmPage, offer ? offer.code : null,
    m.meta_campaign_id || null, m.meta_adset_id || null, m.meta_ad_id || null, m.fbclid || null
  ).run();
  return (ins && ins.meta && ins.meta.last_row_id) || null;
}

// =====================================================
//              /api/checkout (legado: progressao do lead)
// =====================================================

async function handleCheckout(request, env, ctx) {
  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const status = clean(data.status, MAX.status);
  // 'reembolsado' nunca é aceito aqui (só o fluxo interno de reembolso grava).
  if (!VALID_LEAD_STATUSES.has(status)) return json({ ok: false, error: 'invalid_status' }, 400);

  const name = clean(data.name, MAX.name);
  const email = clean(data.email, MAX.email);
  const phone = clean(data.phone, MAX.phone);

  if (status === 'comprou') {
    if (!name || !email || !phone) return json({ ok: false, error: 'missing_fields' }, 400);
    if (!isValidCheckoutEmail(email)) return json({ ok: false, error: 'invalid_email' }, 400);
  } else if (!name) {
    return json({ ok: false, error: 'missing_name' }, 400);
  }

  const utms = {};
  for (const key of UTM_KEYS) utms[key] = clean(data[key], MAX.utm) || null;
  const utmPage = getUtmPage(request, data && data.utm_page) || '/checkout';
  const rawFunnel = clean(data.funnel, 40);
  const funnel = rawFunnel && /^[a-z0-9_-]{1,40}$/i.test(rawFunnel) ? rawFunnel.toLowerCase() : null;
  const rawOfferCode = clean(data.offer_code, 64);
  const offerCode = rawOfferCode && /^[a-z0-9_-]{1,64}$/i.test(rawOfferCode) ? rawOfferCode.toLowerCase() : null;
  const offer = offerCode ? await loadOfferByCode(env, offerCode) : null;
  // 'comprou' pelo endpoint público só existe no checkout fake (oferta
  // out_of_stock). Compra real nasce do pagamento aprovado, nunca daqui.
  if (status === 'comprou' && !(offer && offer.out_of_stock)) {
    return json({ ok: false, error: 'invalid_status' }, 400);
  }
  if (status === 'comprou' && offer?.out_of_stock && Number.isInteger(Number(data.id)) && Number(data.id) > 0) {
    try {
      const recorded = await env.DB.prepare(`SELECT f.lead_id FROM fake_checkout_purchases f JOIN leads l ON l.id = f.lead_id
        WHERE f.lead_id = ? AND f.offer_code = ? AND l.product = ? AND l.email = ? AND l.phone_norm = ? LIMIT 1`)
        .bind(Number(data.id), offer.code, offer.code, email, normalizePhone(phone)).first();
      if (recorded) return json({ ok: true, id: recorded.lead_id });
    } catch (err) {
      console.error('[checkout] fake purchase lookup failed', String(err && err.message || err).slice(0, 300));
      return json({ ok: false, error: 'db_error' }, 500);
    }
  }
  const fakeResult = status === 'comprou' ? buildFakePurchase(offer, data) : null;
  if (fakeResult && !fakeResult.ok) return json(fakeResult, fakeResult.error === 'price_changed' ? 409 : 400);

  const ip = request.headers.get('cf-connecting-ip') || '';
  const ua = (request.headers.get('user-agent') || '').slice(0, 500);
  const rawId = data.id == null ? NaN : (typeof data.id === 'number' ? data.id : parseInt(data.id, 10));
  const incomingId = Number.isFinite(rawId) && rawId > 0 ? rawId : null;

  let resultId = null;
  try {
    const now = nowBrasilia();

    // Progride um lead existente (sem nunca rebaixar quem já comprou). Reaproveitado
    // tanto pelo id da sessão do browser quanto pelo dedup por pessoa abaixo.
    const tryProgress = async (id) => {
      if (!id) return false;
      const upd = await env.DB.prepare(
        `UPDATE leads SET
           name = ?, email = ?, phone = ?, phone_norm = COALESCE(?, phone_norm), status = ?,
           utm_source = COALESCE(?, utm_source),
           utm_medium = COALESCE(?, utm_medium),
           utm_campaign = COALESCE(?, utm_campaign),
           utm_term = COALESCE(?, utm_term),
           utm_content = COALESCE(?, utm_content),
           utm_page = COALESCE(utm_page, ?),
           funnel = COALESCE(funnel, ?),
           product = COALESCE(?, product),
           updated_at = ?
         WHERE id = ? AND status != 'comprou'${fakeResult ? ' AND (product IS NULL OR product = ?) AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.lead_id = leads.id)' : ''}`
      ).bind(
        name, email, phone, normalizePhone(phone) || null, status,
        utms.utm_source, utms.utm_medium, utms.utm_campaign, utms.utm_term, utms.utm_content,
        utmPage, funnel, offerCode, now, id, ...(fakeResult ? [offerCode] : [])
      ).run();
      return ((upd && upd.meta && upd.meta.changes) || 0) > 0;
    };
    // Se o UPDATE não bateu, o lead pode já estar 'comprou' (re-clique/retry):
    // devolve o id existente sem inserir de novo.
    const reuseIfBought = async (id) => {
      if (!id) return null;
      const already = await env.DB.prepare(
        `SELECT id FROM leads WHERE id = ? AND status = 'comprou'${fakeResult ? ' AND product = ? AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.lead_id = leads.id)' : ''}`
      ).bind(id, ...(fakeResult ? [offerCode] : [])).first();
      return already && already.id ? already.id : null;
    };

    // 1) Reusa pelo id da sessão do browser (incomingId), quando o front mandou.
    if (incomingId) {
      if (await tryProgress(incomingId)) resultId = incomingId;
      else resultId = await reuseIfBought(incomingId);
    }

    // 2) Sem id utilizável: dedup por pessoa (telefone > e-mail), igual ao
    //    upsertLead do fluxo de pagamento. Sem isso, cada etapa de preenchimento
    //    (nome/e-mail/telefone) criava uma lead nova quando o id ainda não tinha
    //    voltado pro front (rajada de blur/autofill), gerando 2-3 linhas da mesma
    //    pessoa no /vendas.
    if (!resultId) {
      const personId = await resolveLeadId(env, { phone, email });
      if (personId) {
        if (await tryProgress(personId)) resultId = personId;
        else resultId = await reuseIfBought(personId);
      }
    }

    // 3) Nada encontrado: insere lead nova.
    if (!resultId) {
      const ins = await env.DB.prepare(
        'INSERT INTO leads (name, email, phone, phone_norm, method, status, utm_source, utm_medium, utm_campaign, utm_term, utm_content, ip, user_agent, created_at, updated_at, funnel, utm_page, product) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        name, email, phone, normalizePhone(phone) || null, '', status,
        utms.utm_source, utms.utm_medium, utms.utm_campaign, utms.utm_term, utms.utm_content,
        ip, ua, now, now, funnel, utmPage, offerCode
      ).run();
      resultId = (ins && ins.meta && ins.meta.last_row_id) || null;
    }
    if (fakeResult && resultId) {
      const p = fakeResult.purchase;
      // Immutable, offer-scoped simulated intent; never a payment or delivery trigger.
      await env.DB.prepare(`INSERT INTO fake_checkout_purchases
        (lead_id, offer_id, offer_code, offer_name_snapshot, method, base_price_cents, total_cents, bumps_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(lead_id, offer_code) DO NOTHING`).bind(
          resultId, p.offer_id, p.offer_code, p.offer_name, p.method, p.base_price_cents, p.total_cents, JSON.stringify(p.bumps), now
        ).run();
      await env.DB.prepare(`UPDATE leads SET method = (SELECT method FROM fake_checkout_purchases WHERE lead_id = ? AND offer_code = ?)
        WHERE id = ? AND product = ?`).bind(resultId, p.offer_code, resultId, p.offer_code).run();
    }
  } catch (err) {
    console.error('[checkout] lead progression failed', String(err && err.message || err).slice(0, 300));
    return json({ ok: false, error: 'db_error' }, 500);
  }

  return json({ ok: true, id: resultId });
}

// =====================================================
//              /api/mp/create-pix
// =====================================================

async function handleCreatePix(request, env, ctx) {
  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const offerCode = clean(data.offer_code, 64);
  if (!isValidOfferCode(offerCode)) return json({ ok: false, error: 'invalid_offer_code' }, 400);
  const offer = await loadOfferByCode(env, offerCode);
  if (!offer) return json({ ok: false, error: 'offer_not_found' }, 404);
  const selection = resolveCheckoutSelection(offer, data.order_bump_ids);
  if (!selection.ok) return json({ ok: false, error: selection.error }, 400);
  if (data.expected_total_cents != null) {
    const expectedTotal = Number(data.expected_total_cents);
    if (!Number.isInteger(expectedTotal) || expectedTotal !== selection.total_cents) {
      return json({ ok: false, error: 'price_changed', amount_cents: selection.total_cents }, 409);
    }
  }

  const name = clean(data.name, MAX.name);
  const email = clean(data.email, MAX.email);
  const phone = clean(data.phone, MAX.phone);
  if (!name || !email || !phone) return json({ ok: false, error: 'missing_fields' }, 400);
  if (!isValidCheckoutEmail(email)) return json({ ok: false, error: 'invalid_email' }, 400);

  const utms = {};
  for (const key of UTM_KEYS) utms[key] = clean(data[key], MAX.utm) || null;
  const utmPage = clean(data && data.utm_page, MAX.utm) || null;
  const metaIds = readMetaIds(data);
  const rawFunnel = clean(data.funnel, 40);
  const funnel = rawFunnel && /^[a-z0-9_-]{1,40}$/i.test(rawFunnel) ? rawFunnel.toLowerCase() : null;

  // Já comprou este produto: não gera 2º Pix. Manda o front pra /obrigado.
  // Sem payment_id/lead_id: quem chama não está autenticado e esses IDs não
  // podem sair para qualquer um que digite o telefone/e-mail de um comprador.
  const alreadyPaid = await findPaidPaymentForOffer(env, { phone, email, offerId: offer.id });
  if (alreadyPaid) {
    return json({ ok: true, already_paid: true });
  }

  let leadId;
  try {
    leadId = await upsertLead(env, request, {
      name, email, phone, status: 'pix_gerado', offer, utms, funnel, utmPage, metaIds,
    });
  } catch (err) {
    console.error('[checkout] lead save failed', String(err && err.message || err).slice(0, 300));
    return json({ ok: false, error: 'lead_save_failed' }, 500);
  }

  const externalRef = 'ord-' + offer.id + '-' + (leadId || 'x') + '-' + randomHex(6);

  const url = new URL(request.url);
  const notificationUrl = (configValue(env.MP_WEBHOOK_BASE) || url.origin) + '/api/mp/webhook';

  let mpPayment;
  try {
    mpPayment = await createMpPixPayment(env, {
      amountCents: selection.total_cents,
      description: offer.name,
      items: buildPaymentItems(offer, selection.selected),
      payerEmail: email,
      payerName: name,
      externalRef,
      notificationUrl: /^https?:\/\/(localhost|127\.)/.test(notificationUrl) ? null : notificationUrl,
      hostname: url.hostname,
    });
  } catch (err) {
    const detail = String(err && err.message || err);
    await logPaymentError(env, request, {
      leadId, offerId: offer.id, stage: 'pix_create',
      errorCode: 'mp_create_failed', errorDetail: detail,
      funnel, utms, utmPage,
    });
    if (err && err.mpStatus == null) console.error('[checkout] pix create failed', detail.slice(0, 300));
    return json({ ok: false, error: 'mp_create_failed', detail: publicGatewayDetail(err) }, 502);
  }

  const txData = (mpPayment && mpPayment.point_of_interaction && mpPayment.point_of_interaction.transaction_data) || {};
  const qrCode = txData.qr_code || '';
  const qrBase64 = txData.qr_code_base64 || '';
  const ticketUrl = txData.ticket_url || '';
  const expiresAt = mpPayment.date_of_expiration || null;

  try {
    const now = nowBrasilia();
    const insertPayment = env.DB.prepare(
      `INSERT INTO payments
        (offer_id, lead_id, mp_payment_id, external_ref, method, status, amount_cents,
         payer_email, payer_name, payer_phone,
         qr_code, qr_code_base64, ticket_url, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pix', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      offer.id, leadId, String(mpPayment.id), externalRef,
      mpPayment.status || 'pending', selection.total_cents,
      email, name, phone,
      qrCode, qrBase64, ticketUrl, expiresAt, now, now
    );
    await env.DB.batch([insertPayment, ...paymentOrderBumpStatements(env, mpPayment.id, selection.selected)]);
  } catch (err) {
    console.error('[checkout] payment save failed', String(err && err.message || err).slice(0, 300));
    return json({ ok: false, error: 'payment_save_failed' }, 500);
  }

  // Dual-write: espelha o pedido em `orders` (fonte canônica). Defensivo.
  await upsertOrder(env, {
    gateway: 'mercadopago', gatewayTxnId: String(mpPayment.id), gatewayOrderRef: externalRef,
    status: mpPayment.status || 'pending', method: 'pix', amountCents: selection.total_cents,
    leadId, offerId: offer.id, funnelSlug: funnel, utms, utmPage,
    metaCampaignId: metaIds.meta_campaign_id, metaAdsetId: metaIds.meta_adset_id, metaAdId: metaIds.meta_ad_id, fbclid: metaIds.fbclid,
    payerName: name, payerEmail: email, payerPhone: phone,
    ip: request.headers.get('cf-connecting-ip') || null,
  });

  fireLeadCapi(request, env, ctx, { offer, leadId, name, email, phone });

  return json({
    ok: true,
    payment_id: String(mpPayment.id),
    qr_code: qrCode,
    qr_code_base64: qrBase64,
    ticket_url: ticketUrl,
    expires_at: expiresAt,
    lead_id: leadId,
    meta_lead_event_id: buildLeadEventId(leadId),
    amount_cents: selection.total_cents,
    order_bumps: selection.selected.map((bump) => ({ id: bump.id, name: bump.name, price_cents: bump.price_cents })),
  });
}

// =====================================================
//              /api/mp/create-card
// =====================================================

async function handleCreateCard(request, env, ctx) {
  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const offerCode = clean(data.offer_code, 64);
  if (!isValidOfferCode(offerCode)) return json({ ok: false, error: 'invalid_offer_code' }, 400);
  const offer = await loadOfferByCode(env, offerCode);
  if (!offer) return json({ ok: false, error: 'offer_not_found' }, 404);
  const selection = resolveCheckoutSelection(offer, data.order_bump_ids);
  if (!selection.ok) return json({ ok: false, error: selection.error }, 400);
  if (data.expected_total_cents != null) {
    const expectedTotal = Number(data.expected_total_cents);
    if (!Number.isInteger(expectedTotal) || expectedTotal !== selection.total_cents) {
      return json({ ok: false, error: 'price_changed', amount_cents: selection.total_cents }, 409);
    }
  }

  const name = clean(data.name, MAX.name);
  const email = clean(data.email, MAX.email);
  const phone = clean(data.phone, MAX.phone);
  if (!name || !email || !phone) return json({ ok: false, error: 'missing_fields' }, 400);
  if (!isValidCheckoutEmail(email)) return json({ ok: false, error: 'invalid_email' }, 400);

  const token = clean(data.token, 128);
  const paymentMethodId = clean(data.payment_method_id, 32);
  const issuerId = clean(data.issuer_id, 32);
  const installments = parseInt(data.installments, 10) || 1;
  const identificationType = clean(data.identification_type, 8) || 'CPF';
  const identificationNumber = String(data.identification_number || '').replace(/\D/g, '').slice(0, 14);
  const cardholderName = clean(data.cardholder_name, MAX.name) || name;

  if (!token) return json({ ok: false, error: 'missing_token' }, 400);
  if (!paymentMethodId) return json({ ok: false, error: 'missing_payment_method' }, 400);
  if (!identificationNumber || identificationNumber.length < 11) return json({ ok: false, error: 'invalid_cpf' }, 400);

  const utms = {};
  for (const key of UTM_KEYS) utms[key] = clean(data[key], MAX.utm) || null;
  const utmPage = clean(data && data.utm_page, MAX.utm) || null;
  const metaIds = readMetaIds(data);
  const rawFunnel = clean(data.funnel, 40);
  const funnel = rawFunnel && /^[a-z0-9_-]{1,40}$/i.test(rawFunnel) ? rawFunnel.toLowerCase() : null;

  // Já comprou este produto: não cobra de novo. Manda o front pra /obrigado
  // (sem payment_id/lead_id, pelo mesmo motivo do create-pix).
  const alreadyPaid = await findPaidPaymentForOffer(env, { phone, email, offerId: offer.id });
  if (alreadyPaid) {
    return json({ ok: true, already_paid: true });
  }

  let leadId;
  try {
    leadId = await upsertLead(env, request, {
      name, email, phone, status: 'pix_gerado', offer, utms, funnel, utmPage, metaIds,
    });
  } catch (err) {
    console.error('[checkout] lead save failed', String(err && err.message || err).slice(0, 300));
    return json({ ok: false, error: 'lead_save_failed' }, 500);
  }

  const externalRef = 'ord-' + offer.id + '-' + (leadId || 'x') + '-' + randomHex(6);

  const url = new URL(request.url);
  const notificationUrl = (configValue(env.MP_WEBHOOK_BASE) || url.origin) + '/api/mp/webhook';

  let mpPayment;
  try {
    mpPayment = await createMpCardPayment(env, {
      amountCents: selection.total_cents,
      description: offer.name,
      items: buildPaymentItems(offer, selection.selected),
      payerEmail: email,
      payerName: cardholderName,
      externalRef,
      notificationUrl: /^https?:\/\/(localhost|127\.)/.test(notificationUrl) ? null : notificationUrl,
      token,
      installments,
      paymentMethodId,
      issuerId: issuerId || null,
      identificationType,
      identificationNumber,
      hostname: url.hostname,
    });
  } catch (err) {
    const detail = String(err && err.message || err);
    await logPaymentError(env, request, {
      leadId, offerId: offer.id, stage: 'card_create',
      errorCode: 'mp_create_failed', errorDetail: detail,
      funnel, utms, utmPage,
    });
    if (err && err.mpStatus == null) console.error('[checkout] card create failed', detail.slice(0, 300));
    return json({ ok: false, error: 'mp_create_failed', detail: publicGatewayDetail(err) }, 502);
  }

  if (mpPayment && (mpPayment.status === 'rejected' || mpPayment.status === 'cancelled')) {
    await logPaymentError(env, request, {
      leadId, offerId: offer.id, stage: 'card_rejected',
      errorCode: mpPayment.status_detail || mpPayment.status,
      errorDetail: mpPayment.status_detail || mpPayment.status,
      funnel, utms, utmPage,
    });
  }

  const initialStatus = initialStoredCardStatus(mpPayment.status);

  try {
    const now = nowBrasilia();
    const insertPayment = env.DB.prepare(
      `INSERT INTO payments
        (offer_id, lead_id, mp_payment_id, external_ref, method, status, amount_cents,
         payer_email, payer_name, payer_phone,
         qr_code, qr_code_base64, ticket_url, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'card', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`
    ).bind(
      offer.id, leadId, String(mpPayment.id), externalRef,
      initialStatus, selection.total_cents,
      email, name, phone,
      now, now
    );
    await env.DB.batch([insertPayment, ...paymentOrderBumpStatements(env, mpPayment.id, selection.selected)]);
  } catch (err) {
    console.error('[checkout] payment save failed', String(err && err.message || err).slice(0, 300));
    return json({ ok: false, error: 'payment_save_failed' }, 500);
  }

  // Dual-write: espelha o pedido em `orders` (fonte canônica). Defensivo.
  await upsertOrder(env, {
    gateway: 'mercadopago', gatewayTxnId: String(mpPayment.id), gatewayOrderRef: externalRef,
    status: initialStatus, method: 'card', amountCents: selection.total_cents,
    installments, leadId, offerId: offer.id, funnelSlug: funnel, utms, utmPage,
    metaCampaignId: metaIds.meta_campaign_id, metaAdsetId: metaIds.meta_adset_id, metaAdId: metaIds.meta_ad_id, fbclid: metaIds.fbclid,
    payerName: name, payerEmail: email, payerPhone: phone,
    ip: request.headers.get('cf-connecting-ip') || null,
  });

  fireLeadCapi(request, env, ctx, { offer, leadId, name, email, phone });

  // If MP already approved synchronously, fire side effects right away (capi, e-mail).
  if (mpPayment && mpPayment.status === 'approved') {
    try { await processPaymentUpdate(env, ctx, request, mpPayment); } catch (_) { /* ignore */ }
  }

  return json({
    ok: true,
    payment_id: String(mpPayment.id),
    status: mpPayment.status || 'pending',
    status_detail: mpPayment.status_detail || null,
    lead_id: leadId,
    meta_lead_event_id: buildLeadEventId(leadId),
    amount_cents: selection.total_cents,
    order_bumps: selection.selected.map((bump) => ({ id: bump.id, name: bump.name, price_cents: bump.price_cents })),
  });
}

// =====================================================
//              /api/mp/status
// =====================================================

async function handleMpStatus(request, env, ctx) {
  const url = new URL(request.url);
  const paymentId = clean(url.searchParams.get('payment_id'), 64);
  if (!paymentId) return json({ ok: false, error: 'missing_payment_id' }, 400);

  const row = await env.DB
    .prepare('SELECT id, mp_payment_id, status, amount_cents, meta_event_id FROM payments WHERE mp_payment_id = ? LIMIT 1')
    .bind(paymentId)
    .first();
  if (!row) return json({ ok: false, error: 'not_found' }, 404);

  // If still pending, ask MP for fresh status
  if (row.status !== 'approved' && row.status !== 'rejected' && row.status !== 'cancelled') {
    try {
      const mp = await getMpPayment(env, paymentId);
      if (mp && mp.status && mp.status !== row.status) {
        await processPaymentUpdate(env, ctx, request, mp);
        const fresh = await env.DB
          .prepare('SELECT id, mp_payment_id, status, amount_cents, meta_event_id FROM payments WHERE mp_payment_id = ? LIMIT 1')
          .bind(paymentId).first();
        if (fresh) Object.assign(row, fresh);
      }
    } catch (_) { /* ignore */ }
  }

  return json({
    ok: true,
    payment_id: row.mp_payment_id,
    status: row.status,
    amount_cents: row.amount_cents,
    meta_event_id: row.meta_event_id || null,
  });
}

// =====================================================
//              processa update (webhook + polling)
// =====================================================

async function processPaymentUpdate(env, ctx, request, mp) {
  const mpId = String(mp.id);
  const row = await env.DB
    .prepare(`SELECT p.*, o.name AS offer_name, o.code AS offer_code, o.meta_pixel_id AS offer_meta_pixel_id, o.meta_capi_token AS offer_capi_token
              FROM payments p
              LEFT JOIN offers o ON o.id = p.offer_id
              WHERE p.mp_payment_id = ? LIMIT 1`)
    .bind(mpId)
    .first();
  if (!row) return false;

  const newStatus = mp.status || row.status;
  const wasApproved = row.status === 'approved';
  const wasRejected = row.status === 'rejected' || row.status === 'cancelled';
  const nowAt = nowBrasilia();

  await env.DB.prepare('UPDATE payments SET status = ?, updated_at = ? WHERE id = ?')
    .bind(newStatus, nowAt, row.id).run();

  // Reembolso que começou como `in_process` é concluído pelo webhook/polling.
  // Se a operação não veio do dashboard, não haverá linha e o UPDATE é inócuo.
  if (newStatus === 'refunded') {
    await env.DB.prepare(
      `UPDATE payment_refunds
          SET status = 'approved', completed_at = COALESCE(completed_at, ?), updated_at = ?
        WHERE payment_id = ? AND status IN ('requested','in_process')`
    ).bind(nowAt, nowAt, row.id).run();
  }

  // Dual-write: espelha a transição de status em `orders` (fonte canônica).
  // approved -> upsertOrder grava approved_at/side_effects_at/meta_event_id;
  // refunded/chargeback -> grava refunded_at. Defensivo (nunca lança).
  // Passa atribuição do lead pra que o order fique atribuído mesmo se o webhook
  // criar a linha antes do create-pix/card (race / falha transitória).
  let ordFunnel = null, ordUtmPage = null, ordUtms = {}, ordIp = null, ordMeta = {};
  if (row.lead_id) {
    const ll = await env.DB.prepare(
      'SELECT ip, funnel, utm_source, utm_medium, utm_campaign, utm_term, utm_content, utm_page, meta_campaign_id, meta_adset_id, meta_ad_id, fbclid FROM leads WHERE id = ?'
    ).bind(row.lead_id).first();
    if (ll) {
      ordFunnel = ll.funnel; ordUtmPage = ll.utm_page; ordIp = ll.ip;
      ordUtms = {
        utm_source: ll.utm_source, utm_medium: ll.utm_medium,
        utm_campaign: ll.utm_campaign, utm_term: ll.utm_term, utm_content: ll.utm_content,
      };
      ordMeta = {
        meta_campaign_id: ll.meta_campaign_id, meta_adset_id: ll.meta_adset_id,
        meta_ad_id: ll.meta_ad_id, fbclid: ll.fbclid,
      };
    }
  }
  const ordRes = await upsertOrder(env, {
    gateway: 'mercadopago', gatewayTxnId: mpId, gatewayOrderRef: row.external_ref,
    status: newStatus, method: row.method === 'card' ? 'card' : 'pix',
    amountCents: row.amount_cents, leadId: row.lead_id, offerId: row.offer_id,
    funnelSlug: ordFunnel, utms: ordUtms, utmPage: ordUtmPage, ip: ordIp,
    metaCampaignId: ordMeta.meta_campaign_id, metaAdsetId: ordMeta.meta_adset_id, metaAdId: ordMeta.meta_ad_id, fbclid: ordMeta.fbclid,
    payerName: row.payer_name, payerEmail: row.payer_email, payerPhone: row.payer_phone,
    metaEventId: newStatus === 'approved' ? (row.meta_event_id || ('purchase-' + mpId)) : null,
  });

  if ((newStatus === 'rejected' || newStatus === 'cancelled') && !wasRejected && row.method === 'card') {
    let leadCtx = { funnel: null, utms: {}, utmPage: null };
    if (row.lead_id) {
      const l = await env.DB.prepare(
        'SELECT funnel, utm_source, utm_medium, utm_campaign, utm_term, utm_content, utm_page FROM leads WHERE id = ?'
      ).bind(row.lead_id).first();
      if (l) {
        leadCtx.funnel = l.funnel;
        leadCtx.utmPage = l.utm_page;
        leadCtx.utms = {
          utm_source: l.utm_source, utm_medium: l.utm_medium,
          utm_campaign: l.utm_campaign, utm_term: l.utm_term, utm_content: l.utm_content,
        };
      }
    }
    await logPaymentError(env, request, {
      leadId: row.lead_id, offerId: row.offer_id, stage: 'card_rejected',
      errorCode: mp.status_detail || newStatus,
      errorDetail: mp.status_detail || newStatus,
      funnel: leadCtx.funnel, utms: leadCtx.utms, utmPage: leadCtx.utmPage,
    });
  }

  if (newStatus === 'approved' && !wasApproved) {
    const eventId = row.meta_event_id || ('purchase-' + mpId);
    await env.DB.prepare(`UPDATE payments SET approved_at = ?, notified_at = COALESCE(notified_at, ?), meta_event_id = COALESCE(meta_event_id, ?) WHERE id = ?`)
      .bind(nowAt, nowAt, eventId, row.id).run();

    // A compra é registrada só em `orders` (fonte única). NÃO escrevemos
    // leads.status='comprou': o lead fica como identidade/contato (status
    // permanece em 'pix_gerado', que as etapas de funil já contam). Atualiza só o
    // método pra exibição.
    const methodForLead = methodLabel(row.method);
    if (row.lead_id) {
      await env.DB.prepare(`UPDATE leads SET method = ?, updated_at = ? WHERE id = ?`)
        .bind(methodForLead, nowAt, row.lead_id).run();
    }

    // Efeitos pós-compra (CAPI Purchase + e-mail transacional).
    // Gate de idempotência: firePurchaseEffects faz compare-and-set em
    // orders.side_effects_at, então só dispara 1x mesmo com webhook + polling.
    let orderId = ordRes && ordRes.id;
    if (!orderId) {
      const ro = await env.DB.prepare(
        "SELECT id FROM orders WHERE gateway='mercadopago' AND gateway_txn_id = ? LIMIT 1"
      ).bind(mpId).first();
      orderId = ro && ro.id;
    }
    const eff = firePurchaseEffects(env, request, orderId);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(eff);
    else await eff;
  }

  return true;
}

// =====================================================
//   Efeitos pós-compra: CAPI Purchase e e-mail transacional.
//   Lê tudo de `orders` + `offers`. Idempotente via compare-and-set em
//   orders.side_effects_at: só dispara quando consegue carimbar a linha
//   (status='approved' e ainda NULL).
// =====================================================

const ORDER_EFFECTS_COLUMNS = `ord.id, ord.status, ord.method, ord.amount_cents, ord.meta_event_id,
              ord.lead_id, ord.offer_id,
              ord.payer_name, ord.payer_email, ord.payer_phone,
              of.name AS offer_name, of.code AS offer_code,
              of.email_enabled AS offer_email_enabled, of.email_subject AS offer_email_subject,
              of.email_body AS offer_email_body, of.email_access_url AS offer_email_access_url,
              of.meta_pixel_id AS offer_meta_pixel_id, of.meta_capi_token AS offer_capi_token`;

function offerEmailFields(o) {
  return {
    name: o.offer_name || o.offer_code || '',
    email_subject: o.offer_email_subject || null,
    email_body: o.offer_email_body || null,
    email_access_url: o.offer_email_access_url || null,
  };
}

// Envia o e-mail de confirmação de compra de um pedido e registra o resultado
// em purchase_dispatches (channel='email'). Nunca lança: devolve
// { status, destination, error } com status 'sent' | 'delivered' | 'queued' |
// 'failed' | 'skipped'. Quem chama decide se a oferta tem e-mail habilitado.
async function dispatchPurchaseEmail(env, o, { triggeredBy = 'auto', fetchImpl } = {}) {
  const destination = String(o.payer_email || '').trim() || null;
  const disp = {
    order_id: o.id, lead_id: o.lead_id, offer_id: o.offer_id,
    channel: 'email', triggered_by: triggeredBy, destination,
  };
  let outcome;
  if (!destination) {
    outcome = { status: 'skipped', destination, error: 'sem_email' };
  } else if (!isEmailConfigured(env)) {
    outcome = { status: 'skipped', destination, error: 'email_nao_configurado' };
  } else {
    try {
      const message = buildPurchaseEmail({
        name: o.payer_name,
        email: destination,
        offer: offerEmailFields(o),
        from: env.EMAIL_FROM,
        brand: env.BRAND_NAME,
      });
      const result = await sendTransactionalEmail({ env, message, fetchImpl });
      outcome = { status: result.status, destination, error: null, transport: result.transport };
    } catch (e) {
      outcome = { status: 'failed', destination, error: String(e && e.message || e).slice(0, 300) };
    }
  }
  await logDispatch(env, {
    ...disp,
    status: outcome.status,
    message: outcome.transport ? ('transport=' + outcome.transport + ';status=' + outcome.status) : null,
    error: outcome.error,
  });
  return outcome;
}

async function firePurchaseEffects(env, request, orderId) {
  if (!orderId) return;
  try {
    const o = await env.DB.prepare(
      `SELECT ${ORDER_EFFECTS_COLUMNS}
         FROM orders ord LEFT JOIN offers of ON of.id = ord.offer_id
        WHERE ord.id = ? LIMIT 1`
    ).bind(orderId).first();
    if (!o || o.status !== 'approved') return;

    // Compare-and-set: carimba side_effects_at só se ainda for NULL. Se outro
    // disparo (webhook/polling) já carimbou, changes=0 e a gente para aqui.
    const cas = await env.DB.prepare(
      `UPDATE orders SET side_effects_at = ? WHERE id = ? AND status = 'approved' AND side_effects_at IS NULL`
    ).bind(nowBrasilia(), orderId).run();
    if (!cas || !cas.meta || (cas.meta.changes || 0) < 1) return;

    const eventId = o.meta_event_id || ('purchase-order-' + orderId);
    const disp = { order_id: o.id, lead_id: o.lead_id, offer_id: o.offer_id, triggered_by: 'auto' };

    // Meta CAPI Purchase (pixel/token da oferta, com fallback da instância).
    try {
      const capiResult = await sendMetaCapiEvent(request, env, {
        event_name: 'Purchase',
        event_id: eventId,
        pixel_id: o.offer_meta_pixel_id || null,
        access_token: o.offer_capi_token || null,
        custom_data: {
          value: (o.amount_cents || 0) / 100,
          currency: 'BRL',
          content_name: o.offer_name || o.offer_code,
          content_type: 'product',
          payment_method: o.method === 'card' ? 'credit_card' : (o.method || 'pix'),
        },
        email: o.payer_email,
        phone: o.payer_phone,
        name: o.payer_name,
      });
      const outcome = metaCapiDispatchOutcome(capiResult);
      await logDispatch(env, {
        ...disp,
        channel: 'capi',
        status: outcome.status,
        destination: o.payer_email || o.payer_phone || null,
        error: outcome.error,
      });
    } catch (e) {
      await logDispatch(env, { ...disp, channel: 'capi', status: 'failed', destination: o.payer_email || o.payer_phone || null, error: String(e && e.message || e).slice(0, 300) });
    }

    // E-mail transacional de confirmação (só se a oferta tiver e-mail habilitado).
    if (Number(o.offer_email_enabled) === 1) {
      await dispatchPurchaseEmail(env, o, { triggeredBy: 'auto' });
    }
  } catch (_) { /* nunca derruba o fluxo */ }
}

// =====================================================
//              /internal/dashboard/resend-email
//
//   Reenvio manual do e-mail de confirmação de compra, pedido pelo dashboard.
//   Alcançável apenas pelo shim CHECKOUT_SERVICE do roteador (/internal é
//   bloqueado publicamente), assim o dashboard nunca vê os segredos de e-mail.
//
//   Contrato:
//     POST  body JSON { "lead_id": <inteiro > 0> }
//     200   { ok: true,  status: 'sent'|'delivered'|'queued', destination }
//     400   { ok: false, error: 'invalid_json' | 'invalid_lead_id' }
//     404   { ok: false, error: 'order_not_found' }   lead sem pedido aprovado
//     409   { ok: false, error: 'email_disabled' }    oferta com e-mail desligado
//     409   { ok: false, error: 'no_email' }          pedido/lead sem e-mail
//     413   { ok: false, error: 'payload_too_large' }
//     502   { ok: false, error: 'email_send_failed', message, destination }
//     503   { ok: false, error: 'email_nao_configurado' }
//   Usa o pedido aprovado mais recente do lead. Toda tentativa que chega ao
//   envio (inclusive a falta de configuração) é registrada em
//   purchase_dispatches com channel='email' e triggered_by='manual'.
// =====================================================

export async function handleResendPurchaseEmail(request, env, { fetchImpl } = {}) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 2048) return json({ ok: false, error: 'payload_too_large' }, 413);

  let body = null;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }
  const leadId = Number(body && body.lead_id);
  if (!Number.isInteger(leadId) || leadId <= 0) {
    return json({ ok: false, error: 'invalid_lead_id' }, 400);
  }

  const o = await env.DB.prepare(
    `SELECT ${ORDER_EFFECTS_COLUMNS}, l.email AS lead_email
       FROM orders ord
       LEFT JOIN offers of ON of.id = ord.offer_id
       LEFT JOIN leads l ON l.id = ord.lead_id
      WHERE ord.lead_id = ? AND ord.status = 'approved'
      ORDER BY COALESCE(ord.approved_at, ord.updated_at) DESC, ord.id DESC
      LIMIT 1`
  ).bind(leadId).first();
  if (!o) {
    return json({ ok: false, error: 'order_not_found', message: 'Este lead não possui pedido aprovado.' }, 404);
  }
  if (Number(o.offer_email_enabled) !== 1) {
    return json({ ok: false, error: 'email_disabled', message: 'O e-mail de confirmação está desligado nesta oferta.' }, 409);
  }
  const order = { ...o, payer_email: String(o.payer_email || '').trim() || String(o.lead_email || '').trim() || null };
  if (!order.payer_email) {
    return json({ ok: false, error: 'no_email', message: 'O pedido não tem e-mail de destino.' }, 409);
  }

  const outcome = await dispatchPurchaseEmail(env, order, { triggeredBy: 'manual', fetchImpl });
  if (outcome.status === 'skipped') {
    return json({ ok: false, error: outcome.error, message: 'O envio de e-mail não está configurado.' }, 503);
  }
  if (outcome.status === 'failed') {
    return json({ ok: false, error: 'email_send_failed', message: outcome.error, destination: outcome.destination }, 502);
  }
  return json({ ok: true, status: outcome.status, destination: outcome.destination });
}

// =====================================================
//              /api/mp/_debug_approve
//   Endpoint protegido por secret pra testes E2E. Força
//   processPaymentUpdate como se MP tivesse confirmado o
//   pagamento, sem depender de pix real. Só processa payment
//   já existente em D1 (tem que vir do /api/mp/create-pix).
// =====================================================

async function handleDebugApprove(request, env, ctx) {
  const expected = env.DEBUG_APPROVE_TOKEN;
  if (!expected) return new Response('disabled', { status: 503 });
  const token = request.headers.get('x-debug-token') || '';
  if (!constantTimeEqual(token, expected)) return new Response('forbidden', { status: 403 });
  let body = null;
  try { body = await request.json(); } catch { return new Response('bad json', { status: 400 }); }
  const paymentId = String(body && body.payment_id || '').trim();
  if (!paymentId || !/^\d{1,32}$/.test(paymentId)) {
    return new Response('invalid payment_id', { status: 400 });
  }
  const mockMp = { id: paymentId, status: 'approved', status_detail: 'accredited' };
  const ok = await processPaymentUpdate(env, ctx, request, mockMp);
  return new Response(JSON.stringify({ ok, payment_id: paymentId }), {
    status: ok ? 200 : 404,
    headers: { 'content-type': 'application/json' },
  });
}

// =====================================================
//              /api/mp/webhook
// =====================================================

async function handleMpWebhook(request, env, ctx) {
  let body = null;
  try { body = await request.json(); } catch { /* MP sometimes posts empty */ }
  const url = new URL(request.url);

  let paymentId = null;
  if (body && body.data && body.data.id) paymentId = String(body.data.id);
  if (!paymentId) paymentId = url.searchParams.get('id') || url.searchParams.get('data.id');
  const topic = (body && (body.type || body.topic)) || url.searchParams.get('topic') || url.searchParams.get('type') || '';

  if (!paymentId || !/^\d+$/.test(String(paymentId))) {
    return new Response('ok', { status: 200 });
  }
  if (topic && !/payment/i.test(topic)) {
    return new Response('ok', { status: 200 });
  }

  try {
    const mp = await getMpPayment(env, paymentId);
    if (mp && mp.id) await processPaymentUpdate(env, ctx, request, mp);
  } catch (_) { /* swallow */ }
  return new Response('ok', { status: 200 });
}

// =====================================================
//              /api/checkout-analytics
// =====================================================

export async function handleCheckoutAnalytics(request, env) {
  if (isBotRequest(request)) return json({ ok: true });
  let body = null;
  try { body = await request.json(); } catch { /* invalid body below */ }
  const event = normalizeCheckoutAnalyticsEvent(body);
  if (!event) return json({ ok: false, error: 'invalid_payload' }, 400);

  const pageSession = getPageViewSession(request);
  const now = nowBrasilia();
  const ip = (request.headers.get('cf-connecting-ip') || '').slice(0, 80);
  const ua = (request.headers.get('user-agent') || '').slice(0, 500);
  const funnel = clean(body && body.funnel, 40) || null;
  const utmPage = clean(body && body.utm_page, MAX.utm) || null;
  const isHidden = event.event === 'hidden';
  const isResumed = event.event === 'resumed' || event.event === 'pageshow';
  const isExit = event.event === 'pagehide';
  const validationIncrement = event.event === 'validation_error' ? 1 : 0;
  const paymentIncrement = event.event === 'payment_attempt' ? 1 : 0;

  await env.DB.prepare(
    `INSERT INTO checkout_sessions (
       visit_uuid, session_uuid, offer_code, lead_id, funnel, utm_page,
       last_stage, method, bump_selected, last_event, visible_ms, hidden_ms,
       background_count, resume_count, validation_errors, payment_attempts,
       ip, user_agent, started_at, last_seen_at, hidden_at, resumed_at, exited_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(visit_uuid) DO UPDATE SET
       lead_id = COALESCE(excluded.lead_id, checkout_sessions.lead_id),
       last_stage = excluded.last_stage,
       method = COALESCE(excluded.method, checkout_sessions.method),
       bump_selected = excluded.bump_selected,
       last_event = excluded.last_event,
       visible_ms = MAX(checkout_sessions.visible_ms, excluded.visible_ms),
       hidden_ms = MAX(checkout_sessions.hidden_ms, excluded.hidden_ms),
       background_count = MAX(checkout_sessions.background_count, excluded.background_count),
       resume_count = MAX(checkout_sessions.resume_count, excluded.resume_count),
       validation_errors = checkout_sessions.validation_errors + ?,
       payment_attempts = checkout_sessions.payment_attempts + ?,
       last_seen_at = excluded.last_seen_at,
       hidden_at = COALESCE(excluded.hidden_at, checkout_sessions.hidden_at),
       resumed_at = COALESCE(excluded.resumed_at, checkout_sessions.resumed_at),
       exited_at = COALESCE(excluded.exited_at, checkout_sessions.exited_at)`
  ).bind(
    event.visitUuid, pageSession.uuid, event.offerCode || null, event.leadId, funnel, utmPage,
    event.lastStage, event.method, event.bumpSelected, event.event,
    event.visibleMs, event.hiddenMs, event.backgroundCount, event.resumeCount,
    validationIncrement, paymentIncrement, ip, ua, now, now,
    isHidden ? now : null, isResumed ? now : null, isExit ? now : null,
    validationIncrement, paymentIncrement,
  ).run();

  return json({ ok: true });
}

// =====================================================
//              /api/checkout-event (Meta CAPI)
// =====================================================

// Eventos que o checkout.html envia de fato: InitiateCheckout ao abrir a
// oferta e Purchase só no checkout fake (oferta out_of_stock), em que não há
// pagamento real para o servidor disparar a compra. Purchase de oferta real é
// enviado exclusivamente pelo servidor após a aprovação (firePurchaseEffects).
const CHECKOUT_EVENT_NAMES = new Set(['InitiateCheckout', 'Purchase']);
const CHECKOUT_EVENT_CUSTOM_KEYS = ['content_name', 'content_ids', 'content_type', 'num_items', 'order_id'];

// Teto do valor de um evento do navegador: preço da oferta + todos os order
// bumps ativos (o maior total que o checkout consegue cobrar).
function offerMaxValueCents(offer) {
  const base = Number(offer && offer.sale_price_cents) || 0;
  const bumps = (offer && Array.isArray(offer.order_bumps) ? offer.order_bumps : [])
    .reduce((sum, b) => sum + (Number(b && b.price_cents) || 0), 0);
  return Math.max(0, base + bumps);
}

// custom_data montado no servidor: só chaves conhecidas do cliente, moeda
// forçada em BRL e valor limitado a [0, teto da oferta]. Sem valor válido do
// cliente, usa o preço da oferta.
export function buildCheckoutEventCustomData(offer, raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const data = pickCapiCustomData(src, CHECKOUT_EVENT_CUSTOM_KEYS);
  const maxValue = offerMaxValueCents(offer) / 100;
  const requested = Number(src.value);
  const value = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 0), maxValue)
    : (Number(offer.sale_price_cents) || 0) / 100;
  data.value = Math.round(value * 100) / 100;
  data.currency = 'BRL';
  if (!data.content_name) data.content_name = offer.name;
  return data;
}

function safeEventSourceUrl(value) {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim().slice(0, 1000);
  return /^https?:\/\//i.test(raw) ? raw : undefined;
}

export async function handleCheckoutEvent(request, env, ctx) {
  let body = null;
  try { body = await request.json(); } catch { /* ignore */ }
  if (!body || typeof body.event_name !== 'string' || typeof body.event_id !== 'string') {
    return json({ ok: false, error: 'invalid_payload' }, 400);
  }
  const eventName = body.event_name;
  const eventId = clean(body.event_id, 100);
  if (!eventId) return json({ ok: false, error: 'invalid_payload' }, 400);
  if (!CHECKOUT_EVENT_NAMES.has(eventName)) return json({ ok: false, error: 'invalid_event' }, 400);

  // Pixel, token e teto de valor saem da oferta resolvida no servidor. Nada de
  // pixel_id/access_token/test_event_code do cliente (o código de teste da
  // instância, META_TEST_EVENT_CODE, continua valendo em sendMetaCapiEvent).
  const rawCode = typeof body.offer_code === 'string' ? body.offer_code.trim() : '';
  const offer = isValidOfferCode(rawCode) ? await loadOfferByCode(env, rawCode) : null;
  if (!offer) return json({ ok: false, error: 'offer_not_found' }, 400);
  if (eventName === 'Purchase' && !offer.out_of_stock) {
    return json({ ok: false, error: 'invalid_event' }, 400);
  }

  const userData = (body.user_data && typeof body.user_data === 'object') ? body.user_data : {};
  const { pixel_id, access_token } = offerCapi(offer);
  const capiResult = await sendMetaCapiEvent(request, env, {
    event_name: eventName,
    event_id: eventId,
    event_source_url: safeEventSourceUrl(body.event_source_url),
    custom_data: buildCheckoutEventCustomData(offer, body.custom_data),
    pixel_id,
    access_token,
    email: typeof userData.email === 'string' ? clean(userData.email, MAX.email) : undefined,
    phone: typeof userData.phone === 'string' ? clean(userData.phone, MAX.phone) : undefined,
    name: typeof userData.name === 'string' ? clean(userData.name, MAX.name) : undefined,
  });
  if (capiResult && capiResult.ok) return json(capiResult, 202);
  // A resposta da Meta pode trazer detalhes de configuração/token: fica no log.
  console.error('[checkout-event] capi failed', JSON.stringify({
    event_name: eventName,
    offer: offer.code,
    error: capiResult && capiResult.error,
    detail: capiResult && capiResult.detail,
  }));
  return json({ ok: false, error: 'capi_unavailable' }, 502);
}

// =====================================================
//              /api/mp/log-error (front-side errors)
// =====================================================

async function handleLogPaymentError(request, env, ctx) {
  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const stage = clean(data.stage, 32);
  if (!VALID_PAYMENT_ERROR_STAGES.has(stage)) return json({ ok: false, error: 'invalid_stage' }, 400);

  const offerCode = clean(data.offer_code, 64);
  const offer = isValidOfferCode(offerCode) ? await loadOfferByCode(env, offerCode) : null;

  const utms = {};
  for (const key of UTM_KEYS) utms[key] = clean(data[key], MAX.utm) || null;
  const utmPage = clean(data && data.utm_page, MAX.utm) || null;
  const rawFunnel = clean(data.funnel, 40);
  const funnel = rawFunnel && /^[a-z0-9_-]{1,40}$/i.test(rawFunnel) ? rawFunnel.toLowerCase() : null;

  const rawId = data.lead_id == null ? NaN : (typeof data.lead_id === 'number' ? data.lead_id : parseInt(data.lead_id, 10));
  const leadId = Number.isFinite(rawId) && rawId > 0 ? rawId : null;

  await logPaymentError(env, request, {
    leadId,
    offerId: offer ? offer.id : null,
    stage,
    errorCode: clean(data.error_code, 120) || stage,
    errorDetail: clean(data.error_detail, 500),
    funnel, utms, utmPage,
  });

  return json({ ok: true });
}

// =====================================================
//              fetch handler
// =====================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Endpoints privados: alcançáveis pelo dashboard somente via CHECKOUT_SERVICE
    // (o roteador bloqueia /internal para o público e o checkout exige a chave
    // interna; contrato descrito acima de isAuthorizedInternalCall).
    if (path === '/internal' || path.startsWith('/internal/')) {
      if (!isAuthorizedInternalCall(request, env)) return internalNotFound();
      if (path === '/internal/dashboard/refund' && request.method === 'POST') {
        return handleDashboardRefund(request, env);
      }
      if (path === '/internal/dashboard/resend-email' && request.method === 'POST') {
        return handleResendPurchaseEmail(request, env);
      }
      return internalNotFound();
    }

    // APIs
    if (path === '/api/checkout' && request.method === 'POST') return handleCheckout(request, env, ctx);
    if (path === '/api/checkout-analytics' && request.method === 'POST') return handleCheckoutAnalytics(request, env);
    if (path === '/api/checkout-event' && request.method === 'POST') return handleCheckoutEvent(request, env, ctx);
    if (path === '/api/mp/create-pix' && request.method === 'POST') return handleCreatePix(request, env, ctx);
    if (path === '/api/mp/create-card' && request.method === 'POST') return handleCreateCard(request, env, ctx);
    if (path === '/api/mp/status' && request.method === 'GET') return handleMpStatus(request, env, ctx);
    if (path === '/api/mp/webhook' && (request.method === 'POST' || request.method === 'GET')) return handleMpWebhook(request, env, ctx);
    if (path === '/api/mp/log-error' && request.method === 'POST') return handleLogPaymentError(request, env, ctx);
    if (path === '/api/mp/_debug_approve' && request.method === 'POST') return handleDebugApprove(request, env, ctx);

    const stripped = stripParamsRedirect(url);
    if (stripped) return stripped;

    // /checkout (sem cod) -> mostra "oferta nao encontrada"
    if (path === '/checkout') {
      const pageSession = getPageViewSession(request);
      if (request.method === 'GET' && ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(logPageView('checkout', request, env, null, { sessionUuid: pageSession.uuid }));
      }
      const response = await serveCheckoutPage(request, env, null);
      return withPageViewSessionCookie(response, pageSession);
    }
    // /checkout/<code>
    const m = path.match(/^\/checkout\/([a-z0-9_-]{1,64})$/i);
    if (m) {
      const code = m[1].toLowerCase();
      const offer = await loadOfferByCode(env, code);
      const pageSession = getPageViewSession(request);
      if (request.method === 'GET' && ctx && typeof ctx.waitUntil === 'function') {
        // Funil vem só do ?funnel= que a página de origem anexa ao link.
        let funnel = null;
        const f = url.searchParams.get('funnel');
        if (f && /^[a-z0-9_-]{1,40}$/i.test(f)) funnel = f.toLowerCase();
        // Preserva utm_page da origem (advertorial/LP) pra permitir drill-down por página.
        // Só usa /checkout/<code> como fallback quando o tráfego não passou utm_page.
        const incomingUtmPage = (url.searchParams.get('utm_page') || '').trim();
        const utmPage = incomingUtmPage && /^[\w\/.\-]{1,255}$/.test(incomingUtmPage)
          ? incomingUtmPage
          : '/checkout/' + code;
        ctx.waitUntil(logPageView('checkout', request, env, funnel, {
          sessionUuid: pageSession.uuid,
          utmPage,
        }));
      }
      const response = await serveCheckoutPage(request, env, offer);
      return withPageViewSessionCookie(response, pageSession);
    }

    return env.ASSETS.fetch(request);
  },
};
