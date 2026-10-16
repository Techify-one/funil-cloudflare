// Setup completo na Cloudflare a partir do .env. Pode ser rodado de novo a
// qualquer momento: reaproveita o que já existe.
//
//   npm run setup                  # setup completo
//   npm run setup -- --dry-run     # só valida o .env e o token
//   npm run setup -- --demo        # também cria a oferta e o funil de exemplo
//   npm run setup -- --debug-approve  # habilita /api/mp/_debug_approve (testes E2E)
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, loadEnv, resolveConfig, isSet, fail, step, ok, warn } from './lib/env.mjs';
import { cfApi, cfErrors, wrangler } from './lib/cf.mjs';
import { renderWranglerToml } from './lib/render.mjs';

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const WITH_DEMO = args.has('--demo');
const WITH_DEBUG = args.has('--debug-approve');
const INSTANCE_PATH = resolve(ROOT, '.instance.json');

const REQUIRED = ['CLOUDFLARE_API_TOKEN', 'APP_HOSTNAME', 'MP_PUBLIC_KEY', 'MP_ACCESS_TOKEN', 'META_PIXEL_ID', 'META_PIXEL_ACCESS_TOKEN'];

// Segredos enviados com `wrangler secret bulk` (nunca vão para o wrangler.toml).
const SECRETS = [
  'DASH_PASS', 'DASH_USER', 'MP_ACCESS_TOKEN', 'META_PIXEL_ACCESS_TOKEN',
  'META_ACCESS_TOKEN', 'CLOUDFLARE_EMAIL_API_TOKEN', 'DEBUG_APPROVE_TOKEN',
];

function readInstance() {
  if (!existsSync(INSTANCE_PATH)) return {};
  try { return JSON.parse(readFileSync(INSTANCE_PATH, 'utf8')); } catch { return {}; }
}

