// Sobe o funil inteiro localmente (wrangler dev + D1 local), sem tocar na
// Cloudflare. Aplica o schema e os dados de exemplo no banco local.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, parseEnvFile, resolveConfig, step, ok, fail } from './lib/env.mjs';
import { renderWranglerToml } from './lib/render.mjs';

const envPath = resolve(ROOT, '.env');
const raw = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {};
const cfg = resolveConfig({ APP_HOSTNAME: 'localhost.dev', ...raw });
cfg.D1_ID = cfg.D1_ID || '00000000-0000-0000-0000-000000000000';
const port = process.env.PORT || '8787';

step('Gerando wrangler.toml local');
renderWranglerToml(cfg);
ok('ok');

// Segredos locais ficam em .dev.vars (ignorado pelo git).
const devVars = {
  DASH_USER: cfg.DASH_USER,
  DASH_PASS: cfg.DASH_PASS || 'dev',
  MP_ACCESS_TOKEN: cfg.MP_ACCESS_TOKEN || '',
  META_PIXEL_ACCESS_TOKEN: cfg.META_PIXEL_ACCESS_TOKEN || '',
  META_ACCESS_TOKEN: cfg.META_ACCESS_TOKEN || '',
  DEBUG_APPROVE_TOKEN: cfg.DEBUG_APPROVE_TOKEN || 'dev',
};
writeFileSync(resolve(ROOT, '.dev.vars'), Object.entries(devVars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');

const run = (args, input) => spawnSync('npx', ['--no-install', 'wrangler', ...args], { cwd: ROOT, stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit', input, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });

step('Banco local');
if (run(['d1', 'migrations', 'apply', cfg.D1_NAME, '--local'], 'y\n').status !== 0) fail('Falha nas migrations locais.');
writeFileSync(resolve(ROOT, '.wrangler-seed.sql'), readFileSync(resolve(ROOT, 'seed/base.sql.tmpl'), 'utf8').replaceAll('{{PUBLIC_URL}}', `http://localhost:${port}`));
run(['d1', 'execute', cfg.D1_NAME, '--local', '--file', '.wrangler-seed.sql']);
run(['d1', 'execute', cfg.D1_NAME, '--local', '--file', 'seed/demo.sql']);
ok('schema e exemplos aplicados');

step(`Abrindo http://localhost:${port}  (painel: ${cfg.DASH_USER} / ${cfg.DASH_PASS ? 'senha do .env' : 'dev'})`);
run(['dev', '--local', '--port', port]);
