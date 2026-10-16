const META_SOURCE_ALIASES = {
  facebook: new Set(["facebook", "fb"]),
  instagram: new Set(["instagram", "ig"]),
  messenger: new Set(["messenger", "msg"]),
  audience_network: new Set(["audience_network", "audience network", "an"]),
};

function normalized(value) {
  return String(value ?? "").trim().toLocaleLowerCase("pt-BR");
}

function same(valueA, valueB) {
  return normalized(valueA) === normalized(valueB);
}

function sourceMatches(utmSource, publisherPlatform) {
  const source = normalized(utmSource);
  if (!source) return true;
  const platform = normalized(publisherPlatform);
  const aliases = META_SOURCE_ALIASES[platform];
  return aliases ? aliases.has(source) : source === platform;
}

function dimensionMatches(id, name, insightId, insightName) {
  if (String(id ?? "").trim()) return String(id).trim() === String(insightId ?? "").trim();
  if (String(name ?? "").trim()) return same(name, insightName);
  return true;
}

export function insightMatchesAttribution(insight, attribution) {
  const hasIdentity = [
    attribution.meta_campaign_id,
    attribution.meta_adset_id,
    attribution.meta_ad_id,
    attribution.utm_campaign,
    attribution.utm_content,
    attribution.utm_term,
  ].some((value) => String(value ?? "").trim());
  if (!hasIdentity) return false;

  return dimensionMatches(attribution.meta_campaign_id, attribution.utm_campaign, insight.campaign_id, insight.campaign_name)
    && dimensionMatches(attribution.meta_adset_id, attribution.utm_content, insight.adset_id, insight.adset_name)
    && dimensionMatches(attribution.meta_ad_id, attribution.utm_term, insight.ad_id, insight.ad_name)
    && sourceMatches(attribution.utm_source, insight.publisher_platform);
}

export function summarizeMetaInsights(insights, attributions) {
  let impressions = 0;
  let spend = 0;
  for (const insight of insights || []) {
    if (!(attributions || []).some((attribution) => insightMatchesAttribution(insight, attribution))) continue;
    impressions += Number(insight.impressions) || 0;
    spend += Number(insight.spend) || 0;
  }
  return {
    impressions: Math.round(impressions),
    spend: Math.round((spend + Number.EPSILON) * 100) / 100,
  };
}

// Quando o usuário escolhe uma campanha explicitamente no dashboard, esse
// filtro define o escopo do investimento na Meta. Não use as visitas do D1
// como whitelist: anúncios/plataformas podem gastar antes de gerar um clique.
// Filtros mais específicos continuam estreitando o escopo quando selecionados.
export function metaAttributionScope(attributions, selectedUtms = {}) {
  const campaign = String(selectedUtms.utm_campaign ?? "").trim();
  if (!campaign || campaign === "__none__") return attributions || [];

  const scope = { utm_campaign: campaign };
  for (const key of ["utm_content", "utm_term", "utm_source"]) {
    const value = String(selectedUtms[key] ?? "").trim();
    if (!value) continue;
    // A Meta não possui uma dimensão equivalente a "sem UTM". Nesse caso,
    // nenhum insight pode ser atribuído com segurança ao filtro selecionado.
    if (value === "__none__") return [];
    scope[key] = value;
  }
  return [scope];
}

export function metaAccountIds(env) {
  const candidates = [env.META_AD_ACCOUNT_ID, env.META_AD_ACCOUNT_ID_2];
  if (env.META_AD_ACCOUNT_IDS) candidates.push(...String(env.META_AD_ACCOUNT_IDS).split(","));
  return [...new Set(candidates.map((value) => String(value ?? "").trim()).filter((value) => /^act_\d{6,30}$/.test(value)))];
}

export function metaDate(value, fallback) {
  const match = String(value ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : fallback;
}

function dateDaysBefore(isoDate, days) {
  const match = String(isoDate ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

// Subtrai meses de calendário preservando o dia quando possível. Em fins de
// mês, limita ao último dia válido do mês de destino (29/02/2024 - 12 meses =
// 28/02/2023), evitando o rollover automático do Date para março.
export function dateMonthsBefore(isoDate, months) {
  const match = String(isoDate ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const amount = Number(months);
  if (!match || !Number.isInteger(amount) || amount < 0) return null;

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const targetIndex = year * 12 + monthIndex - amount;
  const targetYear = Math.floor(targetIndex / 12);
  const targetMonthIndex = targetIndex - targetYear * 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonthIndex + 1, 0)).getUTCDate();

  return `${String(targetYear).padStart(4, "0")}-${String(targetMonthIndex + 1).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

// Presets do painel Meta são intervalos inclusivos de datas: "30 dias" =
// hoje + 29 dias anteriores. O funil usa timestamps no D1, então convertemos
// apenas o intervalo enviado à Insights API para a mesma semântica do /meta.
export function metaTimeRange({ range, since, until, today }) {
  const inclusiveDays = { "7d": 7, "30d": 30, "90d": 90 }[range];
  const presetSince = !until && inclusiveDays ? dateDaysBefore(today, inclusiveDays - 1) : null;
  const requestedSince = presetSince || metaDate(since, "2020-01-01");
  return {
    since: requestedSince < "2020-01-01" ? "2020-01-01" : requestedSince,
    until: metaDate(until, today),
  };
}

function roundedMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function calculateFinancialMetrics({ spend, receivedCents, approvedOrders, metaAvailable }) {
  const sales = Math.max(0, Math.trunc(Number(approvedOrders) || 0));
  const received = Math.max(0, Math.round(Number(receivedCents) || 0));
  const invested = metaAvailable ? Math.max(0, Number(spend) || 0) : null;
  return {
    invested: invested === null ? null : roundedMoney(invested),
    received_cents: received,
    approved_orders: sales,
    roas: invested !== null && invested > 0 ? roundedMoney((received / 100) / invested) : null,
    cost_per_sale: invested !== null && sales > 0 ? roundedMoney(invested / sales) : null,
    average_ticket: sales > 0 ? roundedMoney((received / 100) / sales) : null,
  };
}
