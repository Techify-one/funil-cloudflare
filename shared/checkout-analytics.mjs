const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OFFER_RE = /^[a-z0-9_-]{1,64}$/i;

export const CHECKOUT_ANALYTICS_EVENTS = new Set([
  'opened',
  'heartbeat',
  'hidden',
  'resumed',
  'pagehide',
  'pageshow',
  'back_forward',
  'method_selected',
  'bump_changed',
  'validation_error',
  'payment_attempt',
]);

export const CHECKOUT_STAGES = new Set([
  'opened',
  'nome',
  'email',
  'telefone',
  'escolheu_metodo',
  'payment_attempt',
  'pix_gerado',
]);

function boundedInt(value, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), max);
}

export function normalizeCheckoutAnalyticsEvent(body) {
  if (!body || typeof body !== 'object') return null;
  const visitUuid = String(body.visit_uuid || '').toLowerCase();
  const event = String(body.event || '');
  const offerCode = String(body.offer_code || '').toLowerCase();
  if (!UUID_RE.test(visitUuid) || !CHECKOUT_ANALYTICS_EVENTS.has(event)) return null;
  if (offerCode && !OFFER_RE.test(offerCode)) return null;

  const leadIdRaw = Number(body.lead_id);
  const leadId = Number.isSafeInteger(leadIdRaw) && leadIdRaw > 0 ? leadIdRaw : null;
  const lastStageRaw = String(body.last_stage || 'opened');
  const lastStage = CHECKOUT_STAGES.has(lastStageRaw) ? lastStageRaw : 'opened';
  const method = body.method === 'pix' || body.method === 'card' ? body.method : null;

  return {
    visitUuid,
    event,
    offerCode,
    leadId,
    lastStage,
    method,
    visibleMs: boundedInt(body.visible_ms, 86400000),
    hiddenMs: boundedInt(body.hidden_ms, 604800000),
    backgroundCount: boundedInt(body.background_count, 1000),
    resumeCount: boundedInt(body.resume_count, 1000),
    bumpSelected: body.bump_selected ? 1 : 0,
  };
}

export function classifyCheckoutSession(row) {
  if (Number(row && row.purchased) > 0) return 'purchased';
  if (Number(row && row.returned_to_site) > 0) return 'returned_to_site';
  if (row && row.exited_at && (!row.resumed_at || row.resumed_at <= row.exited_at)) return 'unknown_exit';
  const age = Number(row && row.age_minutes);
  const recent = Number.isFinite(age) && age < 30;
  if (row && row.last_event === 'hidden') return recent ? 'background_now' : 'abandoned_background';
  if (row && row.last_event === 'pagehide') return 'unknown_exit';
  if (recent) return 'active_visible';
  return 'abandoned_inactive';
}
