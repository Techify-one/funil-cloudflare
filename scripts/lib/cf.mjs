// Chamadas à API da Cloudflare e ao Wrangler. O token só trafega em
// cabeçalhos e variáveis de ambiente de processos filhos, nunca em argumentos
// de linha de comando nem no console.
import { spawnSync } from 'node:child_process';
import { ROOT } from './env.mjs';

const API = 'https://api.cloudflare.com/client/v4';

export async function cfApi(token, path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* resposta sem JSON */ }
  return { status: res.status, ok: res.ok && data && data.success !== false, data };
}

export function cfErrors(result) {
  const errors = (result.data && result.data.errors) || [];
  if (!errors.length) return `HTTP ${result.status}`;
  return errors.map((e) => `${e.code}: ${e.message}`).join('; ');
}

// Roda o Wrangler do projeto. `input` vai pelo stdin (usado para segredos).
export function wrangler(args, { env, input, capture = false } = {}) {
  const result = spawnSync('npx', ['--no-install', 'wrangler', ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
      WRANGLER_SEND_METRICS: 'false',
    },
    input,
    encoding: 'utf8',
    stdio: capture || input !== undefined ? ['pipe', 'pipe', 'pipe'] : 'inherit',
  });
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}
