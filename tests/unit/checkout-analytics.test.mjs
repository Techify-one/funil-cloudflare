import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCheckoutAnalyticsEvent,
  classifyCheckoutSession,
} from '../../shared/checkout-analytics.mjs';

test('normalizes a checkout analytics event and rejects untrusted values', () => {
  const event = normalizeCheckoutAnalyticsEvent({
    visit_uuid: '2a9d1387-5f50-4d92-bcc2-44210f93e35d',
    event: 'resumed',
    offer_code: 'produto-teste',
    lead_id: 42,
    last_stage: 'telefone',
    method: 'pix',
    visible_ms: 12500.8,
    hidden_ms: 2300.2,
    background_count: 2,
    resume_count: 1,
    bump_selected: true,
  });

  assert.deepEqual(event, {
    visitUuid: '2a9d1387-5f50-4d92-bcc2-44210f93e35d',
    event: 'resumed',
    offerCode: 'produto-teste',
    leadId: 42,
    lastStage: 'telefone',
    method: 'pix',
    visibleMs: 12500,
    hiddenMs: 2300,
    backgroundCount: 2,
    resumeCount: 1,
    bumpSelected: 1,
  });

  assert.equal(normalizeCheckoutAnalyticsEvent({ visit_uuid: 'x', event: 'hidden' }), null);
  assert.equal(normalizeCheckoutAnalyticsEvent({
    visit_uuid: '2a9d1387-5f50-4d92-bcc2-44210f93e35d',
    event: 'arbitrary-script-event',
  }), null);
});

test('classifies checkout outcomes without claiming that an unknown exit was a tab close', () => {
  assert.equal(classifyCheckoutSession({ purchased: 1 }), 'purchased');
  assert.equal(classifyCheckoutSession({ returned_to_site: 1 }), 'returned_to_site');
  assert.equal(classifyCheckoutSession({ last_event: 'hidden', age_minutes: 5 }), 'background_now');
  assert.equal(classifyCheckoutSession({ last_event: 'hidden', age_minutes: 45 }), 'abandoned_background');
  assert.equal(classifyCheckoutSession({ last_event: 'pagehide', age_minutes: 45 }), 'unknown_exit');
  assert.equal(classifyCheckoutSession({ last_event: 'hidden', age_minutes: 5, exited_at: '2026-09-01T20:55:47-03:00', resumed_at: null }), 'unknown_exit');
  assert.equal(classifyCheckoutSession({ last_event: 'heartbeat', age_minutes: 45 }), 'abandoned_inactive');
});
