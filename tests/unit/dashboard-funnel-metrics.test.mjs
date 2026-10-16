import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateFinancialMetrics,
  dateMonthsBefore,
  insightMatchesAttribution,
  metaAccountIds,
  metaAttributionScope,
  metaDate,
  metaTimeRange,
  summarizeMetaInsights,
} from "../../dashboard/src/funnel-metrics.mjs";

const insight = {
  campaign_id: "camp-42",
  campaign_name: "camp42",
  adset_id: "set-01",
  adset_name: "camp42_01",
  ad_id: "ad-01",
  ad_name: "01",
  publisher_platform: "facebook",
  impressions: "1250",
  spend: "34.567",
};

test("matches legacy UTM names and Meta source alias", () => {
  assert.equal(insightMatchesAttribution(insight, {
    utm_campaign: "CAMP42",
    utm_content: "camp42_01",
    utm_term: "01",
    utm_source: "fb",
  }), true);
  assert.equal(insightMatchesAttribution(insight, {
    utm_campaign: "camp42",
    utm_content: "camp42_01",
    utm_term: "01",
    utm_source: "ig",
  }), false);
});

test("prefers stable Meta IDs over renamed UTM dimensions", () => {
  assert.equal(insightMatchesAttribution(insight, {
    meta_campaign_id: "camp-42",
    meta_adset_id: "set-01",
    meta_ad_id: "ad-01",
    utm_campaign: "old campaign name",
    utm_content: "old adset name",
    utm_term: "old ad name",
    utm_source: "facebook",
  }), true);
});

test("sums only insights attributed to the selected funnel", () => {
  const summary = summarizeMetaInsights([
    insight,
    { ...insight, ad_id: "other", ad_name: "02", impressions: "9999", spend: "100" },
  ], [{ meta_ad_id: "ad-01", utm_source: "fb" }]);
  assert.deepEqual(summary, { impressions: 1250, spend: 34.57 });
});

test("explicit campaign includes spend from ads and platforms without D1 visits", () => {
  const insights = [
    insight,
    { ...insight, ad_id: "ad-02", ad_name: "02", publisher_platform: "instagram", impressions: "500", spend: "15.20" },
    { ...insight, campaign_id: "other-campaign", campaign_name: "camp99", spend: "999" },
  ];
  const observedVisits = [{
    utm_campaign: "camp42",
    utm_content: "camp42_01",
    utm_term: "01",
    utm_source: "fb",
  }];

  const scope = metaAttributionScope(observedVisits, { utm_campaign: "camp42" });
  assert.deepEqual(summarizeMetaInsights(insights, scope), { impressions: 1750, spend: 49.77 });
});

test("explicit ad filter includes every platform for that ad", () => {
  const instagram = { ...insight, publisher_platform: "instagram", impressions: "500", spend: "10" };
  const otherAd = { ...insight, ad_id: "ad-02", ad_name: "02", spend: "100" };
  const scope = metaAttributionScope([], { utm_campaign: "camp42", utm_term: "01" });
  assert.deepEqual(summarizeMetaInsights([insight, instagram, otherAd], scope), {
    impressions: 1750,
    spend: 44.57,
  });
});

test("explicit source filter still narrows Meta publisher platform", () => {
  const instagram = { ...insight, publisher_platform: "instagram", impressions: "500", spend: "10" };
  const scope = metaAttributionScope([], { utm_campaign: "camp42", utm_source: "ig" });
  assert.deepEqual(summarizeMetaInsights([insight, instagram], scope), { impressions: 500, spend: 10 });
});

test("normalizes configured Meta accounts and dates", () => {
  assert.deepEqual(metaAccountIds({
    META_AD_ACCOUNT_ID: "act_111111",
    META_AD_ACCOUNT_ID_2: "act_222222",
    META_AD_ACCOUNT_IDS: "act_222222, act_333333,invalid",
  }), ["act_111111", "act_222222", "act_333333"]);
  assert.equal(metaDate("2026-08-31 12:00:00", "2020-01-01"), "2026-08-31");
  assert.equal(metaDate(null, "2020-01-01"), "2020-01-01");
  assert.deepEqual(metaTimeRange({
    range: "30d",
    since: "2026-08-06 12:34:29",
    until: null,
    today: "2026-09-05",
  }), { since: "2026-08-07", until: "2026-09-05" });
  assert.deepEqual(metaTimeRange({
    range: "custom",
    since: "2026-08-10 03:00:00",
    until: "2026-08-20 02:59:59",
    today: "2026-09-05",
  }), { since: "2026-08-10", until: "2026-08-20" });
});

test("subtracts calendar months without rolling invalid month-end dates", () => {
  assert.equal(dateMonthsBefore("2026-09-05", 36), "2023-09-05");
  assert.equal(dateMonthsBefore("2024-02-29", 12), "2023-02-28");
  assert.equal(dateMonthsBefore("2024-03-31", 1), "2024-02-29");
  assert.equal(dateMonthsBefore("invalid", 36), null);
});

test("calculates cost per sale and average ticket from approved orders", () => {
  assert.deepEqual(calculateFinancialMetrics({
    spend: 432.73,
    receivedCents: 30650,
    approvedOrders: 14,
    metaAvailable: true,
  }), {
    invested: 432.73,
    received_cents: 30650,
    approved_orders: 14,
    roas: 0.71,
    cost_per_sale: 30.91,
    average_ticket: 21.89,
  });
});

test("keeps ticket available when Meta is unavailable", () => {
  assert.deepEqual(calculateFinancialMetrics({
    spend: null,
    receivedCents: 5970,
    approvedOrders: 3,
    metaAvailable: false,
  }), {
    invested: null,
    received_cents: 5970,
    approved_orders: 3,
    roas: null,
    cost_per_sale: null,
    average_ticket: 19.9,
  });
});
