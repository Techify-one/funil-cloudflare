// Tabela canônica `orders` (fonte única de "compra"), lida por /funil, /meta e
// /vendas. Ver migrations/0001_init.sql.
//
// Idempotência: 1 pedido = 1 linha que avança de status.
//   Mercado Pago: chave gateway_txn_id (id do pagamento no MP)
//   Gateways que identificam o pedido por referência própria usariam
//   gateway_order_ref (o schema atual só aceita 'mercadopago').
//
// Efeitos colaterais (CAPI, e-mail) NÃO são disparados aqui: quem dispara é
// firePurchaseEffects no checkout, que carimba side_effects_at com
// compare-and-set para garantir um único disparo por pedido.

import { nowBrasilia } from './utils.js';

// Ranking de status pra nunca rebaixar um pedido (ex.: approved para pending).
// refunded/chargeback são pós-aprovação (rank alto, sempre podem sobrescrever).
const STATUS_RANK = {
  pending: 0, rejected: 1, cancelled: 1, expired: 1,
  approved: 2, refunded: 3, chargeback: 3,
};

function normStatus(s) {
  const v = String(s || '').toLowerCase();
  return STATUS_RANK[v] !== undefined ? v : 'pending';
}

function normMethod(m) {
  const s = String(m || '').toLowerCase();
  if (['card', 'credit_card', 'cartão', 'cartao'].includes(s)) return 'card';
  if (s === 'boleto' || s === 'bank_slip') return 'boleto';
  if (s === 'pix' || s === 'pix_created') return 'pix';
  return null;
}

async function resolveFunnelId(env, o) {
  if (o.funnelId !== undefined && o.funnelId !== null) return o.funnelId;
  if (!o.funnelSlug) return null;
  try {
    const r = await env.DB.prepare('SELECT id FROM funnels WHERE slug = ? LIMIT 1').bind(o.funnelSlug).first();
    return r ? r.id : null;
  } catch (_) { return null; }
}

// Faz upsert idempotente de um pedido em `orders`. Defensivo: nunca lança
// (retorna null em erro) pra não derrubar o fluxo de checkout/webhook.
//
// o = {
//   gateway: 'mercadopago',
//   gatewayTxnId, gatewayOrderRef,
//   status, method, amountCents, paidAmountCents, installments,
//   leadId, offerId, funnelSlug | funnelId,
//   utms: { utm_source, utm_medium, utm_campaign, utm_term, utm_content },
//   utmPage, metaCampaignId, metaAdsetId, metaAdId, fbclid,
//   payerName, payerEmail, payerPhone,
//   metaEventId, rawEventId,
// }
export async function upsertOrder(env, o) {
  try {
    const now = nowBrasilia();
    const status = normStatus(o.status);
    const method = normMethod(o.method);
    const u = o.utms || {};

    const keyCol = o.gateway === 'mercadopago' ? 'gateway_txn_id' : 'gateway_order_ref';
    const keyVal = o.gateway === 'mercadopago' ? o.gatewayTxnId : o.gatewayOrderRef;
    if (!keyVal) return null;

    const existing = await env.DB.prepare(
      `SELECT id, status, meta_event_id, side_effects_at FROM orders WHERE gateway = ? AND ${keyCol} = ? LIMIT 1`
    ).bind(o.gateway, keyVal).first();

    const approvedAt = status === 'approved' ? now : null;
    const refundedAt = (status === 'refunded' || status === 'chargeback') ? now : null;
    // side_effects_at NÃO é marcado aqui: quem dispara os efeitos
    // (firePurchaseEffects, com compare-and-set) é que carimba. Só respeita
    // se o caller passar explicitamente (ex.: backfill marca como já tratado).
    const sideEffectsAt = o.sideEffectsAt || null;

    if (!existing) {
      const funnelId = await resolveFunnelId(env, o);
      const r = await env.DB.prepare(
        `INSERT INTO orders (
           gateway, gateway_txn_id, gateway_order_ref, status, method,
           amount_cents, paid_amount_cents, installments,
           lead_id, offer_id, funnel_id,
           utm_source, utm_medium, utm_campaign, utm_term, utm_content, utm_page,
           meta_campaign_id, meta_adset_id, meta_ad_id, fbclid,
           payer_name, payer_email, payer_phone,
           meta_event_id, side_effects_at, raw_event_id, ip,
           created_at, approved_at, refunded_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        o.gateway, o.gatewayTxnId || null, o.gatewayOrderRef || null, status, method,
        o.amountCents || 0, o.paidAmountCents ?? null, o.installments ?? null,
        o.leadId || null, o.offerId || null, funnelId,
        u.utm_source || null, u.utm_medium || null, u.utm_campaign || null, u.utm_term || null, u.utm_content || null, o.utmPage || null,
        o.metaCampaignId || null, o.metaAdsetId || null, o.metaAdId || null, o.fbclid || null,
        o.payerName || null, o.payerEmail || null, o.payerPhone || null,
        o.metaEventId || null, sideEffectsAt, o.rawEventId || null, o.ip || null,
        now, approvedAt, refundedAt, now
      ).run();
      return { id: r?.meta?.last_row_id || null, created: true, statusChanged: true };
    }

    // Já existe: só avança de status (nunca rebaixa).
    const prev = normStatus(existing.status);
    const willChange = STATUS_RANK[status] > STATUS_RANK[prev]
                       || (status === 'refunded' || status === 'chargeback');
    if (!willChange) return { id: existing.id, created: false, statusChanged: false };

    await env.DB.prepare(
      `UPDATE orders SET
         status = ?,
         approved_at = COALESCE(approved_at, ?),
         refunded_at = COALESCE(refunded_at, ?),
         meta_event_id = COALESCE(meta_event_id, ?),
         side_effects_at = COALESCE(side_effects_at, ?),
         updated_at = ?
       WHERE id = ?`
    ).bind(
      status, approvedAt, refundedAt,
      o.metaEventId || existing.meta_event_id || null,
      sideEffectsAt, now, existing.id
    ).run();
    return { id: existing.id, created: false, statusChanged: true, prevStatus: prev };
  } catch (_) {
    return null; // dual-write nunca derruba o fluxo principal
  }
}
