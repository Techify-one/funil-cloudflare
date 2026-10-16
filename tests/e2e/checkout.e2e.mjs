#!/usr/bin/env node
/**
 * Teste E2E do checkout contra a instância publicada.
 *
 * Abre /checkout/<oferta> num Chromium real (Playwright), preenche o formulário
 * como uma pessoa, gera o Pix (Mercado Pago de verdade), força a aprovação pelo
 * endpoint protegido /api/mp/_debug_approve, espera o redirecionamento para
 * /obrigado e confere:
 *   - eventos do Pixel na rede (InitiateCheckout, Lead e Purchase, todos com eventID);
 *   - eventID do Purchase no navegador igual ao do servidor (deduplicação com a CAPI);
 *   - banco D1 (via wrangler): pagamento aprovado, pedido aprovado com UTMs e
 *     IDs da Meta, lead atualizado, disparos pós-compra (capi e, se a oferta
 *     tiver e-mail ligado, email);
 *   - página /obrigado renderizada.
 * No fim apaga tudo o que criou no banco.
 *
 * Uso (na raiz do repositório):
 *   node tests/e2e/checkout.e2e.mjs
 *
 * Requer no .env da raiz: APP_HOSTNAME (ou E2E_BASE_URL), DEBUG_APPROVE_TOKEN
 * (criado por `npm run setup -- --debug-approve`), CLOUDFLARE_API_TOKEN,
 * CLOUDFLARE_ACCOUNT_ID e D1_NAME. Requer `npx playwright install chromium`.
 *
 * Variáveis opcionais: E2E_BASE_URL, E2E_OFFER (padrão produto-exemplo),
 * E2E_FUNNEL (padrão exemplo), E2E_EMAIL, E2E_HEADLESS=false, E2E_CLEANUP=false,
 * E2E_LEAD_STATUS (lista de status aceitos para o lead após a compra),
 * E2E_REQUIRE_EMAIL=true (falha se a oferta não tiver e-mail pós-compra ligado).
 *
 * Nenhum segredo é impresso.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ---------- .env da raiz (sem nunca imprimir valores) ----------
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
try {
  for (const raw of readFileSync(resolve(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
} catch { /* .env opcional se as variáveis já estiverem no ambiente */ }

const env = process.env;
const HOST = (env.APP_HOSTNAME || '').trim();
const BASE_URL = (env.E2E_BASE_URL || (HOST ? `https://${HOST}` : '')).replace(/\/+$/, '');
const OFFER_CODE = env.E2E_OFFER || 'produto-exemplo';
const FUNNEL = env.E2E_FUNNEL || 'exemplo';
const HEADLESS = env.E2E_HEADLESS !== 'false';
const CLEANUP = env.E2E_CLEANUP !== 'false';
const DEBUG_TOKEN = env.DEBUG_APPROVE_TOKEN;
const D1_NAME = env.D1_NAME;
// A compra vive em `orders`; dependendo da versão do checkout o lead fica em
// 'comprou' ou permanece em 'pix_gerado'. Use E2E_LEAD_STATUS=comprou para exigir.
const LEAD_STATUSES = (env.E2E_LEAD_STATUS || 'comprou,pix_gerado').split(',').map((s) => s.trim()).filter(Boolean);
const REQUIRE_EMAIL = env.E2E_REQUIRE_EMAIL === 'true';

const TS = Date.now();
const TEST_EMAIL = env.E2E_EMAIL || `e2e-${TS}@example.com`;
const TEST_NAME = `E2E Teste ${TS}`;
const TEST_PHONE = '11999990000';
const UTM_CAMPAIGN = `E2E_${TS}`;
const META_IDS = { meta_campaign_id: `e2ec${TS}`, meta_adset_id: `e2es${TS}`, meta_ad_id: `e2ea${TS}` };

