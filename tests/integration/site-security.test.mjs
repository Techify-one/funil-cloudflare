// Endurecimento do módulo site/ rodando o Worker inteiro (roteador + site) no
// Miniflare: relay da CAPI com custom_data montado no servidor, /api/lead
// contra robôs/honeypot/corpo grande e página com nome de oferta contendo $.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_UA, ORIGIN, isCapiCall, rows, startSite, stubbedModules, waitFor,
} from './site-harness.mjs';

function headers(extra = {}) {
  return { 'user-agent': BROWSER_UA, 'cf-connecting-ip': '203.0.113.9', ...extra };
}

function postJson(mf, path, body, extra = {}) {
  return mf.dispatchFetch(ORIGIN + path, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json', ...extra }),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('módulo site: endurecimento', async (t) => {
  const { mf, db, outbound } = await startSite({ bindings: { META_TEST_EVENT_CODE: 'TESTE-INSTANCIA' } });
  t.after(() => mf.dispose());
  if (stubbedModules.length) t.diagnostic('stub em: ' + stubbedModules.join(', '));

  await t.test('/api/meta-event força valor da oferta, BRL e descarta chaves e test_event_code do cliente', async () => {
    outbound.length = 0;
    const res = await postJson(mf, '/api/meta-event', {
      event_name: 'InitiateCheckout', event_id: 'ic-seg-1', source: 'exemplo', offer_code: 'produto-exemplo',
      custom_data: {
        value: 9999, currency: 'USD', content_name: 'Produto Exemplo', content_category: 'hero',
        content_type: 'product', predicted_ltv: 99999, order_id: 'x',
      },
      test_event_code: 'TESTE-CLIENTE',
    });
    assert.equal(res.status, 204);
    const call = await waitFor(() => outbound.find(isCapiCall));
    assert.ok(call, 'evento enviado para a CAPI');
    const sent = JSON.parse(call.body);
    assert.equal(sent.test_event_code, 'TESTE-INSTANCIA', 'só o código de teste da instância vale');
    assert.deepEqual(sent.data[0].custom_data, {
      content_name: 'Produto Exemplo', content_category: 'hero', content_type: 'product', value: 97, currency: 'BRL',
    });
  });

  await t.test('/api/meta-event sem offer_code usa o preço da oferta da página registrada', async () => {
    outbound.length = 0;
    await postJson(mf, '/api/meta-event', {
      event_name: 'ViewContent', event_id: 'vc-seg-1', source: 'exemplo',
      custom_data: { value: 1, content_name: 'Produto Exemplo' },
    });
    const call = await waitFor(() => outbound.find(isCapiCall));
    assert.deepEqual(JSON.parse(call.body).data[0].custom_data, { content_name: 'Produto Exemplo', value: 97, currency: 'BRL' });
  });

  await t.test('/api/lead descarta robôs com 204, honeypot e corpo acima de 8 KB', async () => {
    await db.exec('DELETE FROM leads');
    const lead = { name: 'Maria', email: 'maria@example.com', phone: '11987654321' };

    const bot = await postJson(mf, '/api/lead', lead, { 'user-agent': 'curl/8.0' });
    assert.equal(bot.status, 204);
    await bot.text();

    const honeypot = await postJson(mf, '/api/lead', { ...lead, website: 'https://spam.example' });
    assert.equal(honeypot.status, 200);
    assert.deepEqual(await honeypot.json(), { ok: true });

    const big = await postJson(mf, '/api/lead', { ...lead, filler: 'x'.repeat(9000) });
    assert.equal(big.status, 413);
    assert.deepEqual(await big.json(), { ok: false, error: 'payload_too_large' });

    assert.equal((await rows(db, 'SELECT id FROM leads')).length, 0);

    const real = await postJson(mf, '/api/lead', { ...lead, website: '' });
    assert.equal(real.status, 200);
    const body = await real.json();
    assert.equal(body.ok, true);
    assert.equal((await rows(db, 'SELECT id FROM leads')).length, 1);
  });

  await t.test("página com nome de oferta contendo $' $` $& continua íntegra", async () => {
    const name = "Oferta $' $` $& $$ Fim";
    await db.prepare("UPDATE offers SET name = ? WHERE code = 'produto-exemplo'").bind(name).run();
    const res = await mf.dispatchFetch(ORIGIN + '/exemplo', { headers: headers() });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.equal(html.match(/<\/head>/g).length, 1);
    assert.equal(html.match(/<\/body>/g).length, 1);
    assert.equal(html.match(/<html/g).length, 1);
    assert.equal(html.match(/window\.__LP=/g).length, 1);
    assert.equal(html.match(/lp-tracking\.js/g).length, 1);
    const cfg = JSON.parse(html.match(/window\.__LP=(\{.*?\});<\/script>/)[1]);
    assert.equal(cfg.content, name);
    await db.prepare("UPDATE offers SET name = 'Produto Exemplo' WHERE code = 'produto-exemplo'").run();
  });
});
