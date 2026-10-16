---
name: nova-pagina
description: Cria uma página de venda completa neste projeto (HTML a partir do modelo, registro em site/pages.config.mjs, oferta, funil com etapas, link no /painel, deploy e smoke test). Também cria variantes para teste A/B. Use quando o usuário pedir "criar nova página", "nova LP", "nova landing page", "subir página de venda", "criar funil novo", "nova oferta com checkout" ou invocar /nova-pagina.
---

# Nova página de venda (página + oferta + funil + painel + deploy)

Receita ponta a ponta para colocar uma página de venda no ar neste repositório. O visual e o texto são livres, mas os ganchos de rastreamento descritos abaixo são **obrigatórios**: sem eles o `/funil`, o `/secoes` e o `/meta` param de funcionar para essa página.

Todos os caminhos são relativos à raiz do repositório. Rode os comandos a partir dela.

## Regra de ouro: um slug, o mesmo em todo lugar

Escolha **um** slug (kebab-case, `^[a-z0-9-]{1,40}$`, ex.: `curso-pro`) e use o mesmo valor em:

| Onde | Campo |
|---|---|
| Pasta do HTML | `public/pages/<slug>/v1.html` |
| Registro da página | chave em `site/pages.config.mjs` (vira a rota `/<slug>`) |
| Funil da página | `funnel: '<slug>'` no registro e `funnels.slug` no banco |
| Oferta | `offer: '<slug>'` no registro e `offers.code` (vira `/checkout/<slug>`) |
| 1ª etapa do funil | `match_value` da etapa `page_view` = `<slug>` |
| Painel | URL `https://$APP_HOSTNAME/<slug>` |

Slugs diferentes entre esses lugares quebram o rastreamento em silêncio. Só use oferta ou funil com outro slug quando o usuário pedir explicitamente para **reaproveitar** uma oferta ou um funil que já existem.

O slug não pode colidir com rotas do sistema (`/checkout`, `/dashboard`, `/leads`, `/vendas`, `/funil`, `/meta`, `/painel`, `/ofertas`, `/secoes`, `/obrigado`, `/api/*`, `/static/*`, `/internal`). Veja `src/routes.mjs`.

## Regra: funil antes de campanha

Nenhuma campanha da Meta deve apontar para uma página sem funil cadastrado. Esta skill cria o funil **antes** de qualquer tráfego. Campanhas diferentes que mandam tráfego para a mesma página, com as mesmas etapas, **reutilizam o mesmo funil**: a diferença entre elas é feita por `utm_campaign`, nunca criando funil novo.

## Segurança (credenciais)

- Carregue o `.env` só assim: `set -a; . ./.env; set +a`. Isso não imprime nada.
- **Nunca** rode `cat .env`, `echo $DASH_PASS`, `printenv`, `env | grep`, nem `curl -v` com autenticação.
- Sempre passe credenciais por expansão de variável entre aspas (`-u "$DASH_USER:$DASH_PASS"`), nunca com o valor literal.
- Não cole tokens ou senhas no chat. Se o usuário colar um, peça para revogar/trocar e não repita o valor.

## Passo 0: coletar os dados (perguntar antes de criar qualquer coisa)

Pergunte ao usuário (ou extraia do contexto) e confirme num resumo curto:

1. **Slug** da página (ver regra acima).
2. **Oferta**: nome exibido, descrição curta, preço de venda e preço âncora (em reais). Pergunte se já existe uma oferta para reaproveitar (`GET /dashboard/api/offers`).
3. **Copy**: headline, subheadline, dores, benefícios, como funciona, prova, itens da oferta, garantia, FAQ. Se o usuário só descreveu o produto, escreva a copy (as skills `direct-response-copy` e `frontend-design`, se disponíveis, ajudam).
4. **Opcionais** da oferta: página de obrigado própria (`thanks_url`, padrão `/obrigado`), e-mail de confirmação (`email_enabled`, `email_subject`, `email_body` com `{{nome}}` e `{{produto}}`, `email_access_url`), Pixel próprio da oferta (`meta_pixel_id`).

Não invente preço, garantia ou promessa: pergunte.

## Passo 1: criar o HTML a partir do modelo

