// Classificação de robôs usada pelo dashboard (humanPageViewFilter) e pelo
// registro de pageviews. Só cobre assinaturas genéricas de mercado.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as bot from '../../shared/bot-detection.mjs';
import { logPageView } from '../../shared/utils.js';

const { botUserAgentReason, botRequestReason, humanPageViewFilter, historicalBotBackfillSql, isBot, pageViewRequestContext } = bot;

const browser = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/152.0.0.0 Mobile Safari/537.36';
const request = (ua = browser, cf) => {
  const req = new Request('https://example.com/exemplo', { headers: { 'user-agent': ua } });
  if (cf) Object.defineProperty(req, 'cf', { value: cf });
  return req;
};

test('identifies Meta, search, AI, scanner, HTTP client and browser automation signatures', () => {
  for (const [ua, reason] of [
    [browser + ' [FB_IAB/FB4A;FBAV/576;] meta-externalads/1.1', 'meta_crawler'],
    ['facebookexternalhit/1.1', 'meta_crawler'],
    ['META-EXTERNALFETCHER/1.1', 'meta_crawler'],
    ['meta-webindexer/1.1', 'meta_crawler'],
    [browser + ' (compatible; Google-Read-Aloud; +https://support.google.com/webmasters/answer/1061943)', 'google_read_aloud'],
    ['AdsBot-Google-Mobile', 'search_crawler'],
    ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'search_crawler'],
    ['ChatGPT-User/1.0', 'ai_fetcher'],
    ['Claude-User (claude-code/2.1.132; +https://support.anthropic.com/)', 'ai_fetcher'],
    ['GPTBot/1.4', 'ai_fetcher'],
    ['Mozilla/5.0 (compatible; wpbot/1.4)', 'scanner_crawler'],
    ['Mozilla/5.0 (compatible; CMS-Checker/1.0)', 'scanner_crawler'],
    ['Mozilla/5.0 (X11; Linux x86_64) playwright-test', 'browser_automation'],
    ['Mozilla/5.0 HeadlessChrome/147.0.7727.15', 'browser_automation'],
    ['curl/8.5.0', 'http_client'], [' python-requests/2.34.2 ', 'http_client'],
    ['node', 'http_client'], ['LinkPreview/1.6', 'preview_monitor'],
  ]) {
    assert.equal(botUserAgentReason(ua), reason, ua);
    assert.equal(isBot(ua), true, ua);
  }
});

test('recognizes Cloudflare monitors without treating Cloudflare users as bots', () => {
  for (const token of ['Cloudflare-Healthchecks/1.0', 'CloudFlare-AlwaysOnline/1.0', 'Cloudflare-Traffic-Manager/1.0', 'CloudFlare-Prefetch/0.1', 'Cloudflare-SSLDetector', 'Cloudflare-AI-Search']) {
    assert.equal(botUserAgentReason(`Mozilla/5.0 (compatible; ${token})`), 'cloudflare_crawler');
  }
  assert.equal(botRequestReason(request(browser, { asn: 13335, asOrganization: 'Cloudflare, Inc.' })), null);
});

test('preserves ordinary Facebook and Instagram in-app visitors and unknown user agents', () => {
  for (const ua of [
    browser, browser + ' [FB_IAB/FB4A;FBAV/576.0.0.42.73;IABMV/1;]',
    '[FBAN/FB4A;FBAV/557.0.0.59.72;FBPN/com.facebook.katana;FBDV/SM-A175F;]',
    'Facebook/948561885 CFNetwork/3860.500.112 Darwin/25.4.0',
    'Instagram 428.0.0.47.67 Android (36/16; Xiaomi/POCO; pt_BR)',
    browser + ' Instagram 426 Android (33/13; CUBOT; KINGKONG POWER; pt_BR; IABMV/1)',
    'Mozilla/5.0 (iPhone)', '', null,
  ]) assert.equal(isBot(ua), false, String(ua));
});

test('uses trusted Cloudflare signals with conservative score handling', () => {
  for (const cf of [
    { botManagement: { verifiedBot: true, score: 99 } },
    { botManagement: { signedAgent: true } },
    { verifiedBotCategory: 'Ads Verification' },
  ]) assert.equal(botRequestReason(request(browser, cf)), 'cloudflare_verified_bot');
  assert.equal(botRequestReason(request(browser, { botManagement: { score: 1 } })), 'cloudflare_automated');
  for (const cf of [
    {}, { verifiedBotCategory: '' }, { botManagement: { score: 0 } },
    { botManagement: { score: 2 } }, { botManagement: { score: 29 } },
    { botManagement: { score: 99, jsDetection: { passed: false } } },
    { botManagement: { score: 1, corporateProxy: true } },
  ]) assert.equal(botRequestReason(request(browser, cf)), null);
  assert.equal(botRequestReason(request('', { botManagement: { score: 1 } })), null);
  const spoofed = request();
  spoofed.headers.set('cf-verified-bot', 'true');
  spoofed.headers.set('cf-bot-score', '1');
  assert.equal(botRequestReason(spoofed), null);
});

