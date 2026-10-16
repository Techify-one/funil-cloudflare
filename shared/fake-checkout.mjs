import { calculateCheckoutSelection } from './order-bumps.mjs';

// Latest session overall: never borrow an older session from another offer.
export const FAKE_SALE_COLUMNS = `
  (SELECT json_object('offer_code', f.offer_code, 'offer_name', f.offer_name_snapshot,
    'method', f.method, 'total_cents', f.total_cents, 'bumps', json(f.bumps_json))
    FROM fake_checkout_purchases f WHERE f.lead_id = leads.id AND f.offer_code = leads.product LIMIT 1) AS fake_snapshot,
  (SELECT o.out_of_stock FROM offers o WHERE o.code = leads.product LIMIT 1) AS fake_offer,
  (SELECT o.sale_price_cents FROM offers o WHERE o.code = leads.product LIMIT 1) AS fake_offer_price,
  (SELECT json_object('offer_code', cs.offer_code, 'method', cs.method,
    'bump_selected', cs.bump_selected, 'last_stage', cs.last_stage)
    FROM checkout_sessions cs WHERE cs.lead_id = leads.id ORDER BY cs.last_seen_at DESC, cs.id DESC LIMIT 1) AS legacy_session
`;


export function fakeSaleValue(row) {
  const empty = { method: '', amount_cents: null, value_source: 'unrecorded', is_fake_checkout: false, bumps: [] };
  if (row.last_payment_id != null || row.approved_at_max || row.lead_status !== 'comprou') return empty;
  const snapshot = JSON.parse(row.fake_snapshot || 'null');
  if (snapshot?.offer_code === row.product) return {
    method: snapshot.method, amount_cents: snapshot.total_cents, value_source: 'fake_snapshot',
    is_fake_checkout: true, bumps: snapshot.bumps || [], offer_name: snapshot.offer_name,
  };
  if (Number(row.fake_offer) !== 1) return empty;
  const unknown = { ...empty, is_fake_checkout: true };
  const session = JSON.parse(row.legacy_session || 'null');
  if (!session || session.offer_code !== row.product || session.last_stage !== 'payment_attempt') return unknown;
  const method = ['pix', 'card'].includes(session.method) ? session.method : '';
  if (!method || session.bump_selected !== 0 || row.fake_offer_price == null) return { ...unknown, method };
  return { ...unknown, method, amount_cents: row.fake_offer_price, value_source: 'legacy_estimated' };
}

export function buildFakePurchase(offer, data) {
  if (!offer || !offer.out_of_stock) return { ok: false, error: 'invalid_fake_offer' };
  if (!['pix', 'card'].includes(data.method)) return { ok: false, error: 'invalid_method' };
  const selection = calculateCheckoutSelection(offer.sale_price_cents, offer.order_bumps, data.order_bump_ids);
  if (!selection.ok) return selection;
  if (data.expected_total_cents != null && Number(data.expected_total_cents) !== selection.total_cents) {
    return { ok: false, error: 'price_changed', amount_cents: selection.total_cents };
  }
  return { ok: true, purchase: {
    offer_id: offer.id, offer_code: offer.code, offer_name: offer.name,
    method: data.method, base_price_cents: offer.sale_price_cents,
    total_cents: selection.total_cents,
    bumps: selection.selected.map(b => ({ id: b.id, name: b.name, price_cents: b.price_cents })),
  } };
}
