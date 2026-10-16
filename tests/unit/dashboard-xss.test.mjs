// Regressão de XSS nas telas do dashboard: valores vindos do banco ou da API
// da Meta (nomes de funil, rótulos de etapa, nomes de campanha, links do
// painel, mensagens de erro) só entram em innerHTML depois de escapados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const PAGES = ['leads', 'vendas', 'funil', 'meta', 'offers', 'painel', 'secoes', 'checkout-analytics'];
const read = (name) => readFile(new URL(`../../dashboard/src/${name}.html`, import.meta.url), 'utf8');

// Campos que vêm do banco/API e não podem ir crus para o HTML.
const SENSITIVE = [
  'name', 'slug', 'label', 'email', 'phone', 'description', 'url', 'message', 'code', 'title', 'detail',
  'error', 'destination', 'value', 'cta', 'section', 'last_section', 'product', 'product_label',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_page', 'funnel',
];
const RAW_FIELD = new RegExp(String.raw`\$\{\s*[A-Za-z_$][\w$]*(?:\??\.[\w$]+)*\??\.(?:${SENSITIVE.join('|')})\s*\}`, 'g');

// Trechos de template literal que montam HTML (contêm uma tag).
function htmlTemplates(source) {
  const out = [];
  const re = /`(?:\\[\s\S]|\$\{(?:[^{}]|\{[^{}]*\})*\}|[^`\\])*`/g;
  let m;
  while ((m = re.exec(source))) {
    if (/<[a-z]/i.test(m[0])) out.push({ text: m[0], line: source.slice(0, m.index).split('\n').length });
  }
  return out;
}

test('funil.html escapa nome/slug do funil e rótulos das etapas', async () => {
  const html = await read('funil');
  for (const raw of ['${f.slug}', '${f.name}', '${s.label}', '${SHORT_LABELS[s.key] || s.label}']) {
    assert.equal(html.includes(raw), false, `${raw} ainda é interpolado sem escape`);
  }
  assert.match(html, /<option value="\$\{escapeAttr\(f\.slug\)\}">\$\{escapeHtml\(f\.name\)\}/);
  assert.match(html, /<span class="lbl">\$\{escapeHtml\(s\.label\)\}<\/span>/);
  assert.match(html, /\$\{escapeHtml\(SHORT_LABELS\[s\.key\] \|\| s\.label\)\}/);
  assert.match(html, /el\.innerHTML = loading \? `<span class="spinner"><\/span> \$\{escapeHtml\(msg\)\}` : escapeHtml\(msg\);/);
});

test('meta.html escapa a mensagem de status (nomes de campanha, conjunto e anúncio)', async () => {
  const html = await read('meta');
  assert.match(html, /statusEl\.innerHTML = spinner \+ escapeHtml\(msg\);/);
  assert.doesNotMatch(html, /statusEl\.innerHTML = spinner \+ msg;/);
  // Os nomes chegam ao setStatus em texto; quem escapa é o próprio setStatus.
  assert.match(html, /setStatus\(`[^`]*"\$\{camp\.name\}"/);
  assert.equal(html.includes('innerHTML = `${camp.name}'), false);
});

test('nenhuma tela interpola campo do banco cru dentro de HTML', async () => {
  for (const page of PAGES) {
    const html = await read(page);
    for (const { text, line } of htmlTemplates(html)) {
      const hits = text.match(RAW_FIELD) || [];
      assert.deepEqual(hits, [], `${page}.html:${line} interpola sem escape: ${hits.join(', ')}`);
    }
  }
});

test('setStatus de todas as telas escapa a mensagem', async () => {
  for (const page of ['leads', 'vendas', 'funil']) {
    const html = await read(page);
    assert.doesNotMatch(html, /el\.innerHTML = loading \? `<span class="spinner"><\/span> \$\{msg\}` : msg;/, page);
    assert.match(html, /escapeHtml\(msg\)/, page);
  }
});

test('checkout-analytics.html escapa rótulos e mensagens de erro', async () => {
  const html = await read('checkout-analytics');
  assert.match(html, /\$\{esc\(labelMap\[r\.outcome\|\|r\.last_stage\]\|\|r\.outcome\|\|r\.last_stage\)\}/);
  assert.match(html, /'<div class="card error">'\+esc\(e\.message\)\+'<\/div>'/);
});

test('painel.html só gera href http(s) ou relativo', async () => {
  const html = await read('painel');
  const src = html.match(/function safeHref\(raw\) \{[\s\S]*?\n {4}\}/);
  assert.ok(src, 'safeHref não encontrado');
  const safeHref = new Function(`${src[0]}; return safeHref;`)();
  assert.equal(safeHref('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeHref('http://example.com'), 'http://example.com');
  assert.equal(safeHref('/obrigado'), '/obrigado');
  for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example', 'mailto:a@b.c', '', null]) {
    assert.equal(safeHref(bad), '#', String(bad));
  }
  assert.match(html, /<a href="\$\{escapeHtml\(href\)\}" target="_blank" rel="noopener" class="url/);
  assert.doesNotMatch(html, /href="\$\{escapeHtml\(url\)\}"/);
});

test('offers.html nunca lê nem reenvia o token da CAPI', async () => {
  const html = await read('offers');
  assert.doesNotMatch(html, /r\.meta_capi_token\b(?!_set)/);
  assert.match(html, /r\.meta_capi_token_set/);
  assert.match(html, /Token configurado \(deixe em branco para manter\)/);
  assert.match(html, /Remover token/);
  assert.match(html, /payload\.meta_capi_token = "";/);
});
