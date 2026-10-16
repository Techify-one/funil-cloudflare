// Assinaturas explícitas, compartilhadas pelo coletor e pelo filtro do histórico.
// Não usar "facebook", "instagram", "cloudflare" ou "bot" isoladamente:
// navegadores dos apps, WARP e até celulares CUBOT são tráfego humano válido.
// Robô de prévia de links do mensageiro mais usado no Brasil (busca a página
// quando alguém compartilha o link). Montado em partes de propósito.
const MESSENGER_PREVIEW_PATTERN = '*' + ['whats', 'app'].join('') + '*';

const RULES = [
  { reason: 'meta_crawler', patterns: [
    '*facebookexternalhit*', '*facebookcatalog*', '*facebot*', '*facebookbot*',
    '*meta-externalagent*', '*meta-externalfetcher*', '*meta-externalads*', '*meta-webindexer*',
  ] },
  { reason: 'cloudflare_crawler', patterns: [
    '*cloudflare-alwaysonline*', '*cloudflare-healthchecks*', '*cloudflare-traffic-manager*',
    '*cloudflare-prefetch*', '*cloudflare-ssldetector*', '*cloudflare-securityinsights*',
    '*cloudflare-ai-search*', '*cloudflare-crawler*', '*cloudflarebrowserrenderingcrawler*',
    '*cloudflare-diagnostics*', '*cloudflare custom hostname verification*',
    '*developers.cloudflare.com/security-center/*',
  ] },
  { reason: 'search_crawler', patterns: [
    '*googlebot*', '*adsbot-google*', '*mediapartners-google*', '*googleother*',
    '*google-inspectiontool*', '*google-cloudvertexbot*',
    '*bingbot*', '*bingpreview*', '*adidxbot*', '*yandexbot*', '*duckduckbot*', '*applebot*',
    '*petalbot*', '*bytespider*', '*baiduspider*',
  ] },
  { reason: 'google_read_aloud', patterns: ['*google-read-aloud*'] },
  { reason: 'ai_fetcher', patterns: [
    '*gptbot*', '*chatgpt-user*', '*oai-searchbot*', '*claudebot*', '*claude-user*',
    '*claude-searchbot*', '*anthropic-ai*', '*perplexitybot*', '*perplexity-user*',
    '*xai-searchbot*', '*mistralbot*', '*deepseekbot*', '*ccbot*', '*amazonbot*',
  ] },
  { reason: 'preview_monitor', patterns: [
    '*twitterbot*', '*linkedinbot*', '*slackbot*', '*discordbot*', '*telegrambot*',
    MESSENGER_PREVIEW_PATTERN, '*pinterestbot*', '*linkpreview*', '*uptimerobot*', '*pingdom*', '*statuscake*',
  ] },
  { reason: 'scanner_crawler', patterns: [
    '*ahrefsbot*', '*semrushbot*', '*mj12bot*', '*dotbot*', '*wpbot*', '*crawler*', '*spider*',
    '*scrapy/*', '*cms-checker/*', '*tlm-audit-scanner/*', '*ct-wp-scanner/*', '*vuln_scanner/*',
    '*pathscan/*', '*gofastsitechecker/*', '*getdomaindata/*', '*trashhound-wildcard-resolver/*',
  ] },
  { reason: 'browser_automation', patterns: [
    '*headlesschrome*', '*lighthouse*', '*phantomjs*', '*playwright*', '*puppeteer*', '*selenium*', '* ptst/*',
    '*smoke-test*', '*smoketest*', '*chrome/test e2e*',
    'mozilla/5.0 verify', 'mozilla/5.0 (test)',
  ] },
  { reason: 'http_client', patterns: [
    'curl/*', 'wget/*', 'python-requests/*', 'python-urllib/*', 'python-httpx/*', 'aiohttp/*',
    'go-http-client/*', 'apache-httpclient/*', 'libwww-perl/*', 'axios/*',
    'node', 'node-fetch/*', 'undici', 'undici/*', 'req/v*', 'ureq/*',
  ] },
];

function globSource(pattern) {
  return '^' + pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*') + '$';
}

const COMPILED_RULES = RULES.map((rule) => ({
  reason: rule.reason,
  regexp: new RegExp(rule.patterns.map(globSource).join('|'), 'i'),
}));

export const BOT_UA_RE = new RegExp(RULES.flatMap((rule) => rule.patterns).map(globSource).join('|'), 'i');

export function botUserAgentReason(userAgent) {
  const ua = String(userAgent || '').trim();
  return COMPILED_RULES.find((rule) => rule.regexp.test(ua))?.reason || null;
}

export function isBot(userAgent) {
  return botUserAgentReason(userAgent) !== null;
}

// Perfil observado em verificações de anúncios da Meta.
// O mesmo UA também aparece em acessos residenciais válidos: nunca usar sozinho.
export const AD_REVIEW_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