function appendToEnv(key, value) {
  const path = resolve(ROOT, '.env');
  const text = readFileSync(path, 'utf8');
  const re = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  writeFileSync(path, re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, '\n')}${line}\n`);
}

async function main() {
  console.log('Setup do funil na Cloudflare');
  const cfg = resolveConfig(loadEnv());

  step('Conferindo o .env');
  const missing = REQUIRED.filter((k) => !isSet(cfg[k]));
  if (missing.length) fail(`Preencha no .env: ${missing.join(', ')}`);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(cfg.APP_HOSTNAME)) fail('APP_HOSTNAME inválido. Use só o domínio, ex.: vendas.seudominio.com.br');
  ok('variáveis obrigatórias presentes');

  step('Validando o token da Cloudflare');
  const verify = await cfApi(cfg.CLOUDFLARE_API_TOKEN, '/user/tokens/verify');
  if (!verify.ok) fail(`Token inválido ou expirado (${cfErrors(verify)}). Crie outro pelo link do CLAUDE.md.`);
  ok('token ativo');

  if (!isSet(cfg.CLOUDFLARE_ACCOUNT_ID)) {
    const accounts = await cfApi(cfg.CLOUDFLARE_API_TOKEN, '/accounts?per_page=50');
    const list = (accounts.data && accounts.data.result) || [];
    if (list.length !== 1) fail(`O token enxerga ${list.length} contas. Defina CLOUDFLARE_ACCOUNT_ID no .env.`);
    cfg.CLOUDFLARE_ACCOUNT_ID = list[0].id;
    appendToEnv('CLOUDFLARE_ACCOUNT_ID', cfg.CLOUDFLARE_ACCOUNT_ID);
    ok('conta detectada e salva no .env');
  }

  step('Localizando o domínio');
  const labels = cfg.APP_HOSTNAME.split('.');
  let zone = null;
  for (let i = 0; i < labels.length - 1 && !zone; i += 1) {
    const name = labels.slice(i).join('.');
    const res = await cfApi(cfg.CLOUDFLARE_API_TOKEN, `/zones?name=${encodeURIComponent(name)}&account.id=${cfg.CLOUDFLARE_ACCOUNT_ID}`);
    if (!res.ok) fail(`Sem permissão para ler zonas (${cfErrors(res)}). O token precisa de Zone: Read.`);
    zone = (res.data.result || [])[0] || null;
  }
  if (!zone) fail(`O domínio de ${cfg.APP_HOSTNAME} não está nesta conta da Cloudflare. Adicione o domínio na Cloudflare primeiro.`);
  if (zone.status !== 'active') warn(`a zona ${zone.name} está com status "${zone.status}"; o site só responde quando ela estiver ativa`);
  ok(`zona ${zone.name}`);

  step('Conferindo permissões de Workers e D1');
  const scripts = await cfApi(cfg.CLOUDFLARE_API_TOKEN, `/accounts/${cfg.CLOUDFLARE_ACCOUNT_ID}/workers/scripts`);
  if (!scripts.ok) fail(`O token não tem Workers Scripts: Edit (${cfErrors(scripts)}).`);
  const d1List = await cfApi(cfg.CLOUDFLARE_API_TOKEN, `/accounts/${cfg.CLOUDFLARE_ACCOUNT_ID}/d1/database?per_page=100`);
  if (!d1List.ok) fail(`O token não tem D1: Edit (${cfErrors(d1List)}).`);
  ok('permissões ok');

  const instance = readInstance();
  const workerExists = (scripts.data.result || []).some((s) => s.id === cfg.WORKER_NAME);
  if (workerExists && instance.worker_name !== cfg.WORKER_NAME && !args.has('--force')) {
    fail(`Já existe um Worker chamado "${cfg.WORKER_NAME}" que não foi criado por este setup. Defina outro WORKER_NAME no .env ou rode com --force se ele for seu.`);
  }

  if (DRY_RUN) {
    console.log('\nTudo certo (modo --dry-run, nada foi criado).');
    return;
  }

  step('Banco de dados D1');
  let db = (d1List.data.result || []).find((d) => d.name === cfg.D1_NAME);
  if (db && instance.d1_id !== db.uuid && !args.has('--adopt')) {
    fail(`Já existe um D1 chamado "${cfg.D1_NAME}" que não foi criado por este setup. Defina outro D1_NAME ou rode com --adopt se ele for deste projeto.`);
  }
  if (!db) {
    const created = await cfApi(cfg.CLOUDFLARE_API_TOKEN, `/accounts/${cfg.CLOUDFLARE_ACCOUNT_ID}/d1/database`, {
      method: 'POST', body: { name: cfg.D1_NAME },
    });
    if (!created.ok) fail(`Não consegui criar o D1 (${cfErrors(created)}).`);
    db = created.data.result;
    ok(`D1 "${cfg.D1_NAME}" criado`);
  } else {
    ok(`D1 "${cfg.D1_NAME}" já existe`);
  }
  cfg.D1_ID = db.uuid;
  writeFileSync(INSTANCE_PATH, JSON.stringify({ ...instance, worker_name: cfg.WORKER_NAME, d1_name: cfg.D1_NAME, d1_id: cfg.D1_ID, hostname: cfg.APP_HOSTNAME }, null, 2) + '\n');

  step('Gerando wrangler.toml');
  renderWranglerToml(cfg);
  ok('wrangler.toml gerado (fora do git)');

  step('Aplicando o schema do banco');
  const mig = wrangler(['d1', 'migrations', 'apply', cfg.D1_NAME, '--remote'], { env: cfg, input: 'y\n', capture: true });
  if (mig.code !== 0) fail(`Falha ao aplicar migrations:\n${mig.stderr || mig.stdout}`);
  ok('migrations aplicadas');

  const publicUrl = `https://${cfg.APP_HOSTNAME}`;
  const baseSeed = readFileSync(resolve(ROOT, 'seed/base.sql.tmpl'), 'utf8').replaceAll('{{PUBLIC_URL}}', publicUrl);
  writeFileSync(resolve(ROOT, '.wrangler-seed.sql'), baseSeed);
  const seed = wrangler(['d1', 'execute', cfg.D1_NAME, '--remote', '--yes', '--file', '.wrangler-seed.sql'], { env: cfg, capture: true });
  if (seed.code !== 0) fail(`Falha no seed base:\n${seed.stderr || seed.stdout}`);
  ok('menu do painel e configurações iniciais');
  if (WITH_DEMO) {
    const demo = wrangler(['d1', 'execute', cfg.D1_NAME, '--remote', '--yes', '--file', 'seed/demo.sql'], { env: cfg, capture: true });
    if (demo.code !== 0) fail(`Falha no seed de exemplo:\n${demo.stderr || demo.stdout}`);
    ok('oferta "produto-exemplo" e funil "exemplo" criados');
  }

  step('Senha do dashboard e tokens internos');
  if (!isSet(cfg.DASH_PASS)) {
    cfg.DASH_PASS = randomBytes(18).toString('base64url');
    appendToEnv('DASH_PASS', cfg.DASH_PASS);
    ok('DASH_PASS gerada e salva no .env (veja lá; não será mostrada aqui)');
  } else if (cfg.DASH_PASS.length < 16) {
    fail('DASH_PASS precisa ter pelo menos 16 caracteres. Deixe vazio no .env para o setup gerar uma senha forte.');
  }
  if (WITH_DEBUG && !isSet(cfg.DEBUG_APPROVE_TOKEN)) {
    cfg.DEBUG_APPROVE_TOKEN = randomBytes(24).toString('hex');
    appendToEnv('DEBUG_APPROVE_TOKEN', cfg.DEBUG_APPROVE_TOKEN);
    ok('DEBUG_APPROVE_TOKEN gerado e salvo no .env');
  }

  step('Testes automatizados');
  const tests = wrangler(['--version'], { env: cfg, capture: true });
  if (tests.code !== 0) fail('Wrangler não encontrado. Rode npm install.');
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync('npm', ['test', '--silent'], { cwd: ROOT, stdio: 'inherit' });
  if (run.status !== 0) fail('Os testes falharam. Corrija antes de publicar.');
  ok('testes passaram');

  step('Conferindo o endereço do site');
  const records = await cfApi(cfg.CLOUDFLARE_API_TOKEN, `/zones/${zone.id}/dns_records?name=${encodeURIComponent(cfg.APP_HOSTNAME)}`);
  const domains = await cfApi(cfg.CLOUDFLARE_API_TOKEN, `/accounts/${cfg.CLOUDFLARE_ACCOUNT_ID}/workers/domains?hostname=${encodeURIComponent(cfg.APP_HOSTNAME)}`);
  const otherWorker = ((domains.data && domains.data.result) || []).find((d) => d.hostname === cfg.APP_HOSTNAME && d.service !== cfg.WORKER_NAME);
  const dnsRecords = (records.data && records.data.result) || [];
  const isWorkerRecord = (r) => r.meta && (r.meta.read_only || r.meta.origin_worker_id);
  if (otherWorker && !args.has('--force')) {
    fail(`${cfg.APP_HOSTNAME} já está ligado ao Worker "${otherWorker.service}". Use outro APP_HOSTNAME ou rode com --force se for para substituir.`);
  }
  if (!otherWorker && dnsRecords.some((r) => !isWorkerRecord(r)) && instance.hostname !== cfg.APP_HOSTNAME && !args.has('--force')) {
    fail(`${cfg.APP_HOSTNAME} já tem registro DNS (${dnsRecords.map((r) => r.type).join(', ')}) apontando para outro lugar. Use outro APP_HOSTNAME ou rode com --force para substituir.`);
  }
  ok(`${cfg.APP_HOSTNAME} livre para este projeto`);

  step('Publicando o Worker');
  const deploy = wrangler(['deploy'], { env: cfg });
  if (deploy.code !== 0) fail('Falha no deploy.');
  ok(`publicado em ${publicUrl}`);

  step('Enviando segredos');
  const secrets = {};
  for (const key of SECRETS) {
    if (key === 'DEBUG_APPROVE_TOKEN' && !WITH_DEBUG) continue;
    if (isSet(cfg[key])) secrets[key] = cfg[key];
  }
  const bulk = wrangler(['secret', 'bulk'], { env: cfg, input: JSON.stringify(secrets) });
  if (bulk.code !== 0) fail(`Falha ao enviar segredos:\n${bulk.stderr}`);
  ok(`${Object.keys(secrets).length} segredos configurados (${Object.keys(secrets).join(', ')})`);
  if (!WITH_DEBUG) {
    const list = wrangler(['secret', 'list'], { env: cfg, capture: true });
    if (list.stdout.includes('"DEBUG_APPROVE_TOKEN"')) {
      wrangler(['secret', 'delete', 'DEBUG_APPROVE_TOKEN'], { env: cfg, input: 'y\n', capture: true });
      ok('aprovação de teste (_debug_approve) desligada');
    }
  }

  step('Teste de fumaça');
  // Segredos e certificado do domínio levam alguns segundos para propagar.
  let smoke = { status: 1 };
  for (let attempt = 1; attempt <= 6 && smoke.status !== 0; attempt += 1) {
    await new Promise((r) => setTimeout(r, attempt === 1 ? 15000 : 20000));
    smoke = spawnSync('node', ['scripts/smoke.mjs'], { cwd: ROOT, stdio: attempt === 6 ? 'inherit' : 'pipe' });
  }
  if (smoke.status !== 0) warn('o teste de fumaça falhou. O certificado do domínio pode levar alguns minutos; rode `npm run smoke` de novo.');
  else ok('site respondendo');

  if (isSet(cfg.META_TEST_EVENT_CODE)) {
    warn('META_TEST_EVENT_CODE está preenchido: TODOS os eventos do servidor (inclusive compras reais) vão para "Eventos de teste" e não contam nas campanhas. Apague essa linha do .env e rode `npm run deploy` quando terminar de testar.');
  }

  console.log(`\nPronto.\n  Site:      ${publicUrl}\n  Painel:    ${publicUrl}/painel  (usuário ${cfg.DASH_USER}, senha em DASH_PASS no .env)\n  Webhook do Mercado Pago: ${publicUrl}/api/mp/webhook\n`);
}

main().catch((err) => fail(err && err.message ? err.message : String(err)));
