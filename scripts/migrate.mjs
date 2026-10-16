// Aplica migrations pendentes no D1 remoto (ou local com --local).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, loadEnv, resolveConfig, fail } from './lib/env.mjs';
import { wrangler } from './lib/cf.mjs';
import { renderWranglerToml } from './lib/render.mjs';

const local = process.argv.includes('--local');
const cfg = resolveConfig(loadEnv());
const instancePath = resolve(ROOT, '.instance.json');
cfg.D1_ID = existsSync(instancePath) ? JSON.parse(readFileSync(instancePath, 'utf8')).d1_id : '00000000-0000-0000-0000-000000000000';
renderWranglerToml(cfg);
const res = wrangler(['d1', 'migrations', 'apply', cfg.D1_NAME, local ? '--local' : '--remote'], { env: cfg, input: 'y\n' });
if (res.code !== 0) fail('Falha ao aplicar migrations.');