```bash
mkdir -p public/pages/<slug>
cp public/pages/_template/index.html public/pages/<slug>/v1.html
```

Edite `public/pages/<slug>/v1.html` trocando os textos entre `[colchetes]`. Contrato que **não pode** ser quebrado:

- **`data-section="<id>"`** em cada bloco macro (hero, problema, solucao, beneficios, como-funciona, prova, oferta, garantia, faq, cta-final, rodape...). Kebab-case, `^[a-z0-9_-]{1,60}$`, estável: cada id vira uma linha do relatório `/secoes`. Pode adicionar ou remover blocos, mas não renomeie ids de uma página que já recebeu tráfego.
- **Todo botão de compra** é `<a href="#checkout" data-cta="<id>">` (ids `^[a-z0-9_-]{1,30}$`, ex.: `hero`, `oferta`, `final`, `sticky`). O id vai para o checkout como `utm_content_cta` e aparece no ranking de CTAs do `/secoes`.
- **Não cole** Pixel, `fbq(...)`, `window.__LP` nem scripts de rastreamento no HTML. O worker do site injeta no `<head>` o Pixel (`init` + `PageView`) e `window.__LP`, e antes do `</body>` o `/static/lp-tracking.js`. Esse script dispara `ViewContent` e `InitiateCheckout` (navegador + CAPI com o mesmo `eventID`) e leva o clique para `/checkout/<oferta>` repassando **todos** os parâmetros da URL (utm_*, `fbclid`, `meta_*_id`) mais `funnel`, `utm_page` e `utm_content_cta`.
- Mantenha `<meta name="robots" content="noindex, nofollow">`.

### Regras de copy e design (público frio, maioria no celular)

- **Headline primeiro e em destaque**: é a primeira coisa da página, grande, com o resultado que o cliente quer. Nada de logo, menu ou nome da marca em cima dela; marca só no rodapé.
- **Mobile-first de verdade**: confira em 360 px de largura. Botões grandes, largura total, CTA visível na primeira dobra e barra fixa (`sticky`) no rodapé.
- **Escaneável**: bullets, ícones, cards, tabelas e passos numerados. Evite parágrafos longos (no máximo 2 a 3 linhas por bloco de texto).
- **Legível**: fonte sem serifa simples (o modelo usa a pilha `system-ui`), corpo de 16 a 18 px, contraste forte (texto escuro em fundo claro ou branco em fundo escuro). Nada de fonte decorativa ou serifada em headline; se o contraste ficar no limite, reforce com fundo sólido.
- **Cor combina com o produto**: troque `--accent` no `:root` do modelo pela cor da marca/produto.
- Preço, garantia e prazo precisam bater com a oferta cadastrada no banco e com os criativos.

## Passo 2: registrar a página em `site/pages.config.mjs`

Adicione uma entrada no objeto `PAGES`:

```js
'<slug>': {
  funnel: '<slug>',
  offer: '<slug>',
  variants: { 1: '/pages/<slug>/v1.html' },
  split: [1],
},
```

Campos opcionais: `content` (nome do produto nos eventos do Pixel; padrão é o nome da oferta), `value` (valor em reais nos eventos; padrão é o preço da oferta), `pixelId` (Pixel só desta página; padrão é o Pixel da oferta e depois `META_PIXEL_ID`), `source`. Sem o registro a página **não** é servida.

## Passo 3: criar a oferta (`POST /dashboard/api/offers`)

Preços em **centavos** (R$ 97,00 = `9700`). `code` aceita `^[a-z0-9-]{1,64}$` e é **imutável** depois de criado (é a URL do checkout). Pule este passo se for reaproveitar uma oferta existente.

```bash
set -a; . ./.env; set +a
curl -s -u "$DASH_USER:$DASH_PASS" -X POST "https://$APP_HOSTNAME/dashboard/api/offers" \
  -H 'content-type: application/json' \
  -d @- <<'JSON'
{
  "code": "<slug>",
  "name": "<Nome da oferta>",
  "description": "<descrição curta>",
  "anchor_price_cents": 19700,
  "sale_price_cents": 9700,
  "is_active": true,
  "out_of_stock": false,
  "thanks_url": "/obrigado",
  "email_enabled": false,
  "email_subject": "Sua compra de {{produto}} foi confirmada",
  "email_body": "Olá, {{nome}}! Recebemos o pagamento de {{produto}}.",
  "email_access_url": null,
  "meta_pixel_id": null,
  "order_bumps": []
}
JSON
```