const RESET = '\x1b[0m', RED = '\x1b[31m', GREEN = '\x1b[32m', BLUE = '\x1b[34m', DIM = '\x1b[2m', YEL = '\x1b[33m';
const log = (s) => console.log(s);
const ok = (s) => console.log(`${GREEN}✓${RESET} ${s}`);
const err = (s) => console.log(`${RED}✗${RESET} ${s}`);
const warn = (s) => console.log(`${YEL}!${RESET} ${s}`);
const step = (n, s) => console.log(`\n${BLUE}[${n}]${RESET} ${s}`);
const info = (s) => console.log(`${DIM}    ${s}${RESET}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const errors = [];
function assert(cond, msg) {
  if (cond) ok(msg); else { err(msg); errors.push(msg); }
}

// ---------- D1 via wrangler (mesmo binário do projeto) ----------
function d1(sql) {
  const res = spawnSync('npx', ['--no-install', 'wrangler', 'd1', 'execute', D1_NAME, '--remote', '--json', '--command', sql], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...env, WRANGLER_SEND_METRICS: 'false' },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0) {
    const detail = String(res.stderr || res.stdout || '').trim().split('\n').slice(-3).join(' | ');
    throw new Error(`wrangler d1 execute falhou: ${detail.slice(0, 300)}`);
  }
  const out = String(res.stdout || '');
  const start = out.search(/^\s*[[{]/m); // ignora avisos antes do JSON
  const parsed = JSON.parse(start >= 0 ? out.slice(start) : out);
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((r) => r.results || []);
}

async function d1Poll(sql, ready, { tries = 10, delayMs = 2000 } = {}) {
  let rows = [];
  for (let i = 0; i < tries; i += 1) {
    rows = d1(sql);
    if (ready(rows)) return rows;
    await sleep(delayMs);
  }
  return rows;
}

// ---------- Pixel: extrai parâmetros da URL e do corpo ----------
function pixelParams(url, postData) {
  const params = new URLSearchParams();
  try { new URL(url).searchParams.forEach((v, k) => params.append(k, v)); } catch { /* ignora */ }
  if (!postData) return params;
  if (postData.includes('Content-Disposition')) {
    // Beacon em multipart/form-data: name="ev"\r\n\r\nPurchase
    for (const m of postData.matchAll(/name="([^"]+)"\r?\n(?:[^\r\n]+\r?\n)*\r?\n([^\r\n]*)/g)) params.append(m[1], m[2]);
  } else if (!postData.trim().startsWith('{')) {
    try { new URLSearchParams(postData).forEach((v, k) => params.append(k, v)); } catch { /* ignora */ }
  }
  return params;
}

// ---------- preflight ----------
if (!BASE_URL) { err('Defina APP_HOSTNAME no .env (ou E2E_BASE_URL).'); process.exit(2); }
if (!DEBUG_TOKEN) { err('DEBUG_APPROVE_TOKEN ausente. Rode `npm run setup -- --debug-approve`.'); process.exit(2); }
const D1_ENABLED = Boolean(D1_NAME && env.CLOUDFLARE_API_TOKEN);
if (!D1_ENABLED) warn('D1_NAME ou CLOUDFLARE_API_TOKEN ausente: as checagens de banco e a limpeza serão puladas.');

log(`${BLUE}=== Teste E2E do checkout ===${RESET}`);
info(`URL base:  ${BASE_URL}`);
info(`Oferta:    ${OFFER_CODE}`);
info(`Funil:     ${FUNNEL}`);
info(`E-mail:    ${TEST_EMAIL}`);
info(`Campanha:  ${UTM_CAMPAIGN}`);
info(`Headless:  ${HEADLESS}`);

const browser = await chromium.launch({ headless: HEADLESS });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  // "Chrome/Test E2E" é classificado como automação: não suja page_views nem o diagnóstico do checkout.
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/Test E2E',
});
const page = await context.newPage();

const pixelEvents = [];
page.on('request', (req) => {
  let u;
  try { u = new URL(req.url()); } catch { return; }
  if (!/(^|\.)facebook\.com$/.test(u.hostname) || !/^\/tr\/?$/.test(u.pathname)) return;
  const p = pixelParams(req.url(), req.postData());
  const ev = p.get('ev');
  if (ev) pixelEvents.push({ ev, eid: p.get('eid') || '', at: Date.now() });
});

let createPixData = null;
let PID = null;
let LID = null;

const query = new URLSearchParams({
  funnel: FUNNEL,
  utm_page: `/${FUNNEL}`,
  utm_source: 'e2e',
  utm_medium: 'test',
  utm_campaign: UTM_CAMPAIGN,
  utm_content: 'e2e-adset',
  utm_term: '1',
  ...META_IDS,
});
const checkoutUrl = `${BASE_URL}/checkout/${OFFER_CODE}?${query.toString()}`;

try {
  step(1, 'Abrindo o checkout');
  await page.goto(checkoutUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#name', { timeout: 15000 });
  ok(`página carregou (${new URL(page.url()).pathname})`);

  step(2, 'Preenchendo o formulário');
  await page.fill('#name', TEST_NAME);
  await page.fill('#email', TEST_EMAIL);
  await page.fill('#phone', TEST_PHONE);
  ok('nome, e-mail e celular preenchidos');

  step(3, 'Escolhendo Pix e gerando o QR Code');
  if (await page.locator('#tab-pix').isVisible()) await page.click('#tab-pix');
  await page.waitForSelector('#btn-pay-pix', { state: 'visible', timeout: 10000 });
  const [pixResp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/mp/create-pix') && r.request().method() === 'POST', { timeout: 30000 }),
    page.click('#btn-pay-pix'),
  ]);
  try { createPixData = await pixResp.json(); } catch { createPixData = null; }
  assert(createPixData && createPixData.ok === true && !createPixData.already_paid, 'create-pix retornou ok');
  if (!createPixData || !createPixData.ok) {
    info(`resposta: ${JSON.stringify({ error: createPixData && createPixData.error, detail: createPixData && createPixData.detail })}`);
    throw new Error('create-pix falhou');
  }
  PID = String(createPixData.payment_id);
  LID = Number(createPixData.lead_id) || null;
  if (!/^\d{1,32}$/.test(PID)) throw new Error('payment_id inválido na resposta do create-pix');
  await page.waitForSelector('#qr-code-text', { timeout: 15000 });
  ok('QR Code exibido');
  info(`payment_id=${PID} lead_id=${LID}`);

  step(4, 'Forçando a aprovação (/api/mp/_debug_approve)');
  const apResp = await fetch(`${BASE_URL}/api/mp/_debug_approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-debug-token': DEBUG_TOKEN },
    body: JSON.stringify({ payment_id: PID }),
  });
  const apData = await apResp.json().catch(() => ({}));
  if (apResp.status === 503) info('503: o Worker está sem DEBUG_APPROVE_TOKEN (rode npm run setup -- --debug-approve)');
  if (apResp.status === 403) info('403: DEBUG_APPROVE_TOKEN do .env diferente do segredo do Worker');
  assert(apResp.ok && apData.ok === true, 'debug-approve retornou ok=true');

  step(5, 'Aguardando o redirecionamento para a página de obrigado');
  try {
    await page.waitForURL((u) => u.searchParams.get('pid') === PID, { timeout: 30000 });
    ok(`redirecionou para ${new URL(page.url()).pathname}`);
  } catch {
    err('não redirecionou em 30 s (polling de /api/mp/status ou redirect quebrado)');
    errors.push('sem_redirect');
  }
  await page.waitForTimeout(3000); // tempo para o Pixel enviar os eventos

  step(6, 'Eventos do Pixel na rede');
  const byEv = (name) => pixelEvents.filter((e) => e.ev === name);
  info(`eventos: ${[...new Set(pixelEvents.map((e) => e.ev))].join(', ') || '(nenhum)'}`);
  const ic = byEv('InitiateCheckout');
  const lead = byEv('Lead');
  const purchase = byEv('Purchase');
  assert(ic.length >= 1 && ic.some((e) => e.eid), 'InitiateCheckout disparado com eventID');
  assert(lead.length >= 1 && lead.some((e) => e.eid), 'Lead disparado com eventID');
  assert(purchase.length >= 1 && purchase.some((e) => e.eid), 'Purchase disparado com eventID');
  if (LID) assert(lead.some((e) => e.eid === `lead-${LID}`), `eventID do Lead = lead-${LID} (mesmo da CAPI)`);
  const purchaseEid = (purchase.find((e) => e.eid) || {}).eid || '';
  if (purchaseEid) info(`Purchase eventID=${purchaseEid}`);

  step(7, 'Banco D1 (pagamento, pedido, lead, disparos)');
  if (!D1_ENABLED) {
    warn('pulado: sem D1_NAME/CLOUDFLARE_API_TOKEN');
  } else {
    const pay = d1(`SELECT p.id, p.status, p.approved_at, p.meta_event_id, p.amount_cents, o.email_enabled
                      FROM payments p LEFT JOIN offers o ON o.id = p.offer_id
                     WHERE p.mp_payment_id = '${PID}' LIMIT 1`)[0];
    if (!pay) {
      err('pagamento não encontrado em payments');
      errors.push('sem_payment');
    } else {
      info(`payments: status=${pay.status} valor=${pay.amount_cents}`);
      assert(pay.status === 'approved', 'payments.status = approved');
      assert(Boolean(pay.approved_at), 'payments.approved_at preenchido');
    }

    const order = d1(`SELECT o.id, o.status, o.lead_id, o.meta_event_id, o.side_effects_at, o.utm_campaign, o.utm_term,
                             o.meta_ad_id, f.slug AS funnel_slug
                        FROM orders o LEFT JOIN funnels f ON f.id = o.funnel_id
                       WHERE o.gateway = 'mercadopago' AND o.gateway_txn_id = '${PID}' LIMIT 1`)[0];
    if (!order) {
      err('pedido não encontrado em orders');
      errors.push('sem_order');
    } else {
      info(`orders: id=${order.id} status=${order.status} funil=${order.funnel_slug} campanha=${order.utm_campaign} anuncio=${order.meta_ad_id}`);
      assert(order.status === 'approved', 'orders.status = approved');
      assert(order.utm_campaign === UTM_CAMPAIGN && order.utm_term === '1', 'UTMs gravadas no pedido');
      assert(order.meta_ad_id === META_IDS.meta_ad_id, 'meta_ad_id gravado no pedido');
      if (order.funnel_slug == null) warn(`funil "${FUNNEL}" não existe no banco: o pedido ficou sem funnel_id`);
      else assert(order.funnel_slug === FUNNEL, `pedido atribuído ao funil "${FUNNEL}"`);
      if (purchaseEid) assert(purchaseEid === order.meta_event_id, 'eventID do Purchase no navegador = orders.meta_event_id (dedup com a CAPI)');
    }

    if (LID) {
      const leadRow = d1(`SELECT status, method, funnel, utm_campaign FROM leads WHERE id = ${LID}`)[0];
      if (!leadRow) {
        err('lead não encontrado');
        errors.push('sem_lead');
      } else {
        info(`leads: status=${leadRow.status} method=${leadRow.method} funil=${leadRow.funnel}`);
        assert(LEAD_STATUSES.includes(leadRow.status), `leads.status em [${LEAD_STATUSES.join(', ')}]`);
        assert(leadRow.funnel === FUNNEL && leadRow.utm_campaign === UTM_CAMPAIGN, 'lead com funil e UTMs corretos');
      }
    }

    if (order) {
      const emailOn = pay && Number(pay.email_enabled) === 1;
      const dispatches = await d1Poll(
        `SELECT channel, status, error FROM purchase_dispatches WHERE order_id = ${Number(order.id)} ORDER BY id`,
        (rows) => rows.some((r) => r.channel === 'capi') && (!emailOn || rows.some((r) => r.channel === 'email')),
      );
      info(`disparos: ${dispatches.map((d) => `${d.channel}=${d.status}`).join(', ') || '(nenhum)'}`);
      const capi = dispatches.find((d) => d.channel === 'capi');
      assert(Boolean(capi), 'disparo capi registrado');
      if (capi) {
        assert(capi.status === 'sent', 'CAPI Purchase enviada (status sent)');
        if (capi.status !== 'sent') info(`erro capi: ${String(capi.error || '').slice(0, 160)}`);
      }
      if (!emailOn && REQUIRE_EMAIL) {
        err(`E2E_REQUIRE_EMAIL=true, mas a oferta "${OFFER_CODE}" está com e-mail desligado (ligue em /ofertas)`);
        errors.push('email_desligado');
      } else if (!emailOn) {
        info(`oferta "${OFFER_CODE}" com e-mail desligado: checagem de e-mail pulada (E2E_REQUIRE_EMAIL=true exige)`);
      } else {
        const mail = dispatches.find((d) => d.channel === 'email');
        assert(Boolean(mail), 'disparo email registrado');
        if (mail) {
          const delivered = ['delivered', 'queued', 'sent'].includes(mail.status);
          if (delivered) ok(`e-mail enviado (status ${mail.status})`);
          else if (mail.status === 'failed' && /@example\.com$/i.test(TEST_EMAIL)) {
            warn(`e-mail recusado para ${TEST_EMAIL} (esperado com example.com; use E2E_EMAIL real para validar a entrega)`);
          } else {
            err(`e-mail não enviado (status ${mail.status}: ${String(mail.error || '').slice(0, 160)})`);
            errors.push('email_nao_enviado');
          }
        }
      }
      assert(Boolean(d1(`SELECT side_effects_at FROM orders WHERE id = ${Number(order.id)}`)[0]?.side_effects_at), 'orders.side_effects_at preenchido (efeitos pós-compra rodaram)');
    }
  }

  step(8, 'Página de obrigado');
  if (new URL(page.url()).searchParams.get('pid') === PID) {
    const title = await page.title();
    info(`title="${title}"`);
    assert(title.trim().length > 0, 'página de obrigado renderizou');
  } else {
    warn('pulado: o navegador não chegou à página de obrigado');
  }
} catch (e) {
  err(`exceção: ${e.message}`);
  errors.push(e.message);
} finally {
  await browser.close();

  if (CLEANUP && D1_ENABLED && (PID || LID)) {
    step('limpeza', 'Apagando os dados do teste');
    const leadFilter = `(${LID ? `id = ${Number(LID)} OR ` : ''}email = '${TEST_EMAIL.replace(/'/g, "''")}' OR name = '${TEST_NAME}')`;
    const statements = [
      PID && `DELETE FROM purchase_dispatches WHERE order_id IN (SELECT id FROM orders WHERE gateway = 'mercadopago' AND gateway_txn_id = '${PID}')`,
      `DELETE FROM purchase_dispatches WHERE lead_id IN (SELECT id FROM leads WHERE ${leadFilter})`,
      PID && `DELETE FROM orders WHERE gateway = 'mercadopago' AND gateway_txn_id = '${PID}'`,
      `DELETE FROM orders WHERE lead_id IN (SELECT id FROM leads WHERE ${leadFilter})`,
      PID && `DELETE FROM payment_order_bumps WHERE payment_id IN (SELECT id FROM payments WHERE mp_payment_id = '${PID}')`,
      PID && `DELETE FROM payments WHERE mp_payment_id = '${PID}'`,
      `DELETE FROM payments WHERE lead_id IN (SELECT id FROM leads WHERE ${leadFilter})`,
      `DELETE FROM payment_errors WHERE lead_id IN (SELECT id FROM leads WHERE ${leadFilter})`,
      `DELETE FROM checkout_sessions WHERE lead_id IN (SELECT id FROM leads WHERE ${leadFilter})`,
      `DELETE FROM leads WHERE ${leadFilter}`,
      `DELETE FROM page_views WHERE utm_campaign = '${UTM_CAMPAIGN}'`,
    ].filter(Boolean);
    try {
      d1(statements.join('; '));
      info('banco limpo (disparos, pedido, pagamento, lead, visitas)');
    } catch (e) {
      warn(`limpeza falhou: ${e.message}`);
    }
    info('o Pix pendente no Mercado Pago não é cobrado e expira sozinho');
  }
}

console.log();
if (errors.length === 0) {
  console.log(`${GREEN}=== TODAS AS CHECAGENS PASSARAM ===${RESET}`);
  process.exit(0);
} else {
  console.log(`${RED}=== ${errors.length} CHECAGEM(NS) FALHARAM ===${RESET}`);
  errors.forEach((e) => console.log(`${RED}  - ${e}${RESET}`));
  process.exit(1);
}
