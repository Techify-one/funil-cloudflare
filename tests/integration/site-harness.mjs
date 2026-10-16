// Harness dos testes do módulo site/: empacota o Worker inteiro (src/index.js)
// com esbuild e roda no Miniflare com D1 criado a partir de
// migrations/0001_init.sql, assets reais de public/ e chamadas externas
// (CAPI da Meta) capturadas em memória.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response as MfResponse } from 'miniflare';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const ORIGIN = 'https://site.example.com';
export const BROWSER_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36';
export const OFFER_PIXEL = '111';
export const ENV_PIXEL = '999';

// Caminho da Conversions API: /<versão>/<pixel>/events.
export const CAPI_PATH_RE = /^\/v\d+\.\d+\/\d+\/events$/;
export const isCapiCall = (call) => CAPI_PATH_RE.test(new URL(call.url).pathname);

// checkout/ e dashboard/ são editados em paralelo por outras frentes. Se algum
// não compilar no momento do teste, vira um stub mínimo para não bloquear o site.
function moduleStub(name, relPath) {
  const filter = new RegExp('(^|/)' + relPath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '$');
  return {
    name: `${name}-stub`,
    setup(b) {
      b.onResolve({ filter }, () => ({ path: name, namespace: `${name}-stub` }));
      b.onLoad({ filter: /.*/, namespace: `${name}-stub` }, () => ({
        contents: 'export default { async fetch() { return new Response("stub", { status: 501 }); } };',
        loader: 'js',
      }));
    },
  };
}

export const stubbedModules = [];

export async function bundleWorker() {
  const options = {
    entryPoints: [join(ROOT, 'src/index.js')],
    bundle: true, write: false, format: 'esm', loader: { '.html': 'text' }, logLevel: 'silent',
  };
  try {
    return (await build(options)).outputFiles[0].text;
  } catch {
    stubbedModules.push('checkout/src/index.js', 'dashboard/src/worker.js');
    const out = await build({
      ...options,
      plugins: [moduleStub('checkout', 'checkout/src/index.js'), moduleStub('dashboard', 'dashboard/src/worker.js')],
    });
    return out.outputFiles[0].text;
  }
}

export function schemaStatements() {
  const sql = readFileSync(join(ROOT, 'migrations/0001_init.sql'), 'utf8')
    .split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
  return sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}

// Sobe o Worker. `port: 0` expõe um servidor HTTP local (usado pelo teste de UI).
export async function startSite({ bindings = {}, http = false } = {}) {
  const outbound = [];
  const script = await bundleWorker();
  const mf = new Miniflare({
    modules: true, script, compatibilityDate: '2025-04-01', cf: false,
    ...(http ? { port: 0, host: '127.0.0.1' } : {}),
    d1Databases: ['DB'],
    bindings: {
      META_PIXEL_ID: ENV_PIXEL,
      META_PIXEL_ACCESS_TOKEN: 'env-token',
      DEFAULT_PAGE: 'exemplo',
      ...bindings,
    },
    assets: {
      directory: join(ROOT, 'public'), binding: 'ASSETS',
      routerConfig: { invoke_user_worker_ahead_of_assets: true, has_user_worker: true },
      assetConfig: { html_handling: 'none', not_found_handling: 'none' },
    },
    outboundService: async (request) => {
      outbound.push({ url: request.url, method: request.method, body: await request.text() });
      if (CAPI_PATH_RE.test(new URL(request.url).pathname)) {
        return new MfResponse(JSON.stringify({ events_received: 1, fbtrace_id: 'trace' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new MfResponse('blocked in test', { status: 599 });
    },
  });
  const baseUrl = http ? await mf.ready : null;
  const db = await mf.getD1Database('DB');
  for (const statement of schemaStatements()) await db.prepare(statement).run();
  await db.prepare(
    "INSERT INTO offers (code, name, sale_price_cents, anchor_price_cents, is_active, meta_pixel_id, meta_capi_token) VALUES ('produto-exemplo', 'Produto Exemplo', 9700, 19700, 1, ?, 'offer-token')"
  ).bind(OFFER_PIXEL).run();
  return { mf, db, outbound, baseUrl };
}

export function rows(db, sql, ...params) {
  return db.prepare(sql).bind(...params).all().then((r) => r.results);
}

// Espera as gravações feitas em ctx.waitUntil (o Miniflare responde antes delas).
export async function waitFor(fn, { timeout = 3000, interval = 25 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeout) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

