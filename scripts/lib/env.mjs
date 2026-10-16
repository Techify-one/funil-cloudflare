// Leitura do .env sem nunca imprimir valores.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ROOT = resolve(new URL('../..', import.meta.url).pathname);
export const ENV_PATH = resolve(ROOT, '.env');

export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadEnv() {
  if (!existsSync(ENV_PATH)) {
    fail(`Arquivo .env não encontrado em ${ENV_PATH}.\nCopie o modelo: cp .env.example .env`);
  }
  return parseEnvFile(readFileSync(ENV_PATH, 'utf8'));
}

// Valores derivados com padrões. Nada aqui é impresso.
export function resolveConfig(env) {
  const hostname = (env.APP_HOSTNAME || '').trim().toLowerCase();
  const base = hostname.split('.')[0] || 'funil';
  return {
    ...env,
    APP_HOSTNAME: hostname,
    WORKER_NAME: env.WORKER_NAME || base,
    D1_NAME: env.D1_NAME || `${base}-db`,
    BRAND_NAME: env.BRAND_NAME || 'Minha Empresa',
    STATEMENT_DESCRIPTOR: env.STATEMENT_DESCRIPTOR || '',
    GUARANTEE_DAYS: env.GUARANTEE_DAYS || '30',
    DEFAULT_PAGE: env.DEFAULT_PAGE || 'exemplo',
    DASH_USER: env.DASH_USER || 'admin',
  };
}

export function isSet(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

export function step(message) {
  console.log(`\n▸ ${message}`);
}

export function ok(message) {
  console.log(`  ✓ ${message}`);
}

export function warn(message) {
  console.log(`  ! ${message}`);
}
