export const MAX_ORDER_BUMPS = 10;

function integerCents(value) {
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

export function validateOrderBumps(raw) {
  if (raw == null) return { ok: true, bumps: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'Order bumps devem ser uma lista' };
  if (raw.length > MAX_ORDER_BUMPS) return { ok: false, error: `Máximo de ${MAX_ORDER_BUMPS} order bumps por oferta` };

  const bumps = [];
  const seenIds = new Set();
  for (let position = 0; position < raw.length; position += 1) {
    const item = raw[position];
    if (!item || typeof item !== 'object') return { ok: false, error: `Order bump ${position + 1} inválido` };
    const idValue = item.id == null || item.id === '' ? null : Number(item.id);
    if (idValue != null && (!Number.isInteger(idValue) || idValue <= 0)) return { ok: false, error: `ID do order bump ${position + 1} inválido` };
    if (idValue != null && seenIds.has(idValue)) return { ok: false, error: `ID de order bump duplicado: ${idValue}` };
    if (idValue != null) seenIds.add(idValue);
    const name = String(item.name || '').trim();
    if (!name) return { ok: false, error: `Nome do order bump ${position + 1} é obrigatório` };
    if (name.length > 160) return { ok: false, error: `Nome do order bump ${position + 1} muito longo` };
    const description = item.description == null ? null : String(item.description).trim() || null;
    if (description && description.length > 500) return { ok: false, error: `Descrição do order bump ${position + 1} muito longa` };
    const price = integerCents(item.price_cents);
    if (price == null || price <= 0 || price > 100000000) return { ok: false, error: `Preço do order bump ${position + 1} inválido` };
    bumps.push({
      id: idValue,
      name,
      description,
      price_cents: price,
      is_active: item.is_active === false || item.is_active === 0 ? 0 : 1,
      position,
    });
  }
  return { ok: true, bumps };
}

export function normalizeSelectedBumpIds(raw) {
  if (raw == null) return { ok: true, ids: [] };
  if (!Array.isArray(raw) || raw.length > MAX_ORDER_BUMPS) return { ok: false, error: 'invalid_order_bumps' };
  const ids = [];
  for (const value of raw) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'invalid_order_bumps' };
    if (!ids.includes(id)) ids.push(id);
  }
  return { ok: true, ids };
}

export function calculateCheckoutSelection(basePriceCents, availableBumps, selectedIds) {
  const base = integerCents(basePriceCents);
  const normalized = normalizeSelectedBumpIds(selectedIds);
  if (base == null || base < 0 || !normalized.ok) return { ok: false, error: 'invalid_order_bumps' };
  const byId = new Map((availableBumps || []).filter((b) => Number(b.is_active) === 1).map((b) => [Number(b.id), b]));
  const selected = [];
  for (const id of normalized.ids) {
    const bump = byId.get(id);
    if (!bump) return { ok: false, error: 'invalid_order_bumps' };
    selected.push(bump);
  }
  selected.sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0) || Number(a.id) - Number(b.id));
  const total = selected.reduce((sum, bump) => sum + Number(bump.price_cents), base);
  if (!Number.isSafeInteger(total) || total < 0 || total > 100000000) return { ok: false, error: 'invalid_order_bumps' };
  return { ok: true, selected, total_cents: total };
}

export function buildPaymentItems(offer, selectedBumps) {
  const toAmount = (cents) => Number((Number(cents) / 100).toFixed(2));
  return [
    {
      id: `offer-${offer.id}`,
      title: offer.name,
      description: offer.name,
      category_id: 'learnings',
      quantity: 1,
      unit_price: toAmount(offer.sale_price_cents),
    },
    ...(selectedBumps || []).map((bump) => ({
      id: `bump-${bump.id}`,
      title: bump.name,
      description: bump.description || bump.name,
      category_id: 'learnings',
      quantity: 1,
      unit_price: toAmount(bump.price_cents),
    })),
  ];
}