Resposta esperada: `{"ok":true,"id":<offer_id>,"code":"<slug>"}`. `409` = já existe oferta com esse code. Order bumps opcionais: `"order_bumps":[{"name":"...","description":"...","price_cents":2700,"is_active":true}]`. Para editar depois: `PUT /dashboard/api/offers/<id>` com o objeto completo (mesmo `code`).

## Passo 4: criar o funil com as etapas (`POST /dashboard/api/funnels`)

Primeiro veja se já existe um funil com as mesmas etapas que você pode reaproveitar:

```bash
curl -s -u "$DASH_USER:$DASH_PASS" "https://$APP_HOSTNAME/dashboard/api/funnels" \
  | python3 -c "import sys,json; [print(f['id'], f['slug'], [s['match_value'] for s in f['steps']]) for f in json.load(sys.stdin)['funnels']]"
```

Se não houver, crie com as 4 etapas padrão:

```bash
curl -s -u "$DASH_USER:$DASH_PASS" -X POST "https://$APP_HOSTNAME/dashboard/api/funnels" \
  -H 'content-type: application/json' \
  -d @- <<'JSON'
{
  "slug": "<slug>",
  "name": "<Nome legível do funil>",
  "is_default": false,
  "steps": [
    { "key": "visitas_pagina",   "label": "Visitas na página",   "source": "page_view",   "match_value": "<slug>" },
    { "key": "preencheu_dados",  "label": "Preencheu dados",     "source": "lead_status", "match_value": "telefone" },
    { "key": "visitas_checkout", "label": "Visitas no checkout", "source": "page_view",   "match_value": "checkout" },
    { "key": "comprou",          "label": "Comprou",             "source": "order",       "match_value": "approved" }
  ]
}
JSON
```

Como as etapas casam com o banco (sempre filtradas pelo slug do funil):

| `source` | Coluna comparada | Observação |
|---|---|---|
| `page_view` | `page_views.page` | Páginas gravam `page='<slug>'`; o checkout grava `page='checkout'`. |
| `lead_status` | `leads.status` | Evolui `nome → email → telefone → escolheu_metodo → pix_gerado`. Para contar quem passou da etapa, use lista: `telefone,escolheu_metodo,pix_gerado,comprou`. |
| `order` | `orders.status` | `approved` = compra aprovada (fonte única de compras; conta compradores únicos). |

`match_value` aceita valor exato, lista separada por vírgula ou padrão `LIKE` com `%`. `key` aceita `^[a-z0-9_]{1,40}$`. Se a página tiver fluxo diferente (formulário próprio, etapa extra), ajuste as etapas e **revise com o usuário** antes de criar.

## Passo 5: link no `/painel` (`POST /dashboard/api/painel-links`)

```bash
curl -s -u "$DASH_USER:$DASH_PASS" -X POST "https://$APP_HOSTNAME/dashboard/api/painel-links" \
  -H 'content-type: application/json' \
  -d "{\"type\":\"public\",\"name\":\"<Nome da página>\",\"description\":\"<descrição curta>\",\"url\":\"https://$APP_HOSTNAME/<slug>\",\"position\":0}"
```

`type` é `public` (página aberta), `internal` ou `external`. `position: 0` coloca no fim da lista. `409` = já existe link com essa URL.

## Passo 6: deploy

```bash
npm run deploy
```

O deploy roda os testes, aplica migrations pendentes e publica. Não rode `npx wrangler deploy` direto.

## Passo 7: smoke test (obrigatório)

