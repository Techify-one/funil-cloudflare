import { fakeSaleValue, FAKE_SALE_COLUMNS } from "../../shared/fake-checkout.mjs";
import LEADS_HTML from "./leads.html";
import VENDAS_HTML from "./vendas.html";
import FUNIL_HTML from "./funil.html";
import META_HTML from "./meta.html";
import PAINEL_HTML from "./painel.html";
import OFFERS_HTML from "./offers.html";
import SECOES_HTML from "./secoes.html";
import CHECKOUT_ANALYTICS_HTML from "./checkout-analytics.html";
import { validateOrderBumps } from "../../shared/order-bumps.mjs";
import {
  calculateFinancialMetrics,
  dateMonthsBefore,
  metaAccountIds,
  metaAttributionScope,
  metaTimeRange,
  summarizeMetaInsights,
} from "./funnel-metrics.mjs";
import { creativeDestinationUrl, creativeImageHashes } from "./meta-creative.mjs";
import { pageViewCountExpression } from "./funnel-visits.mjs";
import { humanPageViewFilter } from "../../shared/bot-detection.mjs";

const ALLOWED_SETTINGS = new Set(["blocked_ips"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    const auth = checkAuth(request, env);
    if (auth) return auth;

    const forbidden = checkCrossSite(request, url);
    if (forbidden) return forbidden;

    if (path === "/paginas") {
      return Response.redirect(new URL("/painel", url).toString(), 301);
    }
    if (path === "/dashboard") {
      return Response.redirect(new URL("/leads", url).toString(), 301);
    }

    if (path === "/leads") return html(LEADS_HTML, env);
    if (path === "/vendas") return html(VENDAS_HTML, env);
    if (path === "/funil") return html(FUNIL_HTML, env);
    if (path === "/meta") return html(META_HTML, env);
    if (path === "/painel") return html(PAINEL_HTML, env);
    if (path === "/ofertas") return html(OFFERS_HTML, env);
    if (path === "/secoes") return html(SECOES_HTML, env);
    if (path === "/checkout-analytics") return html(CHECKOUT_ANALYTICS_HTML, env);

    if (path === "/dashboard/api/stats") {
      return handleStats(request, env);
    }

    if (path === "/dashboard/api/checkout-analytics") {
      if (request.method === "GET") return handleCheckoutAnalyticsReport(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    if (path === "/dashboard/api/sections") {
      if (request.method === "GET") return handleSections(request, env);
      return new Response("Method not allowed", { status: 405 });
    }
    if (path === "/dashboard/api/sections/meta") {
      if (request.method === "GET") return handleSectionsMeta(env);
      return new Response("Method not allowed", { status: 405 });
    }

    if (path === "/dashboard/api/funnel") {
      if (request.method === "GET") return handleFunnel(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    if (path === "/dashboard/api/funnel/utms") {
      if (request.method === "GET") return handleFunnelUtms(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    if (path === "/dashboard/api/funnels") {
      if (request.method === "GET") return handleFunnelsList(env);
      if (request.method === "POST") return handleFunnelCreate(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    const funnelMatch = path.match(/^\/dashboard\/api\/funnels\/(\d+)$/);
    if (funnelMatch) {
      if (request.method === "PUT") return handleFunnelUpdate(request, env, funnelMatch[1]);
      if (request.method === "DELETE") return handleFunnelDelete(env, funnelMatch[1]);
      return new Response("Method not allowed", { status: 405 });
    }

    if (path === "/dashboard/api/settings") {
      if (request.method === "GET") return handleSettingsGet(env);
      if (request.method === "POST") return handleSettingsPost(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    if (path === "/dashboard/api/painel-links") {
      if (request.method === "GET") return handlePainelLinksList(env);
      if (request.method === "POST") return handlePainelLinkCreate(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    const painelLinkMatch = path.match(/^\/dashboard\/api\/painel-links\/(\d+)$/);
    if (painelLinkMatch) {
      if (request.method === "PUT") return handlePainelLinkUpdate(request, env, painelLinkMatch[1]);
      if (request.method === "DELETE") return handlePainelLinkDelete(env, painelLinkMatch[1]);
      return new Response("Method not allowed", { status: 405 });
    }

    if (path === "/dashboard/api/meta/resolve") {
      if (request.method === "GET") return handleResolveCampaign(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    if (path === "/dashboard/api/meta/internal-sales") {
      if (request.method === "GET") return handleMetaInternalSales(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    if (path === "/dashboard/api/meta/accounts") {
      if (request.method === "GET") return handleMetaAccounts(env);
      return new Response("Method not allowed", { status: 405 });
    }
    if (path === "/dashboard/api/meta/campaigns") {
      if (request.method === "GET") return handleMetaCampaigns(request, env);
      return new Response("Method not allowed", { status: 405 });
    }
    if (path === "/dashboard/api/meta/adsets") {
      if (request.method === "GET") return handleMetaAdsets(request, env);
      return new Response("Method not allowed", { status: 405 });
    }
    if (path === "/dashboard/api/meta/ads") {
      if (request.method === "GET") return handleMetaAds(request, env);
      return new Response("Method not allowed", { status: 405 });
    }
    if (path === "/dashboard/api/meta/insights") {
      if (request.method === "GET") return handleMetaInsights(request, env);
      return new Response("Method not allowed", { status: 405 });
    }
    if (path === "/dashboard/api/meta/status") {
      if (request.method === "POST") return handleMetaStatus(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    if (path === "/dashboard/api/meta/table-config") {
      if (request.method === "GET") return handleMetaTableConfigGet(env);
      if (request.method === "PUT") return handleMetaTableConfigPut(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    if (path === "/dashboard/api/offers") {
      if (request.method === "GET") return handleOffersList(env);
      if (request.method === "POST") return handleOfferCreate(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    const offerMatch = path.match(/^\/dashboard\/api\/offers\/(\d+)$/);
    if (offerMatch) {
      if (request.method === "PUT") return handleOfferUpdate(request, env, offerMatch[1]);
      if (request.method === "DELETE") return handleOfferDelete(env, offerMatch[1]);
      return new Response("Method not allowed", { status: 405 });
    }

    if (path === "/dashboard/api/leads/search") {
      if (request.method === "GET") return handleLeadsSearch(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    const leadMatch = path.match(/^\/dashboard\/api\/leads\/(\d+)$/);
    if (leadMatch) {
      if (request.method === "DELETE") return handleLeadDelete(env, leadMatch[1]);
      return new Response("Method not allowed", { status: 405 });
    }

    if (path === "/dashboard/api/sales/search") {
      if (request.method === "GET") return handleSalesSearch(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    if (path === "/dashboard/api/sales/products") {
      if (request.method === "GET") return handleSalesProducts(env);
      return new Response("Method not allowed", { status: 405 });
    }

    if (path === "/dashboard/api/sales/facets") {
      if (request.method === "GET") return handleSalesFacets(env);
      return new Response("Method not allowed", { status: 405 });
    }

    if (path === "/dashboard/api/sales/export") {
      if (request.method === "GET") return handleSalesExport(request, env);
      return new Response("Method not allowed", { status: 405 });
    }

    const salesHistMatch = path.match(/^\/dashboard\/api\/sales\/(\d+)\/history$/);
    if (salesHistMatch) {
      if (request.method === "GET") return handleSalesHistory(env, salesHistMatch[1]);
      return new Response("Method not allowed", { status: 405 });
    }

    const salesDispMatch = path.match(/^\/dashboard\/api\/sales\/(\d+)\/dispatches$/);
    if (salesDispMatch) {
      if (request.method === "GET") return handleSalesDispatches(env, salesDispMatch[1]);
      return new Response("Method not allowed", { status: 405 });
    }

    const salesResendMatch = path.match(/^\/dashboard\/api\/sales\/(\d+)\/resend-email$/);
    if (salesResendMatch) {
      if (request.method === "POST") return handleResendEmail(request, env, salesResendMatch[1]);
      return new Response("Method not allowed", { status: 405 });
    }

    const salesRefundMatch = path.match(/^\/dashboard\/api\/sales\/(\d+)\/refund$/);
    if (salesRefundMatch) {
      if (request.method === "POST") return handleSaleRefund(request, env, salesRefundMatch[1]);
      return new Response("Method not allowed", { status: 405 });
    }

    return new Response("Not found", { status: 404 });
  },
};

// =============== IP filter (dinâmico, vindo de settings.blocked_ips) ===============

async function getBlockedIps(env) {
  try {
    const row = await env.DB
      .prepare("SELECT value FROM settings WHERE key = 'blocked_ips'")
      .first();
    if (!row?.value) return [];
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((e) => (typeof e === "string" ? { value: e, label: "" } : e))
      .filter((e) => e && typeof e.value === "string" && e.value.length > 0);
  } catch {
    return [];
  }
}

async function ipFilter(url, env) {
  if (url.searchParams.get("include_internal") === "1") return "";
  const entries = await getBlockedIps(env);
  return buildIpFilterClause(entries);
}

function buildIpFilterClause(entries) {
  const parts = [];
  for (const e of entries) {
    const conv = ipEntryToSql(e.value);
    if (!conv) continue;
    const patterns = Array.isArray(conv.patterns) ? conv.patterns : [conv.pattern];
    if (conv.kind === "exact") {
      for (const p of patterns) parts.push(`ip != '${p}'`);
    } else {
      for (const p of patterns) parts.push(`ip NOT GLOB '${p}'`);
    }
  }
  if (!parts.length) return "";
  return ` AND (ip IS NULL OR (${parts.join(" AND ")}))`;
}

// Converte uma entrada (IP único ou CIDR) em pattern SQL seguro.
// Retorna { kind: "exact"|"glob", pattern } ou null se inválido.
function ipEntryToSql(input) {
  if (typeof input !== "string") return null;
  const v = input.trim();
  if (!v) return null;
  // whitelist estrita: dígitos hex, ponto, dois pontos, asterisco e barra
  if (!/^[0-9a-fA-F.:*/]+$/.test(v)) return null;

  if (!v.includes("/")) {
    // IP único, sanity check mínimo
    if (v.includes(".") || v.includes(":")) return { kind: "exact", pattern: v };
    return null;
  }

  const [addr, prefStr] = v.split("/");
  const prefix = parseInt(prefStr, 10);
  if (!Number.isFinite(prefix) || prefix < 0) return null;

  // IPv4
  if (addr.includes(".") && !addr.includes(":")) {
    const parts = addr.split(".").map((p) => parseInt(p, 10));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    if (prefix < 0 || prefix > 32) return null;
    if (prefix === 32) return { kind: "exact", pattern: parts.join(".") };
    if (prefix % 8 === 0) {
      const keep = prefix / 8;
      return { kind: "glob", pattern: parts.slice(0, keep).join(".") + ".*" };
    }
    // Prefix não múltiplo de 8: expandir cada /N em conjunto de /24 (ou /16) cobertos.
    const fullOctets = Math.floor(prefix / 8);
    const subBits = prefix - fullOctets * 8;
    const subOctetIdx = fullOctets;
    const remaining = 8 - subBits;
    const blockSize = 1 << remaining;
    const startVal = parts[subOctetIdx] & ((0xff << remaining) & 0xff);
    const patterns = [];
    for (let v = startVal; v < startVal + blockSize && v <= 255; v++) {
      const head = parts.slice(0, subOctetIdx).concat(v).join(".");
      patterns.push(head + (subOctetIdx < 3 ? ".*" : ""));
    }
    return { kind: "glob", patterns };
  }

  // IPv6
  if (addr.includes(":")) {
    if (prefix === 128) return { kind: "exact", pattern: addr };
    if (prefix % 16 !== 0 || prefix < 16 || prefix > 112) return null;
    const blocks = addr.split(":").filter((b) => b !== "");
    const want = prefix / 16;
    if (blocks.length < want) return null;
    return { kind: "glob", pattern: blocks.slice(0, want).join(":") + ":*" };
  }

  return null;
}

// Validação usada na escrita (POST), mais explícita e devolve mensagem.
function validateIpEntry(input) {
  if (typeof input !== "string") return { ok: false, reason: "Valor deve ser string" };
  const v = input.trim();
  if (!v) return { ok: false, reason: "Valor vazio" };
  if (v.length > 64) return { ok: false, reason: "Valor muito longo" };
  if (!/^[0-9a-fA-F.:*/]+$/.test(v)) return { ok: false, reason: "Caracteres inválidos" };
  if (!v.includes("/")) {
    if (!(v.includes(".") || v.includes(":"))) {
      return { ok: false, reason: "Formato não reconhecido (IPv4/IPv6)" };
    }
    return { ok: true, value: v };
  }
  const sql = ipEntryToSql(v);
  if (!sql) {
    return {
      ok: false,
      reason:
        "CIDR inválido. IPv4: prefix 0-32. IPv6: múltiplos de /16 até /128.",
    };
  }
  return { ok: true, value: v };
}

// =============== UTM filter ===============

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_page"];

// Lê UTMs do querystring e devolve { clause, binds }. Usa bind params (seguro).
// `__none__` é um sentinel para filtrar registros sem valor (NULL/'').
function utmFilter(url) {
  const parts = [];
  const binds = [];
  const values = {};
  for (const key of UTM_KEYS) {
    const raw = url.searchParams.get(key);
    if (raw == null) continue;
    const v = String(raw).trim().slice(0, 255);
    if (!v) continue;
    values[key] = v;
    if (v === "__none__") {
      parts.push(`(${key} IS NULL OR ${key} = '')`);
    } else {
      parts.push(`${key} = ?`);
      binds.push(v);
    }
  }
  return { clause: parts.length ? ` AND ${parts.join(" AND ")}` : "", binds, values };
}

function toSqliteDatetime(value) {
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// Retorna a data de hoje em Brasília no formato YYYY-MM-DD.
function brasiliaToday() {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Resolve período (since/until) priorizando start/end customizados sobre o preset range.
function parseDateRange(url) {
  const range = url.searchParams.get("range") || "30d";
  const startRaw = url.searchParams.get("start");
  const endRaw = url.searchParams.get("end");
  const customStart = startRaw ? toSqliteDatetime(startRaw) : null;
  const customEnd = endRaw ? toSqliteDatetime(endRaw) : null;

  let since;
  let until = customEnd;
  if (customStart) {
    since = customStart;
  } else if (range === "today") {
    const today = brasiliaToday();
    since = `${today} 00:00:00`;
    if (!until) until = `${today}T23:59:59.999-03:00`;
  } else if (range === "all" || range === "36m") {
    // A Insights API da Meta limita consultas históricas a 37 meses. Usamos
    // 36 meses para manter uma margem segura e aplicamos o mesmo período ao D1.
    since = `${dateMonthsBefore(brasiliaToday(), 36)} 00:00:00`;
  } else {
    const days = range === "1d" ? 1 : range === "7d" ? 7 : range === "90d" ? 90 : 30;
    since = toSqliteDatetime(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
  }
  return { range, since, until };
}

// =============== Handlers ===============

async function loadFunnel(env, slugOrId) {
  let funnel = null;
  if (slugOrId) {
    if (/^\d+$/.test(slugOrId)) {
      funnel = await env.DB.prepare("SELECT * FROM funnels WHERE id = ?").bind(parseInt(slugOrId, 10)).first();
    } else {
      funnel = await env.DB.prepare("SELECT * FROM funnels WHERE slug = ?").bind(slugOrId).first();
    }
  }
  if (!funnel) {
    funnel = await env.DB
      .prepare("SELECT * FROM funnels WHERE is_default = 1 ORDER BY id LIMIT 1")
      .first();
  }
  if (!funnel) {
    funnel = await env.DB.prepare("SELECT * FROM funnels ORDER BY id LIMIT 1").first();
  }
  if (!funnel) return null;

  const stepsRes = await env.DB
    .prepare(
      "SELECT id, position, key, label, source, match_value FROM funnel_steps WHERE funnel_id = ? ORDER BY position ASC"
    )
    .bind(funnel.id)
    .all();
  return { funnel, steps: stepsRes.results || [] };
}

async function loadFunnelAttributions(db, funnel, ipF, utmF) {
  const identityPredicate = `(
    (meta_campaign_id IS NOT NULL AND meta_campaign_id != '') OR
    (meta_adset_id IS NOT NULL AND meta_adset_id != '') OR
    (meta_ad_id IS NOT NULL AND meta_ad_id != '') OR
    (utm_campaign IS NOT NULL AND utm_campaign != '') OR
    (utm_content IS NOT NULL AND utm_content != '') OR
    (utm_term IS NOT NULL AND utm_term != '')
  )`;
  const legacyIdentityPredicate = `(
    (utm_campaign IS NOT NULL AND utm_campaign != '') OR
    (utm_content IS NOT NULL AND utm_content != '') OR
    (utm_term IS NOT NULL AND utm_term != '')
  )`;
  const fields = "utm_source, utm_medium, utm_campaign, utm_content, utm_term";
  const [views, leads, orders] = await Promise.all([
    db.prepare(
      `SELECT DISTINCT ${fields}, NULL AS meta_campaign_id, NULL AS meta_adset_id, NULL AS meta_ad_id
         FROM page_views
        WHERE funnel = ?${ipF}${utmF.clause}${humanPageViewFilter()} AND ${legacyIdentityPredicate}`
    ).bind(funnel.slug, ...utmF.binds).all(),
    db.prepare(
      `SELECT DISTINCT ${fields}, meta_campaign_id, meta_adset_id, meta_ad_id
         FROM leads
        WHERE funnel = ?${ipF}${utmF.clause} AND ${identityPredicate}`
    ).bind(funnel.slug, ...utmF.binds).all(),
    db.prepare(
      `SELECT DISTINCT ${fields}, meta_campaign_id, meta_adset_id, meta_ad_id
         FROM orders
        WHERE funnel_id = ?${ipF}${utmF.clause} AND ${identityPredicate}`
    ).bind(funnel.id, ...utmF.binds).all(),
  ]);
  return [...(views.results || []), ...(leads.results || []), ...(orders.results || [])];
}

async function loadFunnelMetaInsights(env, range, since, until) {
  const accounts = metaAccountIds(env);
  if (!accounts.length) return { available: false, partial: false, insights: [] };

  const today = brasiliaToday();
  const timeRange = JSON.stringify(metaTimeRange({ range, since, until, today }));
  const settled = await Promise.allSettled(accounts.map((accountId) =>
    metaApiGetAll(env, `/${accountId}/insights`, {
      level: "ad",
      fields: "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions",
      breakdowns: "publisher_platform",
      time_range: timeRange,
      limit: "500",
    })
  ));
  const successful = settled.filter((result) => result.status === "fulfilled");
  return {
    available: successful.length > 0,
    partial: successful.length > 0 && successful.length < settled.length,
    insights: successful.flatMap((result) => result.value || []),
  };
}

async function loadFunnelBusinessMetrics({ db, env, loaded, range, since, until, untilClause, untilBinds, ipF, utmF }) {
  const revenueQuery = db.prepare(
    `SELECT COUNT(*) AS approved_orders,
      COALESCE(SUM(
       CASE
         WHEN paid_amount_cents IS NOT NULL AND paid_amount_cents > 0 THEN paid_amount_cents
         ELSE amount_cents
       END
     ), 0) AS received_cents
       FROM orders
      WHERE status = 'approved'
        AND funnel_id = ?
        AND created_at >= ?${untilClause}${ipF}${utmF.clause}`
  ).bind(loaded.funnel.id, since, ...untilBinds, ...utmF.binds).first();

  const [revenue, attributions, metaResult] = await Promise.all([
    revenueQuery,
    loadFunnelAttributions(db, loaded.funnel, ipF, utmF),
    loadFunnelMetaInsights(env, range, since, until),
  ]);
  const metaScope = metaAttributionScope(attributions, utmF.values);
  const meta = summarizeMetaInsights(metaResult.insights, metaScope);
  const receivedCents = Number(revenue?.received_cents) || 0;
  return {
    impressions: metaResult.available ? meta.impressions : null,
    ...calculateFinancialMetrics({
      spend: meta.spend,
      receivedCents,
      approvedOrders: revenue?.approved_orders,
      metaAvailable: metaResult.available,
    }),
    meta_available: metaResult.available,
    meta_partial: metaResult.partial,
  };
}

async function handleFunnel(request, env) {
  try {
    const url = new URL(request.url);
    const { range, since, until } = parseDateRange(url);
    const uniqueVisits = url.searchParams.get("unique_visits") === "1";

    const db = env.DB;
    const ipF = await ipFilter(url, env);
    const utmF = utmFilter(url);
    const slug = url.searchParams.get("funnel") || url.searchParams.get("slug") || "";
    const loaded = await loadFunnel(env, slug);
    if (!loaded) return json({ range, since, until, unique_visits: uniqueVisits, funnel: null, steps: [] });

    const untilClause = until ? " AND created_at <= ?" : "";
    const untilBinds = until ? [until] : [];

    const funnelSlug = loaded.funnel.slug;
    const queries = loaded.steps.map((s) => {
      // Coluna casada por fonte: page_views.page | leads.status | orders.status
      const column = s.source === "page_view" ? "page" : "status";
      const raw = String(s.match_value || "").trim();
      let matchClause;
      let matchBinds;
      if (raw.includes(",")) {
        const parts = raw.split(",").map((x) => x.trim()).filter(Boolean);
        if (parts.length === 0) {
          matchClause = `${column} = ?`;
          matchBinds = [raw];
        } else {
          matchClause = `${column} IN (${parts.map(() => "?").join(",")})`;
          matchBinds = parts;
        }
      } else if (raw.includes("%") || raw.includes("_")) {
        matchClause = `${column} LIKE ?`;
        matchBinds = [raw];
      } else {
        matchClause = `${column} = ?`;
        matchBinds = [raw];
      }

      // Etapa lendo da tabela canônica `orders` (fonte única de compra).
      // Conta compradores únicos (COUNT DISTINCT lead_id). Atribuição por
      // funnel_id (FK), UTMs nas próprias colunas do order, e filtro de IP
      // via subquery em leads (orders não tem coluna ip).
      if (s.source === "order") {
        // Dedup por pessoa (email > phone > name), igual à etapa lead_status –
        // conta COMPRADORES únicos, não transações (1 pessoa pode ter N pedidos).
        return db
          .prepare(
            `SELECT COUNT(DISTINCT COALESCE(NULLIF(TRIM(LOWER(payer_email)),''), NULLIF(TRIM(LOWER(payer_phone)),''), NULLIF(TRIM(LOWER(payer_name)),''), 'ord_' || id)) AS n FROM orders
              WHERE ${matchClause}
                AND funnel_id = ?
                AND created_at >= ?${untilClause}${ipF}${utmF.clause}`
          )
          .bind(...matchBinds, loaded.funnel.id, since, ...untilBinds, ...utmF.binds)
          .first();
      }

      const table = s.source === "page_view" ? "page_views" : "leads";
      const humanViews = s.source === "page_view" ? humanPageViewFilter() : "";
      // Dedup leads pelo mesmo identificador (email > phone > name) pra não contar
      // múltiplas tentativas da mesma pessoa (ex.: alguém que tenta comprar 3 vezes).
      const countExpr = s.source === "lead_status"
        ? `COUNT(DISTINCT COALESCE(NULLIF(TRIM(LOWER(email)),''), NULLIF(TRIM(LOWER(phone)),''), NULLIF(TRIM(LOWER(name)),''), 'row_' || id))`
        : pageViewCountExpression(uniqueVisits);
      return db
        .prepare(
          `SELECT ${countExpr} AS n FROM ${table} WHERE ${matchClause} AND funnel = ? AND created_at >= ?${untilClause}${ipF}${utmF.clause}${humanViews}`
        )
        .bind(...matchBinds, funnelSlug, since, ...untilBinds, ...utmF.binds)
        .first();
    });
    const [results, businessMetrics] = await Promise.all([
      Promise.all(queries),
      loadFunnelBusinessMetrics({ db, env, loaded, range, since, until, untilClause, untilBinds, ipF, utmF }),
    ]);

    const steps = loaded.steps.map((s, i) => ({
      key: s.key,
      label: s.label,
      value: results[i]?.n ?? 0,
    }));

    const errBinds = until ? [funnelSlug, since, until] : [funnelSlug, since];
    const errRows = await db
      .prepare(
        `SELECT stage, COUNT(*) AS n FROM payment_errors
         WHERE funnel = ? AND created_at >= ?${untilClause}${ipF}${utmF.clause}
         GROUP BY stage`
      )
      .bind(...errBinds, ...utmF.binds)
      .all();
    const byStage = {};
    let totalErrors = 0;
    for (const r of errRows.results || []) {
      const n = Number(r.n) || 0;
      byStage[r.stage] = n;
      totalErrors += n;
    }

    return json({
      range,
      since,
      until,
      unique_visits: uniqueVisits,
      funnel: { id: loaded.funnel.id, slug: loaded.funnel.slug, name: loaded.funnel.name },
      steps,
      business_metrics: businessMetrics,
      payment_errors: { total: totalErrors, by_stage: byStage },
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// Lista valores distintos de cada UTM (com contagem) pra alimentar os dropdowns.
// Filtra por funnel + range (mesmos params do /api/funnel) e respeita IP filter.
async function handleFunnelUtms(request, env) {
  try {
    const url = new URL(request.url);
    const { range, since, until } = parseDateRange(url);
    const countExpr = pageViewCountExpression(url.searchParams.get("unique_visits") === "1");

    const db = env.DB;
    const ipF = await ipFilter(url, env);
    const slug = url.searchParams.get("funnel") || url.searchParams.get("slug") || "";
    const loaded = await loadFunnel(env, slug);
    if (!loaded) return json({ values: {} });
    const funnelSlug = loaded.funnel.slug;

    const untilClause = until ? " AND created_at <= ?" : "";
    const sideBinds = until ? [funnelSlug, since, until] : [funnelSlug, since];

    const queries = UTM_KEYS.map((k) =>
      db
        .prepare(
          `SELECT v, SUM(n) AS n FROM (
             SELECT ${k} AS v, ${countExpr} AS n FROM page_views
              WHERE funnel = ? AND created_at >= ?${untilClause} AND ${k} IS NOT NULL AND ${k} != ''${ipF}${humanPageViewFilter()}
              GROUP BY ${k}
             UNION ALL
             SELECT ${k} AS v, COUNT(*) AS n FROM leads
              WHERE funnel = ? AND created_at >= ?${untilClause} AND ${k} IS NOT NULL AND ${k} != ''${ipF}
              GROUP BY ${k}
           )
           GROUP BY v ORDER BY n DESC LIMIT 100`
        )
        .bind(...sideBinds, ...sideBinds)
        .all()
    );
    const results = await Promise.all(queries);

    const values = {};
    UTM_KEYS.forEach((k, i) => {
      values[k] = (results[i].results || []).map((r) => ({ value: r.v, count: r.n }));
    });

    return json({
      range,
      since,
      until,
      funnel: { id: loaded.funnel.id, slug: loaded.funnel.slug, name: loaded.funnel.name },
      values,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// =============== Funis CRUD ===============

async function handleFunnelsList(env) {
  try {
    const [funnelsRes, stepsRes] = await Promise.all([
      env.DB
        .prepare("SELECT id, slug, name, is_default, created_at, updated_at FROM funnels ORDER BY is_default DESC, id ASC")
        .all(),
      env.DB
        .prepare("SELECT id, funnel_id, position, key, label, source, match_value FROM funnel_steps ORDER BY funnel_id, position")
        .all(),
    ]);
    const stepsByFunnel = new Map();
    for (const s of stepsRes.results || []) {
      if (!stepsByFunnel.has(s.funnel_id)) stepsByFunnel.set(s.funnel_id, []);
      stepsByFunnel.get(s.funnel_id).push(s);
    }
    const funnels = (funnelsRes.results || []).map((f) => ({
      ...f,
      is_default: !!f.is_default,
      steps: stepsByFunnel.get(f.id) || [],
    }));
    return json({ funnels });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

function validateFunnelPayload(body) {
  if (!body || typeof body !== "object") return "Body inválido";
  const slug = String(body.slug || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(slug)) {
    return "Slug inválido (a-z, 0-9, _ e -, até 41 caracteres)";
  }
  const name = String(body.name || "").trim();
  if (!name || name.length > 80) return "Nome obrigatório (até 80 caracteres)";
  if (!Array.isArray(body.steps) || body.steps.length === 0) return "Etapas obrigatórias";
  if (body.steps.length > 20) return "Máximo de 20 etapas";
  const cleanSteps = [];
  const seenKeys = new Set();
  for (const [i, raw] of body.steps.entries()) {
    if (!raw || typeof raw !== "object") return `Etapa ${i + 1} inválida`;
    const key = String(raw.key || "").trim();
    const label = String(raw.label || "").trim();
    const source = String(raw.source || "").trim();
    const matchValue = String(raw.match_value || "").trim();
    if (!/^[a-z0-9_]{1,40}$/.test(key)) return `Etapa ${i + 1}: chave inválida (a-z, 0-9, _)`;
    if (seenKeys.has(key)) return `Etapa ${i + 1}: chave '${key}' duplicada`;
    seenKeys.add(key);
    if (!label || label.length > 80) return `Etapa ${i + 1}: rótulo obrigatório (até 80 caracteres)`;
    if (source !== "page_view" && source !== "lead_status" && source !== "order") {
      return `Etapa ${i + 1}: source deve ser 'page_view', 'lead_status' ou 'order'`;
    }
    if (!matchValue || matchValue.length > 80) {
      return `Etapa ${i + 1}: match_value obrigatório (até 80 caracteres)`;
    }
    cleanSteps.push({ key, label, source, matchValue });
  }
  return { ok: true, slug, name, isDefault: body.is_default ? 1 : 0, steps: cleanSteps };
}

async function handleFunnelCreate(request, env) {
  try {
    const body = await request.json();
    const v = validateFunnelPayload(body);
    if (typeof v === "string") return json({ error: v }, 400);

    if (v.isDefault) {
      await env.DB.prepare("UPDATE funnels SET is_default = 0").run();
    }
    const ins = await env.DB
      .prepare(
        "INSERT INTO funnels (slug, name, is_default, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(v.slug, v.name, v.isDefault)
      .run();
    const id = ins?.meta?.last_row_id;
    if (!id) return json({ error: "Falha ao criar funil" }, 500);

    const insertStep = env.DB.prepare(
      "INSERT INTO funnel_steps (funnel_id, position, key, label, source, match_value) VALUES (?, ?, ?, ?, ?, ?)"
    );
    await env.DB.batch(
      v.steps.map((s, i) => insertStep.bind(id, i + 1, s.key, s.label, s.source, s.matchValue))
    );
    return json({ ok: true, id });
  } catch (err) {
    if (String(err?.message || "").includes("UNIQUE")) {
      return json({ error: "Já existe um funil com esse slug" }, 409);
    }
    return json({ error: err.message }, 500);
  }
}

async function handleFunnelUpdate(request, env, idStr) {
  try {
    const id = parseInt(idStr, 10);
    if (!Number.isInteger(id) || id <= 0) return json({ error: "ID inválido" }, 400);

    const existing = await env.DB.prepare("SELECT id FROM funnels WHERE id = ?").bind(id).first();
    if (!existing) return json({ error: "Funil não encontrado" }, 404);

    const body = await request.json();
    const v = validateFunnelPayload(body);
    if (typeof v === "string") return json({ error: v }, 400);

    if (v.isDefault) {
      await env.DB.prepare("UPDATE funnels SET is_default = 0 WHERE id != ?").bind(id).run();
    }
    await env.DB
      .prepare(
        "UPDATE funnels SET slug = ?, name = ?, is_default = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .bind(v.slug, v.name, v.isDefault, id)
      .run();
    await env.DB.prepare("DELETE FROM funnel_steps WHERE funnel_id = ?").bind(id).run();

    const insertStep = env.DB.prepare(
      "INSERT INTO funnel_steps (funnel_id, position, key, label, source, match_value) VALUES (?, ?, ?, ?, ?, ?)"
    );
    await env.DB.batch(
      v.steps.map((s, i) => insertStep.bind(id, i + 1, s.key, s.label, s.source, s.matchValue))
    );
    return json({ ok: true, id });
  } catch (err) {
    if (String(err?.message || "").includes("UNIQUE")) {
      return json({ error: "Já existe um funil com esse slug" }, 409);
    }
    return json({ error: err.message }, 500);
  }
}

async function handleFunnelDelete(env, idStr) {
  try {
    const id = parseInt(idStr, 10);
    if (!Number.isInteger(id) || id <= 0) return json({ error: "ID inválido" }, 400);
    await env.DB.prepare("DELETE FROM funnel_steps WHERE funnel_id = ?").bind(id).run();
    const res = await env.DB.prepare("DELETE FROM funnels WHERE id = ?").bind(id).run();
    if ((res.meta?.changes ?? 0) === 0) return json({ error: "Funil não encontrado" }, 404);
    return json({ ok: true, id });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// =============== Painel links CRUD ===============

const PAINEL_LINK_TYPES = new Set(["public", "internal", "external"]);

function validatePainelLinkPayload(body) {
  if (!body || typeof body !== "object") return "Body inválido";
  const type = String(body.type || "").trim().toLowerCase();
  if (!PAINEL_LINK_TYPES.has(type)) {
    return "Tipo inválido (public, internal ou external)";
  }
  const name = String(body.name || "").trim();
  if (!name || name.length > 80) return "Nome obrigatório (até 80 caracteres)";
  const description = String(body.description || "").trim();
  if (description.length > 200) return "Descrição até 200 caracteres";
  const url = String(body.url || "").trim();
  if (!url || url.length > 2000) return "URL obrigatória (até 2000 caracteres)";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "URL deve usar http ou https";
    }
  } catch {
    return "URL inválida";
  }
  let position = parseInt(body.position, 10);
  if (!Number.isFinite(position)) position = 0;
  position = Math.max(0, Math.min(position, 100000));
  return { ok: true, type, name, description, url, position };
}

async function handlePainelLinksList(env) {
  try {
    const res = await env.DB
      .prepare(
        "SELECT id, type, name, description, url, position, created_at, updated_at FROM painel_links ORDER BY position ASC, id ASC"
      )
      .all();
    return json({ links: res.results || [] });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function handlePainelLinkCreate(request, env) {
  try {
    const body = await request.json();
    const v = validatePainelLinkPayload(body);
    if (typeof v === "string") return json({ error: v }, 400);

    let position = v.position;
    if (position === 0) {
      const last = await env.DB
        .prepare("SELECT COALESCE(MAX(position), 0) AS p FROM painel_links")
        .first();
      position = (last?.p ?? 0) + 10;
    }

    const ins = await env.DB
      .prepare(
        "INSERT INTO painel_links (type, name, description, url, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
      )
      .bind(v.type, v.name, v.description, v.url, position)
      .run();
    const id = ins?.meta?.last_row_id;
    if (!id) return json({ error: "Falha ao criar link" }, 500);
    return json({ ok: true, id });
  } catch (err) {
    if (String(err?.message || "").includes("UNIQUE")) {
      return json({ error: "Já existe um link com essa URL" }, 409);
    }
    return json({ error: err.message }, 500);
  }
}

async function handlePainelLinkUpdate(request, env, idStr) {
  try {
    const id = parseInt(idStr, 10);
    if (!Number.isInteger(id) || id <= 0) return json({ error: "ID inválido" }, 400);

    const existing = await env.DB.prepare("SELECT id FROM painel_links WHERE id = ?").bind(id).first();
    if (!existing) return json({ error: "Link não encontrado" }, 404);

    const body = await request.json();
    const v = validatePainelLinkPayload(body);
    if (typeof v === "string") return json({ error: v }, 400);

    await env.DB
      .prepare(
        "UPDATE painel_links SET type = ?, name = ?, description = ?, url = ?, position = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .bind(v.type, v.name, v.description, v.url, v.position, id)
      .run();
    return json({ ok: true, id });
  } catch (err) {
    if (String(err?.message || "").includes("UNIQUE")) {
      return json({ error: "Já existe um link com essa URL" }, 409);
    }
    return json({ error: err.message }, 500);
  }
}

async function handlePainelLinkDelete(env, idStr) {
  try {
    const id = parseInt(idStr, 10);
    if (!Number.isInteger(id) || id <= 0) return json({ error: "ID inválido" }, 400);
    const res = await env.DB.prepare("DELETE FROM painel_links WHERE id = ?").bind(id).run();
    if ((res.meta?.changes ?? 0) === 0) return json({ error: "Link não encontrado" }, 404);
    return json({ ok: true, id });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// =============== Meta API resolver (campaign by name) ===============

// Extrai a mensagem mais útil de um erro da Meta. A Meta manda "message" genérico
// ("Permissions error") mas costuma ter um texto bem mais claro em error_user_msg/title
// (ex.: "O usuário não tem permissão para esta ação"). Mostra esse quando existe.
function metaErrMsg(j, r) {
  const e = j && j.error;
  if (e) {
    const detail = e.error_user_msg || e.error_user_title;
    if (detail && detail !== e.message) return `${e.message}: ${detail}`;
    return e.message || `HTTP ${r.status}`;
  }
  return r.statusText || `HTTP ${r.status}`;
}

async function metaApiGet(env, path, params = {}) {
  if (!env.META_ACCESS_TOKEN) throw new Error("META_ACCESS_TOKEN não configurado no worker");
  const url = new URL(`https://graph.facebook.com/${env.META_API_VERSION || "v25.0"}${path}`);
  url.searchParams.set("access_token", env.META_ACCESS_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString());
  const j = await r.json();
  if (!r.ok || j.error) {
    throw new Error("Meta API: " + metaErrMsg(j, r));
  }
  return j;
}

// GET paginado: segue os cursores 'next' server-side e devolve o array agregado.
// (O client não pode seguir paging.next porque a URL aponta pro graph.facebook.com,
//  bloqueado por Tracking Prevention de Edge/Brave/Firefox.)
async function metaApiGetAll(env, path, params = {}) {
  if (!env.META_ACCESS_TOKEN) throw new Error("META_ACCESS_TOKEN não configurado no worker");
  const base = `https://graph.facebook.com/${env.META_API_VERSION || "v25.0"}`;
  const url = new URL(`${base}${path}`);
  url.searchParams.set("access_token", env.META_ACCESS_TOKEN);
  if (params.limit === undefined) url.searchParams.set("limit", "100");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  let next = url.toString();
  const all = [];
  for (let guard = 0; next && guard < 50; guard++) {
    const r = await fetch(next);
    const j = await r.json();
    if (!r.ok || j.error) throw new Error("Meta API: " + metaErrMsg(j, r));
    if (Array.isArray(j.data)) all.push(...j.data);
    next = j.paging && j.paging.next ? j.paging.next : null;
  }
  return all;
}

async function metaApiPost(env, path, body = {}) {
  if (!env.META_ACCESS_TOKEN) throw new Error("META_ACCESS_TOKEN não configurado no worker");
  const base = `https://graph.facebook.com/${env.META_API_VERSION || "v25.0"}`;
  const form = new URLSearchParams({ access_token: env.META_ACCESS_TOKEN, ...body });
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString()
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error("Meta API: " + metaErrMsg(j, r));
  return j;
}

function metaAcct(env) {
  const acct = env.META_AD_ACCOUNT_ID;
  if (!acct) throw new Error("META_AD_ACCOUNT_ID não configurado");
  return acct;
}

// Conta vinda do request (?account_id=act_…) com validação de formato; cai pro default do env.
function metaAcctFrom(request, env) {
  const raw = (new URL(request.url).searchParams.get("account_id") || "").trim();
  if (!raw) return metaAcct(env);
  if (!/^act_\d{6,30}$/.test(raw)) throw new Error("account_id inválido");
  return raw;
}

// Lista as contas de anúncios que o token acessa (pra popular o seletor da UI).
async function handleMetaAccounts(env) {
  try {
    const data = await metaApiGetAll(env, `/me/adaccounts`, { fields: "account_id,name" });
    return json({ data: data.map((a) => ({ id: a.id || `act_${a.account_id}`, name: a.name || a.account_id })) });
  } catch (e) { return json({ error: e.message }, 502); }
}

async function handleMetaCampaigns(request, env) {
  try {
    const data = await metaApiGetAll(env, `/${metaAcctFrom(request, env)}/campaigns`, { fields: "id,name,status,effective_status" });
    return json({ data });
  } catch (e) { return json({ error: e.message }, 502); }
}

async function handleMetaAdsets(request, env) {
  try {
    const cid = (new URL(request.url).searchParams.get("campaign_id") || "").trim();
    if (!/^\d{6,30}$/.test(cid)) return json({ error: "campaign_id inválido" }, 400);
    const data = await metaApiGetAll(env, `/${cid}/adsets`, { fields: "id,name,status,effective_status" });
    return json({ data });
  } catch (e) { return json({ error: e.message }, 502); }
}

async function handleMetaAds(request, env) {
  try {
    const cid = (new URL(request.url).searchParams.get("campaign_id") || "").trim();
    if (!/^\d{6,30}$/.test(cid)) return json({ error: "campaign_id inválido" }, 400);
    const accountId = metaAcctFrom(request, env);
    const data = await metaApiGetAll(env, `/${cid}/ads`, {
      fields: "id,name,status,effective_status,adset_id,creative{id,thumbnail_url,image_url,link_url,object_url,call_to_action,object_story_spec,asset_feed_spec}"
    });

    // thumbnail_url tem apenas 64 px para criativos dinâmicos. Busca os assets
    // originais uma única vez por campanha, mantendo o token da Meta no worker.
    const hashes = [...new Set(data.flatMap((ad) => creativeImageHashes(ad.creative)))];
    let originalImageByHash = new Map();
    if (hashes.length) {
      try {
        const images = await metaApiGetAll(env, `/${accountId}/adimages`, {
          fields: "hash,url,width,height",
          hashes: JSON.stringify(hashes),
        });
        originalImageByHash = new Map(images
          .filter((image) => image && typeof image.hash === "string" && typeof image.url === "string")
          .map((image) => [image.hash, image.url]));
      } catch (e) {
        // A tabela continua funcional para contas sem acesso ao asset original.
        console.warn("Não foi possível carregar imagens originais da Meta", e);
      }
    }

    return json({
      data: data.map((ad) => ({
        ...ad,
        destination_url: creativeDestinationUrl(ad.creative),
        original_image_urls: creativeImageHashes(ad.creative)
          .map((hash) => originalImageByHash.get(hash))
          .filter(Boolean),
      })),
    });
  } catch (e) { return json({ error: e.message }, 502); }
}

async function handleMetaInsights(request, env) {
  try {
    const url = new URL(request.url);
    const time_range = url.searchParams.get("time_range") || "";
    const filtering = url.searchParams.get("filtering") || "";
    if (!time_range) return json({ error: "time_range é obrigatório" }, 400);
    try { JSON.parse(time_range); } catch { return json({ error: "time_range inválido" }, 400); }
    const params = {
      level: "ad",
      fields: "ad_id,ad_name,spend,inline_link_clicks,impressions,actions",
      time_range
    };
    if (filtering) {
      try { JSON.parse(filtering); } catch { return json({ error: "filtering inválido" }, 400); }
      params.filtering = filtering;
    }
    const data = await metaApiGetAll(env, `/${metaAcctFrom(request, env)}/insights`, params);
    return json({ data });
  } catch (e) { return json({ error: e.message }, 502); }
}

async function handleMetaStatus(request, env) {
  try {
    const body = await request.json().catch(() => null);
    const objectId = String(body?.object_id || "").trim();
    const status = String(body?.status || "").trim().toUpperCase();
    if (!/^\d{6,30}$/.test(objectId)) return json({ error: "object_id inválido" }, 400);
    if (status !== "ACTIVE" && status !== "PAUSED") return json({ error: "status inválido (ACTIVE|PAUSED)" }, 400);
    const result = await metaApiPost(env, `/${objectId}`, { status });
    return json({ ok: true, result });
  } catch (e) { return json({ error: e.message }, 502); }
}

async function resolveCampaignByName(env, name) {
  const acct = env.META_AD_ACCOUNT_ID;
  if (!acct) throw new Error("META_AD_ACCOUNT_ID não configurado");
  const target = String(name || "").trim().toLowerCase();
  if (!target) throw new Error("Nome vazio");

  let next = `/${acct}/campaigns`;
  let after = null;
  for (let pages = 0; pages < 5; pages++) {
    const params = { fields: "id,name,effective_status", limit: "100" };
    if (after) params.after = after;
    const j = await metaApiGet(env, next, params);
    const matches = (j.data || []).filter((c) => String(c.name || "").trim().toLowerCase() === target);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`Mais de uma campanha com nome "${name}", passe Campaign ID manualmente`);
    }
    after = j.paging?.cursors?.after;
    if (!after || !j.paging?.next) break;
  }
  throw new Error(`Campanha "${name}" não encontrada na conta`);
}

async function resolveAdsetForCampaign(env, campaignId) {
  const j = await metaApiGet(env, `/${campaignId}/adsets`, { fields: "id,name,status", limit: "5" });
  const list = j.data || [];
  if (list.length === 0) return null;
  const active = list.find((a) => a.status === "ACTIVE");
  return (active || list[0]).id;
}

async function handleResolveCampaign(request, env) {
  try {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") || "";
    if (!name.trim()) return json({ error: "Parâmetro 'name' é obrigatório" }, 400);
    const camp = await resolveCampaignByName(env, name);
    const adset_id = await resolveAdsetForCampaign(env, camp.id);
    return json({ ok: true, campaign_id: camp.id, name: camp.name, effective_status: camp.effective_status, adset_id });
  } catch (err) {
    return json({ error: err.message }, 400);
  }
}

// Conta leads com status='comprou' agrupados por utm_term (= {{ad.name}})
// dentro de um intervalo de datas (Brasília). Filtro por utm_campaign
// (= {{campaign.name}}) é obrigatório pra evitar colisão entre ads de
// nome igual em campanhas diferentes (ex.: ad "3" existe em várias).
async function handleMetaInternalSales(request, env) {
  try {
    const url = new URL(request.url);
    const since = url.searchParams.get("since") || "";
    const until = url.searchParams.get("until") || "";
    const campaign = (url.searchParams.get("campaign") || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      return json({ error: "Parâmetros 'since' e 'until' (YYYY-MM-DD) são obrigatórios" }, 400);
    }
    if (!campaign) {
      return json({ error: "Parâmetro 'campaign' (nome da campanha) é obrigatório" }, 400);
    }
    const ipF = await ipFilter(url, env);
    // Cruza compras reais (orders status='approved') com a Meta em DUAS camadas,
    // sem dupla contagem (cada order cai em exatamente um mapa):
    //   by_id   = orders QUE TÊM meta_ad_id  -> chaveado por meta_ad_id  (robusto a renomear)
    //   by_name = orders SEM meta_ad_id      -> chaveado por utm_term (= {{ad.name}}, legado)
    // O frontend soma by_id[ad.id] + by_name[ad.name] pra cada anúncio.
    // 1 order = 1 Purchase (alinhado ao modelo da Meta). Filtro de IP plano em orders.ip.
    const [rId, rName] = await Promise.all([
      env.DB.prepare(
        `SELECT meta_ad_id AS k, COUNT(*) AS n FROM orders
         WHERE status = 'approved'
           AND meta_ad_id IS NOT NULL AND meta_ad_id != ''
           AND utm_campaign = ?
           AND SUBSTR(created_at, 1, 10) BETWEEN ? AND ?${ipF}
         GROUP BY meta_ad_id`
      ).bind(campaign, since, until).all(),
      env.DB.prepare(
        `SELECT utm_term AS k, COUNT(*) AS n FROM orders
         WHERE status = 'approved'
           AND (meta_ad_id IS NULL OR meta_ad_id = '')
           AND utm_term IS NOT NULL AND utm_term != ''
           AND utm_campaign = ?
           AND SUBSTR(created_at, 1, 10) BETWEEN ? AND ?${ipF}
         GROUP BY utm_term`
      ).bind(campaign, since, until).all(),
    ]);
    const by_id = {};
    for (const row of (rId.results || [])) by_id[String(row.k)] = Number(row.n) || 0;
    const by_name = {};
    for (const row of (rName.results || [])) by_name[String(row.k)] = Number(row.n) || 0;
    // counts: alias legado (= by_name) pra compatibilidade com consumidores antigos.
    return json({ by_id, by_name, counts: by_name, since, until, campaign });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// =============== Offers ===============

function validateOfferPayload(body, { requireCode = true } = {}) {
  if (!body || typeof body !== "object") return "Payload inválido";
  const code = String(body.code || "").trim().toLowerCase();
  if (requireCode) {
    if (!code) return "Code é obrigatório";
    if (!/^[a-z0-9-]{1,64}$/.test(code)) return "Code deve conter apenas letras minúsculas, números e hífen";
  }
  const name = String(body.name || "").trim();
  if (!name) return "Nome é obrigatório";
  if (name.length > 200) return "Nome muito longo";

  const description = body.description == null ? null : String(body.description).trim().slice(0, 1000) || null;

  const anchor = Number(body.anchor_price_cents);
  if (!Number.isFinite(anchor) || anchor < 0 || anchor > 100000000) return "Preço de âncora inválido";
  const sale = Number(body.sale_price_cents);
  if (!Number.isFinite(sale) || sale < 0 || sale > 100000000) return "Preço de venda inválido";

  const email_subject = body.email_subject == null ? null : String(body.email_subject).trim().slice(0, 200) || null;
  const email_body = body.email_body == null ? null : String(body.email_body).trim().slice(0, 4000) || null;

  let email_access_url = body.email_access_url == null ? null : String(body.email_access_url).trim().slice(0, 500) || null;
  if (email_access_url) {
    // Vira o botão do e-mail: precisa ser uma URL absoluta http(s).
    let parsed = null;
    try { parsed = new URL(email_access_url); } catch { parsed = null; }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      return "Link de acesso inválido (use uma URL completa http:// ou https://)";
    }
  }

  let thanks_url = body.thanks_url == null ? null : String(body.thanks_url).trim().slice(0, 500) || null;
  if (thanks_url) {
    // Aceita path relativo (/obrigado, /obrigado-produto) ou URL absoluta http(s).
    if (!/^\/[A-Za-z0-9/_\-?.=&%#]+$/.test(thanks_url) && !/^https?:\/\//.test(thanks_url)) {
      return "URL de obrigado inválida (use caminho /xxx ou https://...)";
    }
  }

  let meta_pixel_id = body.meta_pixel_id == null ? null : String(body.meta_pixel_id).trim() || null;
  if (meta_pixel_id && !/^[0-9]{6,20}$/.test(meta_pixel_id)) {
    return "Pixel ID inválido (apenas dígitos, 6 a 20 caracteres)";
  }
  // Token da CAPI nunca volta ao navegador. Campo ausente ou null mantém o valor
  // salvo (undefined = "não mexer"); "" remove; texto novo substitui.
  const meta_capi_token = body.meta_capi_token == null
    ? undefined
    : String(body.meta_capi_token).trim().slice(0, 1000) || null;

  const is_active = body.is_active ? 1 : 0;
  const email_enabled = body.email_enabled ? 1 : 0;
  const out_of_stock = body.out_of_stock ? 1 : 0;

  const bumpValidation = validateOrderBumps(body.order_bumps);
  if (!bumpValidation.ok) return bumpValidation.error;

  return {
    ok: true,
    code,
    name,
    description,
    anchor_price_cents: Math.round(anchor),
    sale_price_cents: Math.round(sale),
    email_subject,
    email_body,
    email_access_url,
    thanks_url,
    meta_pixel_id,
    meta_capi_token,
    is_active,
    email_enabled,
    out_of_stock,
    order_bumps: bumpValidation.bumps,
  };
}

async function offerOrderBumpSyncStatements(env, offerId, bumps) {
  const current = await env.DB.prepare("SELECT id FROM order_bumps WHERE offer_id = ?").bind(offerId).all();
  const currentIds = new Set((current.results || []).map((row) => Number(row.id)));
  const submittedIds = bumps.filter((bump) => bump.id != null).map((bump) => Number(bump.id));
  for (const id of submittedIds) {
    if (!currentIds.has(id)) throw new Error(`Order bump ${id} não pertence a esta oferta`);
  }

  const statements = [];
  for (const bump of bumps) {
    if (bump.id != null) {
      statements.push(env.DB.prepare(
        `UPDATE order_bumps
         SET name = ?, description = ?, price_cents = ?, is_active = ?, position = ?, updated_at = (datetime('now', '-3 hours') || '-03:00')
         WHERE id = ? AND offer_id = ?`
      ).bind(bump.name, bump.description, bump.price_cents, bump.is_active, bump.position, bump.id, offerId));
    } else {
      statements.push(env.DB.prepare(
        "INSERT INTO order_bumps (offer_id, name, description, price_cents, is_active, position) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(offerId, bump.name, bump.description, bump.price_cents, bump.is_active, bump.position));
    }
  }

  const idsToDelete = [...currentIds].filter((id) => !submittedIds.includes(id));
  if (idsToDelete.length) {
    const placeholders = idsToDelete.map(() => "?").join(",");
    statements.push(env.DB.prepare(`DELETE FROM order_bumps WHERE offer_id = ? AND id IN (${placeholders})`).bind(offerId, ...idsToDelete));
  }
  return statements;
}

async function handleOffersList(env) {
  try {
    const [res, bumpRes] = await Promise.all([
      env.DB.prepare(
        "SELECT id, code, name, description, anchor_price_cents, sale_price_cents, is_active, email_enabled, email_subject, email_body, email_access_url, out_of_stock, thanks_url, meta_pixel_id, (meta_capi_token IS NOT NULL AND meta_capi_token != '') AS meta_capi_token_set, created_at, updated_at FROM offers ORDER BY is_active DESC, id DESC"
      ).all(),
      env.DB.prepare(
        "SELECT id, offer_id, name, description, price_cents, is_active, position FROM order_bumps ORDER BY offer_id, position, id"
      ).all(),
    ]);
    const bumpsByOffer = new Map();
    for (const bump of (bumpRes.results || [])) {
      if (!bumpsByOffer.has(bump.offer_id)) bumpsByOffer.set(bump.offer_id, []);
      bumpsByOffer.get(bump.offer_id).push(bump);
    }
    const offers = (res.results || []).map((o) => ({
      ...o,
      meta_capi_token_set: Number(o.meta_capi_token_set) === 1,
      order_bumps: bumpsByOffer.get(o.id) || [],
    }));
    return json({ offers });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function handleOfferCreate(request, env) {
  try {
    const body = (await request.json()) || {};
    const v = validateOfferPayload(body);
    if (typeof v === "string") return json({ error: v }, 400);

    const createOffer = env.DB
      .prepare(
        "INSERT INTO offers (code, name, description, anchor_price_cents, sale_price_cents, is_active, email_enabled, email_subject, email_body, email_access_url, out_of_stock, thanks_url, meta_pixel_id, meta_capi_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(v.code, v.name, v.description, v.anchor_price_cents, v.sale_price_cents, v.is_active, v.email_enabled, v.email_subject, v.email_body, v.email_access_url, v.out_of_stock, v.thanks_url, v.meta_pixel_id, v.meta_capi_token ?? null);
    const statements = [createOffer];
    for (const bump of v.order_bumps) {
      statements.push(env.DB.prepare(
        `INSERT INTO order_bumps (offer_id, name, description, price_cents, is_active, position)
         SELECT id, ?, ?, ?, ?, ? FROM offers WHERE code = ?`
      ).bind(bump.name, bump.description, bump.price_cents, bump.is_active, bump.position, v.code));
    }
    const results = await env.DB.batch(statements);
    const id = results?.[0]?.meta?.last_row_id;
    if (!id) return json({ error: "Falha ao criar oferta" }, 500);
    return json({ ok: true, id, code: v.code });
  } catch (err) {
    if (String(err?.message || "").includes("UNIQUE")) {
      return json({ error: "Já existe uma oferta com esse code" }, 409);
    }
    return json({ error: err.message }, 500);
  }
}

async function handleOfferUpdate(request, env, idStr) {
  try {
    const id = parseInt(idStr, 10);
    if (!Number.isInteger(id) || id <= 0) return json({ error: "ID inválido" }, 400);

    const existing = await env.DB.prepare("SELECT id, code FROM offers WHERE id = ?").bind(id).first();
    if (!existing) return json({ error: "Oferta não encontrada" }, 404);

    const body = await request.json();
    const v = validateOfferPayload(body);
    if (typeof v === "string") return json({ error: v }, 400);

    // O `code` é o slug usado em /checkout/<code>, manter imutável evita quebrar links.
    if (v.code !== existing.code) {
      return json({ error: "Code não pode ser alterado após a criação" }, 400);
    }

    // meta_capi_token só entra no UPDATE quando o payload pediu mudança.
    const keepToken = v.meta_capi_token === undefined;
    const updateOffer = env.DB
      .prepare(
        `UPDATE offers SET name = ?, description = ?, anchor_price_cents = ?, sale_price_cents = ?, is_active = ?, email_enabled = ?, email_subject = ?, email_body = ?, email_access_url = ?, out_of_stock = ?, thanks_url = ?, meta_pixel_id = ?${keepToken ? "" : ", meta_capi_token = ?"}, updated_at = (datetime('now', '-3 hours') || '-03:00') WHERE id = ?`
      )
      .bind(
        v.name, v.description, v.anchor_price_cents, v.sale_price_cents, v.is_active, v.email_enabled, v.email_subject, v.email_body, v.email_access_url, v.out_of_stock, v.thanks_url, v.meta_pixel_id,
        ...(keepToken ? [] : [v.meta_capi_token]),
        id,
      );
    const bumpStatements = await offerOrderBumpSyncStatements(env, id, v.order_bumps);
    await env.DB.batch([updateOffer, ...bumpStatements]);
    return json({ ok: true, id });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function handleOfferDelete(env, idStr) {
  try {
    const id = parseInt(idStr, 10);
    if (!Number.isInteger(id) || id <= 0) return json({ error: "ID inválido" }, 400);
    const res = await env.DB.prepare("DELETE FROM offers WHERE id = ?").bind(id).run();
    if ((res.meta?.changes ?? 0) === 0) return json({ error: "Oferta não encontrada" }, 404);
    return json({ ok: true, id });
  } catch (err) {
    if (String(err?.message || "").toLowerCase().includes("foreign key")) {
      return json({ error: "Não dá pra deletar, há pagamentos vinculados a essa oferta. Desative em vez de deletar." }, 409);
    }
    return json({ error: err.message }, 500);
  }
}

async function handleLeadsSearch(request, env) {
  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim();
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 1), 200);
    const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);
    const ipF = await ipFilter(url, env);

    if (!q) {
      const [countRow, res] = await Promise.all([
        env.DB.prepare(
          `SELECT COUNT(*) AS n FROM leads
           WHERE (name != '' OR email != '' OR phone != '')${ipF}`
        ).first(),
        env.DB
          .prepare(
            `SELECT id, name, email, phone, method, status, created_at, utm_page
             FROM leads
             WHERE (name != '' OR email != '' OR phone != '')${ipF}
             ORDER BY created_at DESC LIMIT ? OFFSET ?`
          )
          .bind(limit, offset)
          .all(),
      ]);
      return json({
        q,
        total: countRow?.n ?? 0,
        limit,
        offset,
        results: res.results ?? [],
      });
    }

    const pattern = `%${q.replace(/[%_]/g, (c) => "\\" + c)}%`;
    const [countRow, res] = await Promise.all([
      env.DB
        .prepare(
          `SELECT COUNT(*) AS n FROM leads
           WHERE (name LIKE ?1 ESCAPE '\\'
              OR email LIKE ?1 ESCAPE '\\'
              OR phone LIKE ?1 ESCAPE '\\')${ipF}`
        )
        .bind(pattern)
        .first(),
      env.DB
        .prepare(
          `SELECT id, name, email, phone, method, status, created_at, utm_page
           FROM leads
           WHERE (name LIKE ?1 ESCAPE '\\'
              OR email LIKE ?1 ESCAPE '\\'
              OR phone LIKE ?1 ESCAPE '\\')${ipF}
           ORDER BY created_at DESC LIMIT ?2 OFFSET ?3`
        )
        .bind(pattern, limit, offset)
        .all(),
    ]);

    return json({
      q,
      total: countRow?.n ?? 0,
      limit,
      offset,
      results: res.results ?? [],
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function handleLeadDelete(env, id) {
  try {
    const leadId = parseInt(id, 10);
    if (!Number.isInteger(leadId) || leadId <= 0) {
      return json({ error: "ID inválido" }, 400);
    }
    const res = await env.DB.prepare("DELETE FROM leads WHERE id = ?").bind(leadId).run();
    const deleted = res.meta?.changes ?? 0;
    if (deleted === 0) return json({ error: "Lead não encontrada" }, 404);
    return json({ ok: true, id: leadId });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// =============== Vendas (sales) ===============

const PAYMENT_ERROR_LABELS = {
  pix_create:   "erro ao gerar PIX",
  card_create:  "erro no cartão",
  card_rejected:"cartão rejeitado",
  card_token:   "erro ao tokenizar cartão",
  network:      "erro de rede",
};

const METHOD_DISPLAY = {
  pix: "Pix",
  Pix: "Pix",
  card: "Cartão",
  credit_card: "Cartão",
  Cartão: "Cartão",
};
function displayMethod(m) {
  if (!m) return "";
  return METHOD_DISPLAY[m] || METHOD_DISPLAY[String(m).toLowerCase()] || m;
}

function tsValue(s) {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

// Determina status final de uma venda olhando 3 fontes (lead, último payment, último erro).
function deriveStatus(row) {
  // Estorno/chargeback é pós-compra: vence tudo.
  const reversal = (row.reversal_status || "").toLowerCase();
  if (reversal === "refunded")   return { label: "reembolsado", kind: "error", at: row.reversal_at };
  if (reversal === "chargeback") return { label: "chargeback",  kind: "error", at: row.reversal_at };

  // Entre o aceite do endpoint de reembolso e a confirmação final do Mercado
  // Pago, deixa a operação visível e impede uma nova solicitação.
  const refundRequest = (row.refund_request_status || "").toLowerCase();
  if (refundRequest === "approved") {
    return { label: "reembolsado", kind: "error", at: row.refund_request_at };
  }
  if (refundRequest === "requested" || refundRequest === "in_process") {
    return { label: "reembolso em processamento", kind: "warn", at: row.refund_request_at };
  }

  // Compra confirmada vence qualquer pendência/erro posterior (ex.: cliente voltou
  // e gerou novo Pix, ou o lead.updated_at foi bumpado depois da aprovação). Sem
  // isso, a venda voltava a aparecer como "pix gerado" no /vendas.
  if (row.approved_at_max || (row.lead_status || "").toLowerCase() === "comprou") {
    return { label: "comprou", kind: "success", at: row.approved_at_max || row.l_updated_at || row.l_created_at };
  }

  const tLead = tsValue(row.l_updated_at || row.l_created_at);
  const tPay  = tsValue(row.last_payment_at);
  const tErr  = tsValue(row.last_error_at);
  const max   = Math.max(tLead, tPay, tErr);

  if (max > 0 && tErr === max) {
    const stage = row.last_error_stage || "";
    return {
      label: PAYMENT_ERROR_LABELS[stage] || "erro no pagamento",
      kind: "error",
      at: row.last_error_at,
    };
  }
  if (max > 0 && tPay === max) {
    const ps = (row.last_payment_status || "").toLowerCase();
    if (ps === "approved") return { label: "comprou", kind: "success", at: row.last_payment_at };
    if (ps === "rejected" || ps === "cancelled") return { label: "pagamento rejeitado", kind: "error", at: row.last_payment_at };
    if (ps === "pending" || ps === "in_process" || ps === "authorized") {
      const m = displayMethod(row.last_payment_method);
      return { label: m === "Cartão" ? "cartão pendente" : "pix gerado", kind: "warn", at: row.last_payment_at };
    }
    return { label: ps || "pagamento", kind: "muted", at: row.last_payment_at };
  }
  // Cai no status do lead
  const ls = (row.lead_status || "").toLowerCase();
  if (ls === "comprou") return { label: "comprou", kind: "success", at: row.l_updated_at || row.l_created_at };
  if (ls === "pix_gerado") return { label: "pix gerado", kind: "warn", at: row.l_updated_at || row.l_created_at };
  if (ls === "escolheu_metodo") return { label: "escolheu método", kind: "info", at: row.l_updated_at || row.l_created_at };
  if (ls === "nome" || ls === "email" || ls === "telefone") {
    return { label: "preencheu dados", kind: "info", at: row.l_updated_at || row.l_created_at };
  }
  return { label: ls || "–", kind: "muted", at: row.l_updated_at || row.l_created_at };
}

// Nome do produto pra exibição. Ordem de preferência:
// 1) nome da oferta do último pagamento (join payments→offers);
// 2) nome da oferta casada pelo código gravado em leads.product (offers.code);
// 3) o próprio código cru (fallback p/ códigos antigos/truncados sem match);
// 4) "–".
// Sem o passo 2, leads sem pagamento (ex.: "preencheu dados") mostravam o slug
// cru (ex.: produto-exemplo) enquanto a compra mostrava o nome.
function productLabel(paymentOfferName, byCodeOfferName, productCode) {
  if (paymentOfferName && String(paymentOfferName).trim()) return String(paymentOfferName);
  if (byCodeOfferName && String(byCodeOfferName).trim()) return String(byCodeOfferName);
  if (productCode && String(productCode).trim()) return String(productCode);
  return "–";
}

const SALES_SELECT_COLUMNS = `
  ${FAKE_SALE_COLUMNS},
  id, name, email, phone, method AS lead_method, status AS lead_status, product,
  funnel, utm_source, utm_campaign, utm_term, utm_content, utm_page,
  created_at AS l_created_at, updated_at AS l_updated_at,
  (SELECT p.id           FROM payments p WHERE p.lead_id = leads.id ORDER BY p.updated_at DESC LIMIT 1) AS last_payment_id,
  (SELECT p.status       FROM payments p WHERE p.lead_id = leads.id ORDER BY p.updated_at DESC LIMIT 1) AS last_payment_status,
  (SELECT p.method       FROM payments p WHERE p.lead_id = leads.id ORDER BY p.updated_at DESC LIMIT 1) AS last_payment_method,
  (SELECT p.amount_cents FROM payments p WHERE p.lead_id = leads.id ORDER BY p.updated_at DESC LIMIT 1) AS last_payment_amount,
  (SELECT p.updated_at   FROM payments p WHERE p.lead_id = leads.id ORDER BY p.updated_at DESC LIMIT 1) AS last_payment_at,
  -- Compra confirmada (vence pendência/erro posterior). approved_at_max = compra
  -- mais recente desta lead; reversal_* = estorno/chargeback (pós-compra, vence tudo).
  (SELECT MAX(p.approved_at) FROM payments p WHERE p.lead_id = leads.id AND p.status = 'approved') AS approved_at_max,
  (SELECT p.method       FROM payments p WHERE p.lead_id = leads.id AND p.status = 'approved' ORDER BY p.approved_at DESC LIMIT 1) AS approved_method,
  (SELECT p.amount_cents FROM payments p WHERE p.lead_id = leads.id AND p.status = 'approved' ORDER BY p.approved_at DESC LIMIT 1) AS approved_amount,
  (SELECT p.status     FROM payments p WHERE p.lead_id = leads.id AND p.status IN ('refunded','chargeback') ORDER BY p.updated_at DESC LIMIT 1) AS reversal_status,
  (SELECT p.updated_at FROM payments p WHERE p.lead_id = leads.id AND p.status IN ('refunded','chargeback') ORDER BY p.updated_at DESC LIMIT 1) AS reversal_at,
  (SELECT pr.status FROM payment_refunds pr
     WHERE pr.lead_id = leads.id ORDER BY pr.updated_at DESC, pr.id DESC LIMIT 1) AS refund_request_status,
  (SELECT pr.updated_at FROM payment_refunds pr
     WHERE pr.lead_id = leads.id ORDER BY pr.updated_at DESC, pr.id DESC LIMIT 1) AS refund_request_at,
  (SELECT p.id FROM payments p
     WHERE p.lead_id = leads.id AND p.status = 'approved'
     ORDER BY COALESCE(p.approved_at, p.updated_at) DESC, p.id DESC LIMIT 1) AS refundable_payment_id,
  (SELECT p.amount_cents FROM payments p
     WHERE p.lead_id = leads.id AND p.status = 'approved'
     ORDER BY COALESCE(p.approved_at, p.updated_at) DESC, p.id DESC LIMIT 1) AS refundable_amount,
  (SELECT o.name FROM payments p LEFT JOIN offers o ON p.offer_id = o.id
     WHERE p.lead_id = leads.id ORDER BY p.updated_at DESC LIMIT 1) AS last_offer_name,
  -- Nome da oferta casado pelo código gravado em leads.product (offers.code).
  -- Cobre leads sem pagamento (preencheu dados / pix pendente).
  (SELECT o2.name FROM offers o2 WHERE o2.code = leads.product LIMIT 1) AS product_offer_name,
  (SELECT pe.stage      FROM payment_errors pe WHERE pe.lead_id = leads.id ORDER BY pe.created_at DESC LIMIT 1) AS last_error_stage,
  (SELECT pe.created_at FROM payment_errors pe WHERE pe.lead_id = leads.id ORDER BY pe.created_at DESC LIMIT 1) AS last_error_at
`;

function shapeSaleRow(r) {
  const status = deriveStatus(r);
  const fake = fakeSaleValue(r);
  // Numa compra confirmada, mostra método/valor do pagamento aprovado (não de um
  // Pix pendente posterior que o cliente possa ter gerado e abandonado).
  const bought = !!r.approved_at_max || (r.lead_status || "").toLowerCase() === "comprou";
  const method =
    (bought && displayMethod(r.approved_method)) ||
    displayMethod(r.last_payment_method) ||
    displayMethod(fake.method) ||
    displayMethod(r.lead_method) ||
    "";
  const amountCents = bought ? (r.approved_amount ?? r.last_payment_amount) : r.last_payment_amount;
  const lastActivityAt =
    [r.refund_request_at, r.last_error_at, r.last_payment_at, r.l_updated_at, r.l_created_at]
      .filter(Boolean)
      .sort((a, b) => tsValue(b) - tsValue(a))[0] || r.l_created_at;
  const refundRequest = (r.refund_request_status || "").toLowerCase();
  const canRefund = status.label === "comprou"
    && r.refundable_payment_id != null
    && !["requested", "in_process", "approved"].includes(refundRequest);
  let refundUnavailableReason = "";
  if (!canRefund) {
    if (status.label === "reembolsado") refundUnavailableReason = "Esta venda já foi reembolsada.";
    else if (status.label === "chargeback") refundUnavailableReason = "Esta venda está em chargeback.";
    else if (status.label === "reembolso em processamento") refundUnavailableReason = "O reembolso já está em processamento.";
    else refundUnavailableReason = "Disponível somente para pagamentos aprovados via Mercado Pago.";
  }
  return {
    id: r.id,
    name: r.name || "",
    email: r.email || "",
    phone: r.phone || "",
    product: r.product || "",
    product_label: fake.offer_name || productLabel(r.last_offer_name, r.product_offer_name, r.product),
    method,
    last_payment_amount_cents: amountCents ?? fake.amount_cents ?? null,
    is_fake_checkout: fake.is_fake_checkout,
    value_source: fake.is_fake_checkout ? fake.value_source : (amountCents != null ? "payment" : "unrecorded"),
    fake_order_bumps: fake.bumps,
    last_activity_at: lastActivityAt,
    derived_status: status.label,
    derived_status_label: status.label,
    derived_status_kind: status.kind,
    can_refund: canRefund,
    refund_amount_cents: r.refundable_amount ?? null,
    refund_unavailable_reason: refundUnavailableReason,
    funnel: r.funnel || "",
    utm_source: r.utm_source || "",
    utm_campaign: r.utm_campaign || "",
    utm_term: r.utm_term || "",
    utm_content: r.utm_content || "",
    utm_page: r.utm_page || "",
  };
}

// Constrói os filtros internos (sobre a tabela leads) e externos (sobre as
// colunas derivadas via subquery) a partir dos query params.
async function buildSalesFilters(url, env) {
  const q = (url.searchParams.get("q") || "").trim();
  const product = (url.searchParams.get("product") || "").trim();
  const status = (url.searchParams.get("status") || "").trim();
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  // Filtros de UTM/atribuição (igualdade exata; __none__ = "sem valor")
  const utm_campaign = (url.searchParams.get("utm_campaign") || "").trim();
  const utm_term = (url.searchParams.get("utm_term") || "").trim();
  const utm_content = (url.searchParams.get("utm_content") || "").trim();
  const utm_source = (url.searchParams.get("utm_source") || "").trim();
  const funnel = (url.searchParams.get("funnel") || "").trim();
  const ipF = await ipFilter(url, env);

  const baseFilter = `(name != '' OR email != '' OR phone != '') AND status != ''`;
  const innerConds = [baseFilter];
  const innerBinds = [];

  if (q) {
    const pattern = `%${q.replace(/[%_]/g, (c) => "\\" + c)}%`;
    innerConds.push(
      `(name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')`
    );
    innerBinds.push(pattern, pattern, pattern);
  }

  if (product) {
    if (product === "__none__") {
      innerConds.push(`(product IS NULL OR product = '')`);
    } else {
      innerConds.push(`product = ?`);
      innerBinds.push(product);
    }
  }

  // Filtros exatos por coluna da tabela leads (campanha, adset, origem, funil).
  for (const [col, val] of [
    ["utm_campaign", utm_campaign],
    ["utm_term", utm_term],
    ["utm_content", utm_content],
    ["utm_source", utm_source],
    ["funnel", funnel],
  ]) {
    if (!val) continue;
    if (val === "__none__") {
      innerConds.push(`(${col} IS NULL OR ${col} = '')`);
    } else {
      innerConds.push(`${col} = ?`);
      innerBinds.push(val);
    }
  }

  if (start) {
    const s = toSqliteDatetime(start);
    if (s) {
      innerConds.push(`COALESCE(updated_at, created_at) >= ?`);
      innerBinds.push(s);
    }
  }
  if (end) {
    const e = toSqliteDatetime(end);
    if (e) {
      innerConds.push(`COALESCE(updated_at, created_at) <= ?`);
      innerBinds.push(e);
    }
  }

  const innerWhere = innerConds.join(" AND ") + ipF;
  const outerCond = buildSalesStatusClause(status);

  return {
    innerWhere,
    innerBinds,
    outerCond,
    params: { q, product, status, start, end, utm_campaign, utm_term, utm_content, utm_source, funnel },
  };
}

function buildSalesStatusClause(status) {
  // Espelha deriveStatus: estorno > compra confirmada > tempo (erro/payment/lead).
  const notReversed = `reversal_status IS NULL AND COALESCE(refund_request_status,'') NOT IN ('requested','in_process','approved')`;
  const bought = `(approved_at_max IS NOT NULL OR lead_status = 'comprou')`;
  // Prefixo dos status "abaixo" de compra: não pode estar estornado nem comprado.
  const notBought = `${notReversed} AND approved_at_max IS NULL AND COALESCE(lead_status,'') != 'comprou'`;
  switch (status) {
    case "comprou":
      return `(${notReversed} AND ${bought})`;
    case "reembolsado":
      return `(reversal_status = 'refunded' OR refund_request_status = 'approved')`;
    case "reembolso_pendente":
      return `(reversal_status IS NULL AND refund_request_status IN ('requested','in_process'))`;
    case "pix_pendente":
      return `(${notBought} AND ((last_payment_status IN ('pending','in_process','authorized') AND lower(COALESCE(last_payment_method,'')) IN ('pix')) OR (last_payment_status IS NULL AND lead_status = 'pix_gerado')))`;
    case "cartao_pendente":
      return `(${notBought} AND last_payment_status IN ('pending','in_process','authorized') AND lower(COALESCE(last_payment_method,'')) IN ('credit_card','card','cartão'))`;
    case "rejeitado":
      return `(${notBought} AND last_payment_status IN ('rejected','cancelled'))`;
    case "checkout_falhou":
      return `(${notBought} AND last_error_stage IS NOT NULL AND (last_payment_at IS NULL OR last_error_at >= last_payment_at))`;
    case "preencheu_dados":
      return `(${notBought} AND last_payment_status IS NULL AND last_error_stage IS NULL AND lead_status IN ('nome','email','telefone','escolheu_metodo'))`;
    default:
      return null;
  }
}

function buildSalesQuery(filters, { limit, offset, forCount = false } = {}) {
  const { innerWhere, innerBinds, outerCond } = filters;
  const innerQuery = `SELECT ${SALES_SELECT_COLUMNS} FROM leads WHERE ${innerWhere}`;

  if (forCount) {
    if (outerCond) {
      return {
        sql: `SELECT COUNT(*) AS n FROM (${innerQuery}) AS s WHERE ${outerCond}`,
        binds: innerBinds.slice(),
      };
    }
    return {
      sql: `SELECT COUNT(*) AS n FROM leads WHERE ${innerWhere}`,
      binds: innerBinds.slice(),
    };
  }

  const orderBy = `ORDER BY COALESCE(l_updated_at, l_created_at) DESC`;
  const limitClause = limit != null ? `LIMIT ${Number(limit)} OFFSET ${Number(offset || 0)}` : "";

  if (outerCond) {
    return {
      sql: `SELECT * FROM (${innerQuery}) AS s WHERE ${outerCond} ${orderBy} ${limitClause}`.trim(),
      binds: innerBinds.slice(),
    };
  }
  return {
    sql: `${innerQuery} ${orderBy.replace("l_updated_at, l_created_at", "updated_at, created_at")} ${limitClause}`.trim(),
    binds: innerBinds.slice(),
  };
}

async function handleSalesSearch(request, env) {
  try {
    const url = new URL(request.url);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);

    const filters = await buildSalesFilters(url, env);
    const countQ = buildSalesQuery(filters, { forCount: true });
    const dataQ = buildSalesQuery(filters, { limit, offset });

    const [countRow, res] = await Promise.all([
      env.DB.prepare(countQ.sql).bind(...countQ.binds).first(),
      env.DB.prepare(dataQ.sql).bind(...dataQ.binds).all(),
    ]);

    return json({
      q: filters.params.q,
      total: countRow?.n ?? 0,
      limit,
      offset,
      results: (res.results ?? []).map(shapeSaleRow),
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function handleSalesProducts(env) {
  try {
    const res = await env.DB.prepare(
      `SELECT product, COUNT(*) AS n
       FROM leads
       WHERE product IS NOT NULL AND product != ''
       GROUP BY product
       ORDER BY n DESC, product ASC`
    ).all();
    const products = (res.results ?? []).map((r) => ({ value: r.product, count: r.n }));
    return json({ products });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// Valores distintos das dimensões de UTM/atribuição pra alimentar os dropdowns
// de filtro do /vendas. Só considera leads que aparecem na lista de vendas
// (mesma base do search). Ordena cada dimensão em ordem decrescente natural
// (campanha 12 antes de campanha 11, criativo 15 antes de 2) pra a mais recente vir no topo.
// Limita por dimensão pra não estourar o payload.
async function handleSalesFacets(env) {
  const DIMS = ["utm_campaign", "utm_term", "funnel"];
  const base = `(name != '' OR email != '' OR phone != '') AND status != ''`;
  try {
    const queries = DIMS.map((col) =>
      env.DB.prepare(
        `SELECT ${col} AS value, COUNT(*) AS n
           FROM leads
          WHERE ${base} AND ${col} IS NOT NULL AND ${col} != ''
          GROUP BY ${col}
          ORDER BY n DESC, ${col} ASC
          LIMIT 300`
      )
    );
    // Contagem de leads "sem valor" por dimensão (útil pra tráfego orgânico/direto).
    const noneQueries = DIMS.map((col) =>
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM leads WHERE ${base} AND (${col} IS NULL OR ${col} = '')`
      )
    );

    const results = await env.DB.batch([...queries, ...noneQueries]);

    // Ordena por valor em ordem decrescente natural (numérico-aware): assim a
    // última campanha/criativo (maior número) fica no topo do dropdown.
    const coll = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });
    const facets = {};
    DIMS.forEach((col, i) => {
      const values = (results[i]?.results ?? []).map((r) => ({ value: r.value, count: r.n }));
      values.sort((x, y) => coll.compare(String(y.value), String(x.value)));
      const none = results[DIMS.length + i]?.results?.[0]?.n ?? 0;
      facets[col] = { values, none };
    });
    return json({ facets });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

function csvEscape(value) {
  if (value == null) return "";
  let s = String(value);
  // Planilhas executam células que começam com = + - @ (ou tab/CR) como
  // fórmula; o apóstrofo força texto (CSV/formula injection).
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function fmtCsvDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function fmtCsvBRL(cents) {
  if (cents == null || cents === "" || isNaN(Number(cents))) return "";
  return (Number(cents) / 100).toFixed(2).replace(".", ",");
}

async function handleSalesExport(request, env) {
  try {
    const url = new URL(request.url);
    const filters = await buildSalesFilters(url, env);
    // Limite generoso para export, D1 aguenta mas evitamos timeouts gigantes.
    const dataQ = buildSalesQuery(filters, { limit: 10000, offset: 0 });
    const res = await env.DB.prepare(dataQ.sql).bind(...dataQ.binds).all();
    const rows = (res.results ?? []).map(shapeSaleRow);

    const headers = [
      "ID",
      "Data",
      "Nome",
      "Email",
      "Telefone",
      "Produto",
      "Método",
      "Valor (BRL)",
      "Tipo de valor",
      "Origem do valor",
      "Status",
      "Funil",
      "UTM Source",
      "UTM Campaign",
      "UTM Term",
      "UTM Content",
      "UTM Page",
    ];
    const lines = [headers.join(",")];
    for (const r of rows) {
      lines.push([
        csvEscape(r.id),
        csvEscape(fmtCsvDate(r.last_activity_at)),
        csvEscape(r.name),
        csvEscape(r.email),
        csvEscape(r.phone),
        csvEscape(r.product_label),
        csvEscape(r.method),
        csvEscape(fmtCsvBRL(r.last_payment_amount_cents)),
        csvEscape(r.is_fake_checkout ? "Simulado, sem receita" : "Pagamento"),
        csvEscape(r.value_source),
        csvEscape(r.derived_status_label),
        csvEscape(r.funnel || ""),
        csvEscape(r.utm_source || ""),
        csvEscape(r.utm_campaign || ""),
        csvEscape(r.utm_term || ""),
        csvEscape(r.utm_content || ""),
        csvEscape(r.utm_page || ""),
      ].join(","));
    }
    // BOM pra Excel reconhecer UTF-8.
    const body = "﻿" + lines.join("\r\n") + "\r\n";
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="vendas-${stamp}.csv"`,
        "Cache-Control": "no-store",
        ...FRAME_HEADERS,
      },
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function handleSalesHistory(env, idStr) {
  try {
    const leadId = parseInt(idStr, 10);
    if (!Number.isInteger(leadId) || leadId <= 0) {
      return json({ error: "ID inválido" }, 400);
    }

    const lead = await env.DB
      .prepare(
        `SELECT id, name, email, phone, status, product, method, funnel, ip,
                utm_source, utm_medium, utm_campaign, utm_term, utm_content, utm_page,
                meta_campaign_id, meta_adset_id, meta_ad_id, fbclid,
                created_at, updated_at, ${FAKE_SALE_COLUMNS},
                (SELECT o.name FROM offers o WHERE o.code = leads.product LIMIT 1) AS product_offer_name
           FROM leads WHERE id = ?`
      )
      .bind(leadId)
      .first();
    if (!lead) return json({ error: "Lead não encontrada" }, 404);

    const [paymentsRes, errorsRes, refundsRes] = await Promise.all([
      env.DB
        .prepare(
          `SELECT p.id, p.status, p.method, p.amount_cents, p.mp_payment_id,
                  p.created_at, p.updated_at, p.approved_at,
                  p.offer_id, o.name AS offer_name, o.code AS offer_code
             FROM payments p LEFT JOIN offers o ON o.id = p.offer_id
            WHERE p.lead_id = ?
            ORDER BY p.created_at ASC`
        )
        .bind(leadId)
        .all(),
      env.DB
        .prepare(
          `SELECT id, stage, error_code, error_detail, created_at
             FROM payment_errors
            WHERE lead_id = ?
            ORDER BY created_at ASC`
        )
        .bind(leadId)
        .all(),
      env.DB
        .prepare(
          `SELECT id, payment_id, mp_payment_id, refund_id, status, amount_cents,
                  attempt_count, error_code, error_detail, requested_at, completed_at, updated_at
             FROM payment_refunds
            WHERE lead_id = ?
            ORDER BY requested_at ASC, id ASC`
        )
        .bind(leadId)
        .all(),
    ]);

    const payments = paymentsRes.results || [];
    const errors = errorsRes.results || [];
    const refunds = refundsRes.results || [];

    const events = [];

    // 1) Lead criado
    const initialStatus = (lead.status || "").toLowerCase();
    let leadCreatedTitle = "Preencheu dados";
    if (initialStatus === "comprou") leadCreatedTitle = "Lead criado";
    else if (initialStatus === "pix_gerado") leadCreatedTitle = "Iniciou checkout";
    const leadCreatedDetail = [
      lead.name && `nome: ${lead.name}`,
      lead.email && `e-mail: ${lead.email}`,
      lead.phone && `telefone: ${lead.phone}`,
    ].filter(Boolean).join(" · ");
    events.push({
      type: "lead_created",
      at: lead.created_at,
      title: leadCreatedTitle,
      detail: leadCreatedDetail,
      kind: "info",
    });

    // 2) Payments criados / aprovados / rejeitados
    for (const p of payments) {
      const method = displayMethod(p.method) || "Pagamento";
      const offerName = p.offer_name || p.offer_code || "";
      const amount = p.amount_cents != null
        ? (Number(p.amount_cents) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
        : "";
      const baseDetail = [offerName, amount].filter(Boolean).join(" · ");

      events.push({
        type: "payment_created",
        at: p.created_at,
        title: `${method} iniciado`,
        detail: baseDetail,
        extra: p.mp_payment_id ? `mp_payment_id: ${p.mp_payment_id}` : "",
        kind: "warn",
      });

      const ps = (p.status || "").toLowerCase();
      if (p.approved_at) {
        events.push({
          type: "payment_approved",
          at: p.approved_at,
          title: `Pagamento aprovado (${method})`,
          detail: baseDetail,
          kind: "success",
        });
      }
      if (ps === "refunded") {
        events.push({
          type: "payment_refunded",
          at: p.updated_at,
          title: `Pagamento reembolsado (${method})`,
          detail: baseDetail,
          kind: "error",
        });
      } else if (ps === "chargeback") {
        events.push({
          type: "payment_chargeback",
          at: p.updated_at,
          title: `Chargeback registrado (${method})`,
          detail: baseDetail,
          kind: "error",
        });
      } else if ((ps === "rejected" || ps === "cancelled") && !p.approved_at) {
        if (p.updated_at && p.updated_at !== p.created_at) {
          events.push({
            type: "payment_rejected",
            at: p.updated_at,
            title: `Pagamento ${ps === "cancelled" ? "cancelado" : "rejeitado"} (${method})`,
            detail: baseDetail,
            kind: "error",
          });
        }
      }
    }

    // 3) Erros de pagamento
    for (const e of errors) {
      const label = PAYMENT_ERROR_LABELS[e.stage] || `erro: ${e.stage}`;
      const detailParts = [];
      if (e.error_code)   detailParts.push(`código: ${e.error_code}`);
      if (e.error_detail) detailParts.push(e.error_detail);
      events.push({
        type: "payment_error",
        at: e.created_at,
        title: label.charAt(0).toUpperCase() + label.slice(1),
        detail: detailParts.join(" · "),
        kind: "error",
      });
    }

    // 4) Solicitações manuais de reembolso feitas pelo dashboard.
    for (const refund of refunds) {
      const amount = refund.amount_cents != null
        ? (Number(refund.amount_cents) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
        : "";
      const attempts = Number(refund.attempt_count) > 1 ? ` · tentativa ${refund.attempt_count}` : "";
      events.push({
        type: "refund_requested",
        at: refund.requested_at,
        title: "Reembolso solicitado no Mercado Pago",
        detail: amount + attempts,
        extra: refund.mp_payment_id ? `mp_payment_id: ${refund.mp_payment_id}` : "",
        kind: "warn",
      });

      if (refund.status === "approved") {
        events.push({
          type: "refund_approved",
          at: refund.completed_at || refund.updated_at,
          title: "Reembolso aprovado pelo Mercado Pago",
          detail: amount,
          extra: refund.refund_id ? `refund_id: ${refund.refund_id}` : "",
          kind: "success",
        });
      } else if (refund.status === "in_process") {
        events.push({
          type: "refund_processing",
          at: refund.updated_at,
          title: "Reembolso em processamento no Mercado Pago",
          detail: amount,
          extra: refund.refund_id ? `refund_id: ${refund.refund_id}` : "",
          kind: "warn",
        });
      } else if (refund.status === "failed") {
        events.push({
          type: "refund_failed",
          at: refund.completed_at || refund.updated_at,
          title: "Falha ao reembolsar no Mercado Pago",
          detail: refund.error_detail || refund.error_code || "Falha não detalhada",
          kind: "error",
        });
      }
    }

    // 5) Atualização final do lead (se diferente da criação).
    // Fase 7: o comprador fica com lead.status='pix_gerado' (a compra vive em
    // payments/orders) e o lead.updated_at é bumpado na aprovação só pra gravar o
    // método. Sem o guard abaixo, isso virava um evento "Lead marcada como
    // pix_gerado" DEPOIS do "Pagamento aprovado", fazendo o último estágio
    // contradizer a compra. Quem já tem pagamento aprovado não recebe esse evento
    // (a aprovação já é o estágio final).
    const isBuyer =
      initialStatus === "comprou" ||
      payments.some((p) => p.approved_at || (p.status || "").toLowerCase() === "approved");
    if (
      lead.updated_at && lead.updated_at !== lead.created_at && initialStatus &&
      !(isBuyer && initialStatus !== "comprou")
    ) {
      let title = `Status atualizado: ${initialStatus}`;
      let kind = "muted";
      if (initialStatus === "comprou") { title = "Lead marcada como comprou"; kind = "success"; }
      else if (initialStatus === "pix_gerado") { title = "Lead marcada como pix_gerado"; kind = "warn"; }
      events.push({
        type: "lead_status_changed",
        at: lead.updated_at,
        title,
        detail: "",
        kind,
      });
    }

    events.sort((a, b) => tsValue(a.at) - tsValue(b.at));

    // Último payment (pra meta no modal)
    const lastPayment = payments.length
      ? payments.slice().sort((a, b) => tsValue(b.updated_at) - tsValue(a.updated_at))[0]
      : null;
    const fake = fakeSaleValue({ ...lead, lead_status: lead.status, last_payment_id: lastPayment?.id });
    if (fake.is_fake_checkout) events.push({ type: "fake_checkout", at: lead.updated_at, title: "Checkout fake, sem cobrança",
      detail: fake.value_source === "legacy_estimated" ? "Valor reconstruído/estimado pelo preço atual da oferta; não é snapshot histórico nem receita." : fake.value_source === "fake_snapshot" ? "Valor simulado registrado; não é receita." : "Valor final não registrado.", kind: "info" });

    return json({
      lead: {
        id: lead.id,
        name: lead.name || "",
        email: lead.email || "",
        phone: lead.phone || "",
        status: lead.status || "",
        product: lead.product || "",
        method: displayMethod(lastPayment?.method) || displayMethod(fake.method) || displayMethod(lead.method) || "",
        funnel: lead.funnel || "",
        ip: lead.ip || "",
        utm_source: lead.utm_source || "",
        utm_medium: lead.utm_medium || "",
        utm_campaign: lead.utm_campaign || "",
        utm_term: lead.utm_term || "",
        utm_content: lead.utm_content || "",
        utm_page: lead.utm_page || "",
        meta_campaign_id: lead.meta_campaign_id || "",
        meta_adset_id: lead.meta_adset_id || "",
        meta_ad_id: lead.meta_ad_id || "",
        fbclid: lead.fbclid || "",
        created_at: lead.created_at,
        updated_at: lead.updated_at,
      },
      product_label: fake.offer_name || productLabel(lastPayment?.offer_name, lead.product_offer_name, lead.product),
      last_payment_amount_cents: lastPayment?.amount_cents ?? fake.amount_cents ?? null,
      is_fake_checkout: fake.is_fake_checkout,
      value_source: fake.is_fake_checkout ? fake.value_source : (lastPayment ? "payment" : "unrecorded"),
      fake_order_bumps: fake.bumps,
      events,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// Resolve o alvo de disparo/reenvio de uma venda (lead): e-mail, oferta e
// e-mail de confirmação configurado, mais o último pedido (pra associar o log).
async function resolveSaleDispatchTarget(env, leadId) {
  const lead = await env.DB
    .prepare("SELECT id, name, email, phone, product FROM leads WHERE id = ?")
    .bind(leadId)
    .first();
  if (!lead) return { error: "Lead não encontrada", status: 404 };

  // Prefere o pedido aprovado mais recente; senão o mais recente qualquer.
  const order = await env.DB
    .prepare(
      `SELECT id, offer_id, payer_email, payer_phone, payer_name, status
         FROM orders WHERE lead_id = ?
        ORDER BY (status = 'approved') DESC, id DESC LIMIT 1`
    )
    .bind(leadId)
    .first();

  let offer = null;
  if (order && order.offer_id) {
    offer = await env.DB
      .prepare("SELECT id, code, name, email_enabled, email_subject FROM offers WHERE id = ?")
      .bind(order.offer_id)
      .first();
  }
  if (!offer && lead.product) {
    offer = await env.DB
      .prepare("SELECT id, code, name, email_enabled, email_subject FROM offers WHERE code = ? LIMIT 1")
      .bind(lead.product)
      .first();
  }

  const email = (order && order.payer_email) || lead.email || "";
  const phone = (order && order.payer_phone) || lead.phone || "";
  return { lead, order, offer, email, phone };
}

async function handleSalesDispatches(env, idStr) {
  try {
    const leadId = parseInt(idStr, 10);
    if (!Number.isInteger(leadId) || leadId <= 0) return json({ error: "ID inválido" }, 400);

    const t = await resolveSaleDispatchTarget(env, leadId);
    if (t.error) return json({ error: t.error }, t.status || 400);

    const res = await env.DB
      .prepare(
        `SELECT id, order_id, lead_id, offer_id, channel, status, triggered_by, destination, message, error, created_at
           FROM purchase_dispatches
          WHERE lead_id = ? OR order_id IN (SELECT id FROM orders WHERE lead_id = ?)
          ORDER BY id DESC`
      )
      .bind(leadId, leadId)
      .all();

    return json({
      lead: { id: t.lead.id, name: t.lead.name || "", email: t.email || "", phone: t.phone || "" },
      offer: t.offer
        ? {
            code: t.offer.code,
            name: t.offer.name || "",
            email_enabled: Number(t.offer.email_enabled) === 1,
            email_subject: t.offer.email_subject ? String(t.offer.email_subject) : "",
          }
        : null,
      // O checkout só reenvia com pedido aprovado e e-mail ligado na oferta.
      can_resend: !!(t.email && t.offer && Number(t.offer.email_enabled) === 1 && t.order && t.order.status === "approved"),
      dispatches: res.results || [],
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// O reenvio do e-mail de confirmação também é delegado ao checkout, que tem as
// credenciais de envio e registra o disparo em purchase_dispatches.
async function handleResendEmail(request, env, idStr) {
  try {
    const leadId = parseInt(idStr, 10);
    if (!Number.isInteger(leadId) || leadId <= 0) return json({ error: "ID inválido" }, 400);
    if (!env.CHECKOUT_SERVICE || typeof env.CHECKOUT_SERVICE.fetch !== "function") {
      return json({ error: "Serviço de e-mail indisponível" }, 503);
    }

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 2048) return json({ error: "Payload muito grande" }, 413);

    const internalRequest = new Request(new URL("/internal/dashboard/resend-email", request.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lead_id: leadId }),
    });
    const response = await env.CHECKOUT_SERVICE.fetch(internalRequest);
    let data = null;
    try { data = await response.json(); } catch { data = { error: "Resposta inválida do serviço de e-mail" }; }
    return json(data || { error: "Resposta vazia do serviço de e-mail" }, response.status);
  } catch (err) {
    console.error(JSON.stringify({ message: "dashboard_resend_email_failed", error: String(err && err.message || err).slice(0, 200) }));
    return json({ error: "Não foi possível reenviar o e-mail" }, 502);
  }
}

// O dashboard não recebe uma cópia do MP_ACCESS_TOKEN. Ele delega a operação
// financeira ao módulo de checkout (env.CHECKOUT_SERVICE), mantendo a credencial
// isolada no serviço que já processa os pagamentos.
async function handleSaleRefund(request, env, idStr) {
  try {
    const leadId = parseInt(idStr, 10);
    if (!Number.isInteger(leadId) || leadId <= 0) return json({ error: "ID inválido" }, 400);
    if (!env.CHECKOUT_SERVICE || typeof env.CHECKOUT_SERVICE.fetch !== "function") {
      return json({ error: "Serviço de pagamentos indisponível" }, 503);
    }

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 2048) return json({ error: "Payload muito grande" }, 413);
    let body = {};
    try { body = await request.json(); } catch { /* operation_id será gerado abaixo */ }
    const requestedOperationId = String((body && body.operation_id) || "");
    const operationId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedOperationId)
      ? requestedOperationId
      : crypto.randomUUID();

    const internalRequest = new Request("https://checkout.internal/internal/dashboard/refund", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead_id: leadId, operation_id: operationId }),
    });
    const response = await env.CHECKOUT_SERVICE.fetch(internalRequest);
    let data = null;
    try { data = await response.json(); } catch { data = { error: "Resposta inválida do serviço de pagamentos" }; }
    return json(data || { error: "Resposta vazia do serviço de pagamentos" }, response.status);
  } catch (err) {
    console.error(JSON.stringify({ message: "dashboard_refund_failed", error: String(err && err.message || err).slice(0, 200) }));
    return json({ error: "Não foi possível solicitar o reembolso" }, 502);
  }
}

async function handleSettingsGet(env) {
  try {
    const res = await env.DB.prepare("SELECT key, value, updated_at FROM settings").all();
    const map = {};
    for (const r of res.results || []) map[r.key] = { value: r.value, updated_at: r.updated_at };

    let blockedIps = [];
    try {
      const parsed = JSON.parse(map.blocked_ips?.value || "[]");
      if (Array.isArray(parsed)) {
        blockedIps = parsed.map((e) =>
          typeof e === "string" ? { value: e, label: "" } : { value: e.value, label: e.label || "" }
        );
      }
    } catch {
      blockedIps = [];
    }

    return json({
      blocked_ips: blockedIps,
      raw: map,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function handleSettingsPost(request, env) {
  try {
    const body = await request.json();
    if (!body || typeof body.key !== "string" || typeof body.value === "undefined") {
      return json({ error: "Body inválido: esperado { key, value }" }, 400);
    }
    const key = body.key;
    if (!ALLOWED_SETTINGS.has(key)) return json({ error: `Chave '${key}' não permitida` }, 400);

    let value;
    if (key === "blocked_ips") {
      if (!Array.isArray(body.value)) {
        return json({ error: "blocked_ips deve ser um array" }, 400);
      }
      const cleaned = [];
      const seen = new Set();
      for (const raw of body.value) {
        const item = typeof raw === "string" ? { value: raw, label: "" } : raw;
        if (!item || typeof item.value !== "string") {
          return json({ error: "Cada entrada precisa de um campo 'value' string" }, 400);
        }
        const v = validateIpEntry(item.value);
        if (!v.ok) return json({ error: `'${item.value}': ${v.reason}` }, 400);
        if (seen.has(v.value)) continue;
        seen.add(v.value);
        const label = typeof item.label === "string" ? item.label.slice(0, 80) : "";
        cleaned.push({ value: v.value, label });
      }
      if (cleaned.length > 100) {
        return json({ error: "Máximo de 100 entradas" }, 400);
      }
      value = JSON.stringify(cleaned);
    } else {
      value = String(body.value);
    }

    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
      .bind(key, value)
      .run();

    return json({ ok: true, key, value });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function handleMetaTableConfigGet(env) {
  try {
    const row = await env.DB
      .prepare("SELECT value FROM settings WHERE key = 'meta_table_config'")
      .first();
    let cfg = {};
    if (row && row.value) {
      try {
        const parsed = JSON.parse(row.value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cfg = parsed;
      } catch {}
    }
    return json(cfg);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

async function handleMetaTableConfigPut(request, env) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "Body deve ser um objeto JSON" }, 400);
    }
    const value = JSON.stringify(body);
    if (value.length > 50000) return json({ error: "Config muito grande (>50KB)" }, 400);
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind("meta_table_config", value).run();
    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// Falha fechada: sem DASH_PASS configurado o painel não abre para ninguém.
function checkAuth(request, env) {
  const user = env.DASH_USER || "admin";
  const pass = env.DASH_PASS;
  if (!pass) {
    return new Response("Configure DASH_PASS (npm run setup)", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return unauthorized();

  try {
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(header.slice(6).trim()), (c) => c.charCodeAt(0))
    );
    const i = decoded.indexOf(":");
    if (i < 0) return unauthorized();
    const u = decoded.slice(0, i);
    const p = decoded.slice(i + 1);
    // Avalia os dois campos sempre, sem curto-circuito, pra não vazar timing.
    const userOk = timingSafeEqual(u, String(user));
    const passOk = timingSafeEqual(p, String(pass));
    if (!(userOk & passOk)) return unauthorized();
  } catch {
    return unauthorized();
  }
  return null;
}

// Comparação em tempo constante (em relação ao conteúdo). O comprimento do
// valor esperado não é segredo relevante; mesmo assim percorre o maior dos dois.
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0 ? 1 : 0;
}

// Proteção contra CSRF. O navegador reenvia a Basic Auth em cache mesmo quando
// outro site dispara um POST para o painel; por isso toda escrita precisa vir
// da própria origem. Sec-Fetch-Site "none" é ação do próprio usuário (barra de
// endereço). Sem Sec-Fetch-Site nem Origin (curl, scripts e skills com
// -u usuário:senha) a requisição segue, porque não vem de um navegador.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CROSS_SITE_ERROR = "Requisição de outra origem bloqueada";

function checkCrossSite(request, url) {
  const method = request.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return null;

  const fetchSite = request.headers.get("Sec-Fetch-Site");
  const origin = request.headers.get("Origin");
  // Sec-Fetch-Site é definido pelo próprio navegador (página nenhuma consegue
  // forjar) e vale mesmo atrás de proxy que reescreve o host; Origin é o
  // plano B para navegadores antigos.
  if (fetchSite !== null) {
    if (fetchSite !== "same-origin" && fetchSite !== "none") return json({ error: CROSS_SITE_ERROR }, 403);
  } else if (origin !== null && origin !== url.origin) {
    return json({ error: CROSS_SITE_ERROR }, 403);
  }

  // Corpo só em JSON: formulários HTML (urlencoded, multipart, text/plain) não
  // conseguem mandar application/json para outra origem sem preflight CORS.
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    const length = request.headers.get("Content-Length");
    const hasBody = length !== null ? Number(length) > 0 : request.body !== null;
    const type = (request.headers.get("Content-Type") || "").toLowerCase();
    if (hasBody && !type.includes("application/json")) {
      return json({ error: "Envie o corpo como application/json" }, 415);
    }
  }
  return null;
}

// O painel nunca é exibido dentro de iframe de outro site (clickjacking).
const FRAME_HEADERS = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

function unauthorized() {
  return new Response("Autenticação necessária", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Dashboard", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function html(body, env) {
  // Variável não preenchida pelo setup (ainda "__BRAND_NAME__") conta como vazia.
  const raw = String((env && env.BRAND_NAME) || "").trim();
  const brand = (/^__[A-Z0-9_]+__$/.test(raw) ? "" : raw).slice(0, 80) || "Painel";
  const safeBrand = escapeHtmlText(brand);
  return new Response(String(body).replaceAll("__BRAND_NAME__", () => safeBrand), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...FRAME_HEADERS,
    },
  });
}

function escapeHtmlText(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...FRAME_HEADERS,
    },
  });
}

async function handleCheckoutAnalyticsReport(request, env) {
  try {
    const url = new URL(request.url);
    const range = url.searchParams.get("range") || "30d";
    const days = range === "1d" ? 1 : range === "7d" ? 7 : range === "90d" ? 90 : 30;
    let offer = /^[a-z0-9_-]{1,64}$/i.test(url.searchParams.get("offer") || "")
      ? url.searchParams.get("offer").toLowerCase()
      : "";
    if (!offer) {
      // Sem oferta na URL: usa a oferta ativa criada mais recentemente.
      const latest = await env.DB
        .prepare("SELECT code FROM offers WHERE is_active = 1 ORDER BY created_at DESC, id DESC LIMIT 1")
        .first();
      offer = latest && latest.code ? String(latest.code) : "";
    }
    if (!offer) {
      return json({
        ok: true,
        range,
        offer: null,
        generated_at: new Date().toISOString(),
        summary: [],
        stages: [],
        metrics: {},
      });
    }

    const classified = `
      WITH base AS (
        SELECT cs.*,
          CASE WHEN EXISTS (
            SELECT 1 FROM orders o
             WHERE o.lead_id = cs.lead_id AND o.status = 'approved'
               AND datetime(o.created_at) >= datetime(cs.started_at, '-1 hour')
          ) THEN 1 ELSE 0 END AS purchased,
          CASE WHEN EXISTS (
            SELECT 1 FROM page_views pv
             WHERE pv.session_uuid = cs.session_uuid
               AND pv.page != 'checkout'
               ${humanPageViewFilter('pv')}
               AND datetime(pv.created_at) > datetime(cs.started_at)
          ) THEN 1 ELSE 0 END AS returned_to_site,
          (julianday('now') - julianday(cs.last_seen_at)) * 1440.0 AS age_minutes
        FROM checkout_sessions cs
        WHERE cs.offer_code = ? AND julianday(cs.started_at) >= julianday('now', '-' || ? || ' days')${humanPageViewFilter('cs')}
      ), labeled AS (
        SELECT *, CASE
          WHEN purchased = 1 THEN 'purchased'
          WHEN returned_to_site = 1 THEN 'returned_to_site'
          WHEN exited_at IS NOT NULL AND (resumed_at IS NULL OR datetime(resumed_at) <= datetime(exited_at)) THEN 'unknown_exit'
          WHEN last_event = 'hidden' AND age_minutes < 30 THEN 'background_now'
          WHEN last_event = 'hidden' THEN 'abandoned_background'
          WHEN last_event = 'pagehide' THEN 'unknown_exit'
          WHEN age_minutes < 30 THEN 'active_visible'
          ELSE 'abandoned_inactive'
        END AS outcome
        FROM base
      )`;

    const summaryResult = await env.DB.prepare(
      classified + ` SELECT outcome, COUNT(*) AS count FROM labeled GROUP BY outcome ORDER BY count DESC`
    ).bind(offer, days).all();
    const stageResult = await env.DB.prepare(
      classified + ` SELECT last_stage, COUNT(*) AS count
        FROM labeled WHERE purchased = 0 AND age_minutes >= 30
        GROUP BY last_stage ORDER BY count DESC`
    ).bind(offer, days).all();
    const metrics = await env.DB.prepare(
      classified + ` SELECT COUNT(*) AS sessions,
        SUM(CASE WHEN purchased = 1 THEN 1 ELSE 0 END) AS purchases,
        ROUND(AVG(visible_ms) / 1000.0, 1) AS avg_visible_seconds,
        SUM(validation_errors) AS validation_errors,
        SUM(payment_attempts) AS payment_attempts,
        SUM(CASE WHEN background_count > 0 THEN 1 ELSE 0 END) AS went_background,
        SUM(CASE WHEN resume_count > 0 THEN 1 ELSE 0 END) AS resumed,
        SUM(CASE WHEN method = 'pix' THEN 1 ELSE 0 END) AS chose_pix,
        SUM(CASE WHEN method = 'card' THEN 1 ELSE 0 END) AS chose_card,
        SUM(CASE WHEN bump_selected = 1 THEN 1 ELSE 0 END) AS selected_bump
        FROM labeled`
    ).bind(offer, days).first();

    return json({
      ok: true,
      range,
      offer,
      generated_at: new Date().toISOString(),
      summary: (summaryResult.results || []),
      stages: (stageResult.results || []),
      metrics: metrics || {},
    });
  } catch (err) {
    return json({ ok: false, error: err && err.message ? err.message : "checkout_analytics_failed" }, 500);
  }
}

async function handleStats(request, env) {
  try {
    const url = new URL(request.url);
    const range = url.searchParams.get("range") || "30d";
    const days = range === "1d" ? 1 : range === "7d" ? 7 : range === "90d" ? 90 : range === "all" ? null : 30;
    const since = days
      ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
      : "1970-01-01T00:00:00.000Z";

    const db = env.DB;
    const ipF = await ipFilter(url, env);

    const [totalsRow, byStatusRes, byMethodRes, seriesRes, recentRes, hourlyRes] =
      await Promise.all([
        db
          .prepare(
            `SELECT
               COUNT(*) AS total,
               COUNT(DISTINCT email) AS unique_emails,
               SUM(CASE WHEN status IN ('success','completed','paid','approved','comprou') THEN 1 ELSE 0 END) AS converted,
               SUM(CASE WHEN status LIKE '%error%' OR status = 'failed' THEN 1 ELSE 0 END) AS errors
             FROM leads
             WHERE created_at >= ?
               AND (name != '' OR email != '' OR phone != '')${ipF}`
          )
          .bind(since)
          .first(),

        db
          .prepare(
            `SELECT status, COUNT(*) AS count
             FROM leads WHERE created_at >= ?
               AND (name != '' OR email != '' OR phone != '')${ipF}
             GROUP BY status ORDER BY count DESC`
          )
          .bind(since)
          .all(),

        db
          .prepare(
            `SELECT method, COUNT(*) AS count
             FROM leads WHERE created_at >= ?
               AND (name != '' OR email != '' OR phone != '')${ipF}
             GROUP BY method ORDER BY count DESC`
          )
          .bind(since)
          .all(),

        db
          .prepare(
            `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count
             FROM leads WHERE created_at >= ?
               AND (name != '' OR email != '' OR phone != '')${ipF}
             GROUP BY day ORDER BY day ASC`
          )
          .bind(since)
          .all(),

        db
          .prepare(
            `SELECT id, name, email, phone, method, status, created_at
             FROM leads
             WHERE (name != '' OR email != '' OR phone != '')${ipF}
             ORDER BY created_at DESC LIMIT 20`
          )
          .all(),

        db
          .prepare(
            `SELECT CAST(substr(created_at, 12, 2) AS INTEGER) AS hour, COUNT(*) AS count
             FROM leads WHERE created_at >= ?
               AND (name != '' OR email != '' OR phone != '')${ipF}
             GROUP BY hour ORDER BY hour ASC`
          )
          .bind(since)
          .all(),
      ]);

    const totals = totalsRow || { total: 0, unique_emails: 0, converted: 0, errors: 0 };
    const conversionRate =
      totals.total > 0 ? +((totals.converted / totals.total) * 100).toFixed(2) : 0;

    return json({
      range,
      since,
      totals: { ...totals, conversion_rate: conversionRate },
      by_status: byStatusRes.results ?? [],
      by_method: byMethodRes.results ?? [],
      timeseries: fillMissingDays(seriesRes.results ?? [], days),
      hourly: fillMissingHours(hourlyRes.results ?? []),
      recent: recentRes.results ?? [],
    });
  } catch (err) {
    return json({ error: err.message || "Erro interno" }, 500);
  }
}

function fillMissingDays(rows, days) {
  if (!days) return rows;
  const map = new Map(rows.map((r) => [r.day, r.count]));
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, count: map.get(key) || 0 });
  }
  return out;
}

function fillMissingHours(rows) {
  const map = new Map(rows.map((r) => [r.hour, r.count]));
  const out = [];
  for (let h = 0; h < 24; h++) out.push({ hour: h, count: map.get(h) || 0 });
  return out;
}

// =============== Sections analytics ===============

async function handleSectionsMeta(env) {
  try {
    const [pagesRes, utmsRes, funnelsRes] = await Promise.all([
      env.DB.prepare(`SELECT DISTINCT page FROM section_events WHERE page IS NOT NULL AND page != '' ORDER BY page`).all(),
      env.DB.prepare(`SELECT DISTINCT utm_campaign AS v FROM section_events WHERE utm_campaign IS NOT NULL AND utm_campaign != '' ORDER BY v`).all(),
      env.DB.prepare(`SELECT DISTINCT funnel AS v FROM section_events WHERE funnel IS NOT NULL AND funnel != '' ORDER BY v`).all(),
    ]);
    return json({
      pages: (pagesRes.results || []).map((r) => r.page),
      utm_campaigns: (utmsRes.results || []).map((r) => r.v),
      funnels: (funnelsRes.results || []).map((r) => r.v),
    });
  } catch (err) {
    return json({ error: err.message || "Erro interno" }, 500);
  }
}

async function handleSections(request, env) {
  try {
    const url = new URL(request.url);
    const page = (url.searchParams.get("page") || "").trim().slice(0, 80);
    if (!page) return json({ error: "missing_page" }, 400);

    const { since, until } = parseDateRange(url);
    const device = (url.searchParams.get("device") || "all").trim();
    const utmCampaign = (url.searchParams.get("utm_campaign") || "").trim().slice(0, 255);
    const funnel = (url.searchParams.get("funnel") || "").trim().slice(0, 60);

    const ipF = await ipFilter(url, env);

    // Filtros adicionais aplicados em TODAS as queries
    const extraConds = [];
    const extraBinds = [];
    if (device && device !== "all" && ["mobile", "tablet", "desktop"].includes(device)) {
      extraConds.push("device = ?");
      extraBinds.push(device);
    }
    if (utmCampaign) {
      extraConds.push("utm_campaign = ?");
      extraBinds.push(utmCampaign);
    }
    if (funnel) {
      extraConds.push("funnel = ?");
      extraBinds.push(funnel);
    }
    const extraClause = extraConds.length ? ` AND ${extraConds.join(" AND ")}` : "";

    // Base WHERE: page, intervalo, IP, filtros extras
    const baseWhere = `page = ? AND created_at >= ?${until ? ` AND created_at <= ?` : ""}${ipF}${extraClause}`;
    const baseBinds = until ? [page, since, until, ...extraBinds] : [page, since, ...extraBinds];

    const db = env.DB;

    // 1) Totals: queries separadas pra evitar árvore SQL profunda no D1
    const [sessionsAvgRow, eventsRow, deviceTotalsRes, ctaClickersRow] = await Promise.all([
      // sessões distintas, scroll médio, tempo médio
      db.prepare(
        `SELECT COUNT(*) AS sessions, AVG(max_pct) AS avg_scroll_pct, AVG(time_s) AS avg_time_s FROM (
           SELECT session_uuid,
                  MAX(CASE WHEN event_type='max_scroll' THEN value END) AS max_pct,
                  MAX(CASE WHEN event_type='time_on_page' THEN value END) AS time_s
             FROM section_events
            WHERE ${baseWhere}
            GROUP BY session_uuid
         )`
      ).bind(...baseBinds).first(),

      // total de eventos
      db.prepare(
        `SELECT COUNT(*) AS events FROM section_events WHERE ${baseWhere}`
      ).bind(...baseBinds).first(),

      // device breakdown agregado por device
      db.prepare(
        `SELECT COALESCE(device, 'desktop') AS device,
                COUNT(*) AS sessions,
                AVG(max_pct) AS avg_scroll_pct,
                AVG(time_s) AS avg_time_s,
                SUM(cta_clicks) AS cta_clicks,
                SUM(clicked) AS clickers
           FROM (
             SELECT session_uuid,
                    MAX(device) AS device,
                    MAX(CASE WHEN event_type='max_scroll' THEN value END) AS max_pct,
                    MAX(CASE WHEN event_type='time_on_page' THEN value END) AS time_s,
                    SUM(CASE WHEN event_type='cta_click' THEN 1 ELSE 0 END) AS cta_clicks,
                    CASE WHEN SUM(CASE WHEN event_type='cta_click' THEN 1 ELSE 0 END) > 0 THEN 1 ELSE 0 END AS clicked
               FROM section_events
              WHERE ${baseWhere}
              GROUP BY session_uuid
           )
          GROUP BY device`
      ).bind(...baseBinds).all(),

      // distinct sessions com pelo menos 1 cta_click (pra CTR)
      db.prepare(
        `SELECT COUNT(DISTINCT session_uuid) AS clickers
           FROM section_events
          WHERE event_type='cta_click' AND ${baseWhere}`
      ).bind(...baseBinds).first(),
    ]);

    const totalSessions = (sessionsAvgRow && sessionsAvgRow.sessions) || 0;
    const totalsRow = {
      sessions: totalSessions,
      avg_scroll_pct: sessionsAvgRow && sessionsAvgRow.avg_scroll_pct,
      avg_time_s: sessionsAvgRow && sessionsAvgRow.avg_time_s,
      events: (eventsRow && eventsRow.events) || 0,
    };

    // 2) Scroll distribution: % de sessões com max_scroll >= milestone
    const milestones = [25, 50, 75, 100];
    const scrollDistRows = await Promise.all(
      milestones.map((m) =>
        db.prepare(
          `SELECT COUNT(DISTINCT session_uuid) AS sessions
             FROM section_events
            WHERE event_type='max_scroll' AND value >= ? AND ${baseWhere}`
        ).bind(m, ...baseBinds).first()
      )
    );
    const scroll_distribution = milestones.map((m, i) => {
      const s = (scrollDistRows[i] && scrollDistRows[i].sessions) || 0;
      return { milestone: m, sessions: s, pct: totalSessions > 0 ? (s / totalSessions) * 100 : 0 };
    });

    // 3) Section funnel: % de sessões que viu cada seção, ordenado pela primeira aparição (median ts_ms)
    const sectionsRes = await db.prepare(
      `SELECT section,
              COUNT(DISTINCT session_uuid) AS sessions,
              MIN(ts_ms) AS first_seen
         FROM section_events
        WHERE event_type='section_view' AND section IS NOT NULL AND ${baseWhere}
        GROUP BY section
        ORDER BY first_seen ASC`
    ).bind(...baseBinds).all();
    const section_funnel = (sectionsRes.results || []).map((r) => ({
      section: r.section,
      sessions: r.sessions,
      pct: totalSessions > 0 ? (r.sessions / totalSessions) * 100 : 0,
    }));

    // 4) CTA attribution: por last_visible_section ordenado por cliques
    const totalClicksRow = await db.prepare(
      `SELECT COUNT(*) AS c FROM section_events WHERE event_type='cta_click' AND ${baseWhere}`
    ).bind(...baseBinds).first();
    const totalClicks = (totalClicksRow && totalClicksRow.c) || 0;

    const attribRes = await db.prepare(
      `SELECT COALESCE(last_visible_section, '(sem seção)') AS last_section,
              COUNT(*) AS clicks
         FROM section_events
        WHERE event_type='cta_click' AND ${baseWhere}
        GROUP BY last_section
        ORDER BY clicks DESC`
    ).bind(...baseBinds).all();
    const cta_attribution = (attribRes.results || []).map((r) => ({
      last_section: r.last_section,
      clicks: r.clicks,
      pct: totalClicks > 0 ? (r.clicks / totalClicks) * 100 : 0,
    }));

    // 5) CTA ranking: por cta
    const ctaRes = await db.prepare(
      `SELECT cta, COUNT(*) AS clicks
         FROM section_events
        WHERE event_type='cta_click' AND cta IS NOT NULL AND ${baseWhere}
        GROUP BY cta
        ORDER BY clicks DESC`
    ).bind(...baseBinds).all();
    const cta_ranking = (ctaRes.results || []).map((r) => ({
      cta: r.cta,
      clicks: r.clicks,
      pct: totalClicks > 0 ? (r.clicks / totalClicks) * 100 : 0,
    }));

    // 6) Device breakdown
    const deviceRows = deviceTotalsRes.results || [];
    const device_breakdown = { mobile: { sessions: 0, pct: 0 }, tablet: { sessions: 0, pct: 0 }, desktop: { sessions: 0, pct: 0 } };
    for (const r of deviceRows) {
      const d = ["mobile", "tablet", "desktop"].includes(r.device) ? r.device : "desktop";
      device_breakdown[d] = {
        sessions: r.sessions,
        pct: totalSessions > 0 ? (r.sessions / totalSessions) * 100 : 0,
      };
    }

    // 7) Device split detalhado
    const device_split = deviceRows.map((r) => ({
      device: r.device || "desktop",
      sessions: r.sessions,
      pct: totalSessions > 0 ? (r.sessions / totalSessions) * 100 : 0,
      avg_scroll_pct: r.avg_scroll_pct,
      avg_time_s: r.avg_time_s,
      cta_clicks: r.cta_clicks,
      ctr: r.sessions > 0 ? (r.clickers / r.sessions) * 100 : 0,
    }));
    device_split.sort((a, b) => (b.sessions || 0) - (a.sessions || 0));

    return json({
      page,
      filters: { since, until, device, utm_campaign: utmCampaign, funnel },
      totals: {
        sessions: totalSessions,
        events: (totalsRow && totalsRow.events) || 0,
        avg_scroll_pct: totalsRow && totalsRow.avg_scroll_pct != null ? totalsRow.avg_scroll_pct : null,
        avg_time_s: totalsRow && totalsRow.avg_time_s != null ? totalsRow.avg_time_s : null,
        cta_clicks: totalClicks,
        cta_clickers: (ctaClickersRow && ctaClickersRow.clickers) || 0,
      },
      scroll_distribution,
      section_funnel,
      cta_attribution,
      cta_ranking,
      device_breakdown,
      device_split,
    });
  } catch (err) {
    return json({ error: err.message || "Erro interno" }, 500);
  }
}
