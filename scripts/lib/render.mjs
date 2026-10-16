// Gera wrangler.toml a partir de wrangler.toml.example + .env.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './env.mjs';

// Valores que vão para [vars] (públicos; aparecem no painel da Cloudflare).
const VAR_KEYS = [
  'WORKER_NAME', 'APP_HOSTNAME', 'D1_NAME', 'D1_ID', 'BRAND_NAME', 'STATEMENT_DESCRIPTOR',
  'GUARANTEE_DAYS', 'DEFAULT_PAGE', 'META_PIXEL_ID', 'META_AD_ACCOUNT_ID', 'META_AD_ACCOUNT_IDS',
  'META_TEST_EVENT_CODE', 'MP_PUBLIC_KEY', 'EMAIL_FROM', 'CLOUDFLARE_ACCOUNT_ID',
];

function tomlString(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function renderWranglerToml(cfg) {
  let text = readFileSync(resolve(ROOT, 'wrangler.toml.example'), 'utf8');
  for (const key of VAR_KEYS) {
    text = text.replaceAll(`__${key}__`, tomlString(cfg[key]));
  }
  const leftover = text.match(/__[A-Z0-9_]+__/g);
  if (leftover) throw new Error(`wrangler.toml.example tem marcadores sem valor: ${[...new Set(leftover)].join(', ')}`);
  const header = '# ARQUIVO GERADO por `npm run setup`. Edite o .env e rode o setup de novo.\n';
  writeFileSync(resolve(ROOT, 'wrangler.toml'), header + text);
}
