// Testes + deploy. Use depois do primeiro `npm run setup`.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, loadEnv, resolveConfig, isSet, fail, step, ok, warn } from './lib/env.mjs';
import { wrangler } from './lib/cf.mjs';
import { renderWranglerToml } from './lib/render.mjs';

const cfg = resolveConfig(loadEnv());
const instancePath = resolve(ROOT, '.instance.json');
if (!existsSync(instancePath)) fail('Rode `npm run setup` antes do primeiro deploy.');
const instance = JSON.parse((await import('node:fs')).readFileSync(instancePath, 'utf8'));
cfg.D1_ID = instance.d1_id;

step('Gerando wrangler.toml');
renderWranglerToml(cfg);
ok('ok');

step('Testes');
if (spawnSync('npm', ['test', '--silent'], { cwd: ROOT, stdio: 'inherit' }).status !== 0) fail('Testes falharam; deploy cancelado.');
ok('testes passaram');

step('Migrations pendentes');
const mig = wrangler(['d1', 'migrations', 'apply', cfg.D1_NAME, '--remote'], { env: cfg, input: 'y\n', capture: true });
if (mig.code !== 0) fail(`Falha nas migrations:\n${mig.stderr || mig.stdout}`);
ok('banco atualizado');

step('Deploy');
if (wrangler(['deploy'], { env: cfg }).code !== 0) fail('Falha no deploy.');
ok(`https://${cfg.APP_HOSTNAME}`);
if (isSet(cfg.META_TEST_EVENT_CODE)) {
  warn('META_TEST_EVENT_CODE está preenchido: as compras reais vão para "Eventos de teste" da Meta. Apague do .env e rode o deploy de novo quando terminar de testar.');
}