```bash
set -a; . ./.env; set +a
STAMP="smoke_$(date +%s)"
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

# 1. Página responde 200 e tem Pixel, window.__LP e o script de rastreamento
curl -s -o /dev/null -w '%{http_code}\n' -A "$UA" "https://$APP_HOSTNAME/<slug>?utm_campaign=$STAMP"
curl -s -A "$UA" "https://$APP_HOSTNAME/<slug>?utm_campaign=$STAMP" \
  | grep -oE "fbq\('init'|window\.__LP|/static/lp-tracking\.js|data-cta=\"[a-z0-9_-]+\"" | sort -u

# 2. page_view gravado com page e funnel corretos
sleep 3
npx wrangler d1 execute "$D1_NAME" --remote --json \
  --command "SELECT page, funnel, utm_page, utm_campaign FROM page_views WHERE utm_campaign='$STAMP' ORDER BY id DESC LIMIT 3"
# Esperado: page='<slug>', funnel='<slug>', utm_page='/<slug>-v1'

# 3. Oferta servida no checkout
curl -s -A "$UA" "https://$APP_HOSTNAME/checkout/<slug>?funnel=<slug>" | grep -o '"code":"<slug>"' | head -1

# 4. Funil responde no dashboard
curl -s -u "$DASH_USER:$DASH_PASS" "https://$APP_HOSTNAME/dashboard/api/funnel?funnel=<slug>&range=1d&include_internal=1" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['funnel']); [print(' ', s['label'], s['value']) for s in d['steps']]"
# Esperado: funnel.slug='<slug>' e a etapa 1 com pelo menos 1 visita

# 5. Limpeza dos dados de teste
npx wrangler d1 execute "$D1_NAME" --remote --command "DELETE FROM page_views WHERE utm_campaign='$STAMP'"
```

Notas:
- Use um user-agent de navegador: requisições com `curl/*`, `node`, `python-requests` etc. são classificadas como bot e **não** gravam `page_view`.
- Se o seu IP estiver em `blocked_ips`, as telas do dashboard escondem seus acessos; por isso o passo 4 usa `include_internal=1`.
- Qualquer item falhando = não liberar campanha. Corrija e repita.

## Variantes e teste A/B

1. Copie a v1: `cp public/pages/<slug>/v1.html public/pages/<slug>/v2.html` e mude **só** o que está sendo testado (headline, ordem dos blocos, layout). Mantenha os mesmos ids de `data-section` e `data-cta` onde os blocos forem equivalentes, para comparar no `/secoes`.
2. No registro: `variants: { 1: '/pages/<slug>/v1.html', 2: '/pages/<slug>/v2.html' }, split: [1, 2]`.
   - Repetir um número aumenta o peso: `split: [1, 1, 2]` = 2/3 do tráfego na v1.
   - O visitante fica fixo na variante por cookie (`lp_<slug>_v`, 30 dias).
   - `?v=2` na URL força a variante (preview) e também gruda no cookie.
3. A URL pública continua `/<slug>` e o funil continua o mesmo. As variantes se separam por `page_views.utm_page = '/<slug>-v<N>'` e, no `/secoes`, por `page = '<slug>-v<N>'`.
4. Para encerrar o teste, tire a perdedora do `split` (mantenha em `variants` para histórico e preview) e faça `npm run deploy`.

## Checklist final

- [ ] Mesmo slug no HTML, no registro, na oferta, no funil, na 1ª etapa e no painel.
- [ ] HTML sem Pixel/`fbq`/`window.__LP` colados à mão; `data-section` em cada bloco; todo CTA com `href="#checkout"` e `data-cta`.
- [ ] Headline no topo, mobile-first, bullets em vez de texto corrido, fonte sem serifa com contraste forte.
- [ ] Oferta criada (ou reaproveitada) com preço em centavos conferido com a copy.
- [ ] Funil criado **antes** de qualquer campanha.
- [ ] Link no `/painel`.
- [ ] `npm run deploy` concluído e smoke test passando (página 200, `page_view` com `funnel` certo, oferta no checkout, funil respondendo).
- [ ] Opcional: rodar a skill `teste-checkout` com `E2E_OFFER=<slug> E2E_FUNNEL=<slug>`.

## Ao final, entregar ao usuário

- Página: `https://$APP_HOSTNAME/<slug>` (e `?v=2` se houver variante)
- Checkout: `https://$APP_HOSTNAME/checkout/<slug>`
- Funil: `https://$APP_HOSTNAME/funil?funnel=<slug>`
- IDs criados: oferta, funil e link do painel.
- Próximo passo sugerido: skill `subir-campanha` apontando para `https://$APP_HOSTNAME/<slug>`.