test('drops automatic pageviews before storage, including markers after the stored UA limit', async () => {
  let writes = 0;
  const env = { DB: { prepare: () => ({ bind: () => ({ run: async () => { writes++; } }) }) } };
  await logPageView('exemplo', request(browser + ' '.repeat(510) + 'meta-externalads/1.1'), env, 'exemplo');
  await logPageView('exemplo', request(browser, { botManagement: { verifiedBot: true } }), env, 'exemplo');
  await logPageView('exemplo', request(browser, { botManagement: { score: 1 } }), env, 'exemplo');
  assert.equal(writes, 0);
  await logPageView('exemplo', request(), env, 'exemplo');
  await logPageView('exemplo', request(), env, 'exemplo');
  assert.equal(writes, 2, 'human F5 still records each load');
});

test('ad review combines the audited browser profile, trusted network and Facebook context', { skip: !bot.AD_REVIEW_BROWSER_UA && 'perfil de revisão de anúncios não exportado' }, () => {
  const reviewUa = bot.AD_REVIEW_BROWSER_UA;
  const review = (cf, ua = reviewUa, referrer = 'https://www.facebook.com/') => {
    const req = request(ua, cf);
    if (referrer) req.headers.set('referer', referrer);
    return req;
  };
  assert.equal(botRequestReason(review({ asn: 16509, country: 'US' })), 'aws_ad_review');
  assert.equal(botRequestReason(review({ asn: 32934 }, browser)), 'meta_ad_review');
  assert.equal(botRequestReason(review({ asn: 16509, country: 'US' }, reviewUa,
    'https://example.com/exemplo?utm_source=fb&utm_medium=paid&utm_campaign=campanha-1')), 'aws_ad_review');
  for (const req of [
    review({ asn: 28126, country: 'BR' }), // O mesmo Chrome em rede residencial.
    review({ asn: 16509, country: 'US' }, browser), // Outro navegador na AWS.
    review({ asn: 16509, country: 'BR' }),
    review({ asn: 16509, country: 'US' }, reviewUa, ''),
    review({ asn: 16509, country: 'US' }, reviewUa, 'https://facebook.com.example.test/'),
    review({ asn: 16509, country: 'US', botManagement: { corporateProxy: true } }),
    review({ asn: 32934 }, browser + ' [FB_IAB/FB4A;FBAV/576.0.0;]'),
    review({ asn: 32934 }, browser + ' Instagram 428.0'),
    review(undefined),
  ]) assert.equal(botRequestReason(req), null);
  const spoofed = review(undefined);
  spoofed.headers.set('cf-asn', '16509');
  spoofed.headers.set('cf-ipcountry', 'US');
  assert.equal(botRequestReason(spoofed), null, 'client headers cannot establish a network identity');
});

test('audit context stores limited edge evidence without cookies, auth or full URLs', () => {
  const req = request(browser, { asn: 28126, country: 'BR', asOrganization: 'Test ISP', botManagement: { score: 87 } });
  req.headers.set('cookie', 'session=private-cookie');
  req.headers.set('authorization', 'private-auth');
  req.headers.set('referer', 'https://example.test/?private-query');
  req.headers.set('sec-fetch-mode', 'navigate');
  const value = pageViewRequestContext(req);
  assert.equal(value.includes('private-'), false);
  const context = JSON.parse(value);
  assert.equal(context.asn, 28126);
  assert.equal(context.botScore, 87);
  assert.equal(context.fetchMode, 'navigate');
  assert.equal(JSON.parse(pageViewRequestContext(request())).asn, null);
});

test('SQL filtering accepts only controlled identifiers', () => {
  assert.equal(humanPageViewFilter(), ' AND is_bot = 0');
  assert.equal(humanPageViewFilter('pv'), ' AND pv.is_bot = 0');
  assert.throws(() => humanPageViewFilter('user_agent) OR 1=1 --'), /Invalid/);
  assert.match(historicalBotBackfillSql('page_views'), /^UPDATE page_views/);
  assert.match(historicalBotBackfillSql('checkout_sessions'), /^UPDATE checkout_sessions/);
  assert.throws(() => historicalBotBackfillSql('orders'), /Invalid/);
});