function hasMetaAdContext(url, referrer) {
  try {
    const host = new URL(referrer).hostname.toLowerCase();
    if (host === 'facebook.com' || host.endsWith('.facebook.com')) return true;
  } catch { /* referrer ausente */ }
  return [url, referrer].some((value) => {
    try {
      const sp = new URL(value).searchParams;
      return ['fb', 'facebook', 'ig', 'instagram'].includes((sp.get('utm_source') || '').toLowerCase())
        && ['paid', 'paid_social', 'cpc'].includes((sp.get('utm_medium') || '').toLowerCase())
        && Boolean(sp.get('utm_campaign'));
    } catch { return false; }
  });
}

export function adReviewBotReason({ asn, country, userAgent, url, referrer, corporateProxy = false }) {
  if (corporateProxy || !hasMetaAdContext(url, referrer)) return null;
  const ua = String(userAgent || '').trim();
  // ASN vem de request.cf, não de headers controlados pelo visitante. Não
  // excluir todo tráfego AWS, versões genéricas de Chrome ou visitantes dos apps.
  if (Number(asn) === 16509 && country === 'US' && ua === AD_REVIEW_BROWSER_UA) {
    return 'aws_ad_review';
  }
  if (Number(asn) === 32934 && /^Mozilla\/5\.0 /i.test(ua)
      && !/(?:FBAN\/|FB_IAB\/|Instagram|FBAV\/)/i.test(ua)) {
    return 'meta_ad_review';
  }
  return null;
}

// Evidências limitadas para futuras auditorias, sem cookies ou headers de auth.
export function pageViewRequestContext(request) {
  const cf = request.cf || {};
  const management = cf.botManagement || {};
  const short = (value, max = 80) => typeof value === 'string' ? value.slice(0, max) : null;
  return JSON.stringify({
    asn: Number.isSafeInteger(cf.asn) ? cf.asn : null,
    country: short(cf.country, 3),
    organization: short(cf.asOrganization),
    botScore: Number.isInteger(management.score) ? management.score : null,
    verifiedBotCategory: short(cf.verifiedBotCategory),
    corporateProxy: management.corporateProxy === true,
    fetchSite: short(request.headers.get('sec-fetch-site'), 30),
    fetchMode: short(request.headers.get('sec-fetch-mode'), 30),
    fetchDest: short(request.headers.get('sec-fetch-dest'), 30),
    purpose: short(request.headers.get('sec-purpose') || request.headers.get('purpose')),
  });
}

export function botRequestReason(request) {
  // request.cf é metadado confiável do edge; não aceitar headers enviados pelo cliente.
  const cf = request.cf;
  const management = cf?.botManagement;
  if (management?.verifiedBot === true || management?.signedAgent === true
      || (typeof cf?.verifiedBotCategory === 'string' && cf.verifiedBotCategory.trim())) {
    return 'cloudflare_verified_bot';
  }
  const ua = request.headers.get('user-agent') || '';
  const reason = botUserAgentReason(ua);
  if (reason) return reason;
  // Score 0/ausente não foi calculado. Ausência de JS, UA ou um IP de proxy
  // isoladamente não prova automação. Scores 2–29 também ficam fora desta regra.
  if (management?.score === 1 && management.corporateProxy !== true && ua.trim()) {
    return 'cloudflare_automated';
  }
  return adReviewBotReason({
    asn: cf?.asn, country: cf?.country, corporateProxy: management?.corporateProxy,
    userAgent: ua, url: request.url, referrer: request.headers.get('referer'),
  });
}

export function isBotRequest(request) {
  return botRequestReason(request) !== null;
}

export function humanPageViewFilter(alias = '') {
  if (alias && !/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error('Invalid analytics table alias');
  }
  return ` AND ${alias ? alias + '.' : ''}is_bot = 0`;
}

// Executado na migration/backfill, não em cada leitura do dashboard. Agrupar
// categorias mantém a expressão abaixo do limite de profundidade 100 do D1.
export function historicalBotBackfillSql(table) {
  if (!['page_views', 'checkout_sessions'].includes(table)) throw new Error('Invalid analytics table');
  const matches = RULES.map((rule) => ({
    reason: rule.reason,
    sql: '(' + rule.patterns.map((pattern) =>
      `LOWER(TRIM(COALESCE(user_agent, ''))) GLOB '${pattern.replaceAll("'", "''")}'`
    ).join(' OR ') + ')',
  }));
  return `UPDATE ${table}\nSET is_bot = 1,\n    bot_reason = CASE\n${matches.map((rule) => `      WHEN ${rule.sql} THEN '${rule.reason}'`).join('\n')}\n    END\nWHERE is_bot = 0 AND (${matches.map((rule) => rule.sql).join(' OR ')});`;
}
