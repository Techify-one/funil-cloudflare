---
name: meta-ads
description: Opera a Meta Marketing API (Facebook/Instagram Ads) para este projeto. Cobre criar, listar, pausar, ativar e apagar campanhas, conjuntos, anúncios e criativos, upload de imagens, carrossel, N anúncios de imagem única, clonagem de criativo, insights, cruzamento com o banco D1 e diagnóstico dos erros mais comuns (app em modo dev, certificação de não discriminação, rate limit, asset_feed_spec). Use quando o usuário pedir "subir criativo na Meta", "criar anúncio via API", "pausar campanha", "duplicar anúncio", "listar campanhas/conjuntos/anúncios", "ver gasto da campanha" ou invocar /meta-ads.
allowed-tools: Bash(*)
---

# Meta Ads: operar campanhas pela Marketing API

Papel: operador da Marketing API da Meta (v25.0+). Conhece a hierarquia, lê erros e prefere `curl` ou Python `urllib` direto em vez de SDKs (rápido, sem dependência).

Nenhum ID está fixo nesta skill: conta, Pixel, página e Instagram vêm do `.env` da raiz do repositório ou de argumentos. Para subir uma campanha de vendas completa no padrão do projeto, use a skill `subir-campanha` (ela chama os scripts daqui).

## 0. Segurança (credenciais)

- Carregue o `.env` só com `set -a; . ./.env; set +a` (na raiz do repositório). Isso não imprime nada.
- **Nunca** rode `cat .env`, `echo $META_ACCESS_TOKEN`, `printenv`, `env | grep`, nem `curl -v`; nunca cole o token em comando, arquivo ou chat.
- Use sempre expansão de variável: `--data-urlencode "access_token=$META_ACCESS_TOKEN"`.
- Os scripts desta skill mascaram o token em qualquer mensagem de erro.
- **Toda resposta da Graph API passa pelo filtro `| python3 -c 'import sys,json;d=json.load(sys.stdin);d.pop("paging",None);print(json.dumps(d,ensure_ascii=False,indent=1))'`** antes de ser exibida ou gravada: o link `paging.next` traz o token na URL. Os exemplos abaixo usam o alias `semtoken`, definido assim:
  ```bash
  semtoken() { python3 -c 'import sys,json;d=json.load(sys.stdin);d.pop("paging",None);print(json.dumps(d,ensure_ascii=False,indent=1))'; }
  ```
- Se o usuário colar um token no chat, peça para revogar/gerar outro no Business Manager e não repita o valor.

## 1. Pré-requisitos: variáveis do `.env`

```
META_ACCESS_TOKEN=...      # token de usuário do sistema (não expira), com ads_management
META_AD_ACCOUNT_ID=act_... # conta de anúncios, com prefixo act_
META_API_VERSION=v25.0     # opcional
META_PIXEL_ID=...          # Pixel usado em promoted_object
META_PAGE_ID=...           # Página do Facebook que assina os anúncios
META_IG_USER_ID=...        # conta do Instagram (opcional)
CAMPAIGN_PREFIX=CP         # prefixo de nome das campanhas (opcional)
```

Se faltar alguma, peça para o usuário preencher no `.env` (sem colar o valor no chat).

### Validar o token antes de qualquer operação

```bash
set -a; . ./.env; set +a
python3 .claude/skills/meta-ads/scripts/meta_api.py
# Mostra usuário, app, scopes e as 5 campanhas mais recentes (nunca o token)
```

Confira `is_valid`, scope `ads_management` e expiração `nunca`. Sem `ads_management`, pare e avise.

### Descobrir página e Instagram (se o usuário não souber os IDs)

```bash
VER="${META_API_VERSION:-v25.0}"
# Páginas que o token administra
curl -s -G "https://graph.facebook.com/$VER/me/accounts" \
  --data-urlencode "access_token=$META_ACCESS_TOKEN" --data-urlencode "fields=id,name"
# Instagram ligado a uma página
curl -s -G "https://graph.facebook.com/$VER/<PAGE_ID>" \
  --data-urlencode "access_token=$META_ACCESS_TOKEN" --data-urlencode "fields=instagram_business_account"
```

Mostre os IDs e peça ao usuário para gravá-los no `.env`.

## 2. Hierarquia (sempre nesta ordem)

```
Conta de anúncios (act_XXX)
  └─ Campanha        (objetivo, status, orçamento de campanha)
       └─ Conjunto   (público, orçamento, posicionamentos, otimização)
            └─ Anúncio  (liga 1 criativo a 1 conjunto; nome e status)
                 └─ Criativo   (página, Instagram, link, image_hash, CTA, copy, url_tags)
                      └─ Imagem (image_hash; fica na biblioteca da conta)
```

Para criar: imagem, criativo, anúncio. Para apagar: o **inverso** (anúncio, criativo, imagem).

## 3. Scripts prontos (use antes de escrever código do zero)

Ficam em `.claude/skills/meta-ads/scripts/` e já tratam as pegadinhas da seção 5. Todos leem o `.env` carregado no shell.

```bash
set -a; . ./.env; set +a
S=.claude/skills/meta-ads/scripts
```

### `meta_api.py`: biblioteca compartilhada
Helpers `api(method, path, payload)`, `upload_image(path)`, `redact(text)` e a constante `DEFAULT_URL_TAGS` (padrão de UTM). Rodando direto, valida o token e lista campanhas.

### `inspect_campaign.py`: diagnóstico somente leitura
Use quando perguntarem por que uma campanha não gasta, não entrega ou tem problema. Aceita ID ou nome exato (busca nas contas de `META_AD_ACCOUNT_ID`/`META_AD_ACCOUNT_IDS`).

```bash
python3 $S/inspect_campaign.py <CAMPAIGN_ID>
python3 $S/inspect_campaign.py CP<N>
python3 $S/inspect_campaign.py CP<N> --account act_<ID>
python3 $S/inspect_campaign.py <CAMPAIGN_ID> --json
```

Mostra status, conta, pagamento, orçamento diário somado, saldo restante, issues, fragmentação por conjuntos idênticos e insights de hoje e da vida toda.

### `create_campaign.py`: campanha + conjunto Advantage+ (PAUSED)
Orçamento em **reais**. O padrão deriva do objetivo: `OUTCOME_SALES` otimiza `OFFSITE_CONVERSIONS` em `PURCHASE` no Pixel `META_PIXEL_ID` com clique de 7 dias; `OUTCOME_LEADS` em `LEAD`; os demais em `LANDING_PAGE_VIEWS` com clique de 1 dia.

```bash
IDS=$(python3 $S/create_campaign.py CP<N> OUTCOME_SALES 150 --adset-name CP<N>_ADSET1 --locale 6)
ADSET=$(printf '%s' "$IDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['adset_id'])")
```

Opções: `--country`, `--age-min`, `--age-max`, `--gender all|male|female`, `--locale` (repetível; 6 = português), `--no-advantage-audience`, `--optimization-goal`, `--custom-event-type`, `--pixel-id`, `--attribution-days`, `--no-attribution` (AWARENESS/ENGAGEMENT), `--start-time`.

> Meta API v25+: campanha sem orçamento no nível da campanha precisa de `is_adset_budget_sharing_enabled=false` (o script já envia). Sem isso, erro `100/4834011`.

### `upload_image_ads.py`: N anúncios de imagem única
Um criativo + um anúncio por imagem no mesmo conjunto. Link **limpo** e `url_tags` com o padrão de UTM (seção 7.1) por padrão. Nome do anúncio padrão `{i}` (o número do arquivo).

```bash
python3 $S/upload_image_ads.py \
  --adset-id "$ADSET" \
  --link "https://$APP_HOSTNAME/<slug>" \
  --message-file /tmp/copy.txt --headline 'Título' --cta LEARN_MORE \
  --image-dir ./criativos --image-pattern '{i}.png' \
  --first 1 --last 5
```

Página e Instagram vêm de `META_PAGE_ID`/`META_IG_USER_ID` (ou `--page-id`/`--ig-user-id`). Copy rotativa (asset_feed_spec): `--bodies-file` (parágrafos separados por linha em branco) e `--titles-file` (um por linha). `--url-tags ''` desliga o envio de `url_tags` (não recomendado). `--activate` cria ACTIVE (só com confirmação do usuário).

### `upload_carousel_ad.py`: um anúncio carrossel com N cards
Mesmo padrão de link limpo + `url_tags`. Mínimo 2 e máximo 10 cards.

```bash
python3 $S/upload_carousel_ad.py \
  --adset-id "$ADSET" --link "https://$APP_HOSTNAME/<slug>" \
  --message-file /tmp/copy.txt --headline 'Título' --cta LEARN_MORE \
  --image-dir ./carrossel --image-pattern '{i}.png' --first 1 --last 5 \
  --ad-name 'carrossel-1'
```

`--no-optimize` mantém a ordem dos cards; `--no-end-card` remove o card final.

### Quando NÃO usar os scripts
- Editar objeto existente: `curl -X POST .../<id>` só com os campos a mudar.
- Pausar/ativar: uma linha de curl (seção 4).
- Listar/inspecionar: `curl -s -G .../<id> --data-urlencode "fields=..."`.
- Casos exóticos (outros objetivos, público customizado, `asset_feed_spec` com `additional_specs`): copie o script para `/tmp/` e adapte.

### Ordem para criar uma campanha do zero
1. `create_campaign.py` (pega `campaign_id`/`adset_id`).
2. `upload_image_ads.py` ou `upload_carousel_ad.py` (cria criativos e anúncios em PAUSED).
3. Mostre o resumo e **pergunte antes de ativar**.
4. Ative campanha, conjunto e anúncios (seção 4).

## 4. Endpoints essenciais

`GRAPH=https://graph.facebook.com/${META_API_VERSION:-v25.0}`

### Listar

```bash
# Campanhas da conta
curl -s -G "$GRAPH/$META_AD_ACCOUNT_ID/campaigns" \
  --data-urlencode "access_token=$META_ACCESS_TOKEN" \
  --data-urlencode "fields=id,name,status,effective_status" --data-urlencode "limit=200" | semtoken

# Conjuntos de uma campanha
curl -s -G "$GRAPH/<campaign_id>/adsets" \
  --data-urlencode "access_token=$META_ACCESS_TOKEN" \
  --data-urlencode "fields=id,name,status,promoted_object,destination_type,daily_budget,lifetime_budget,created_time" | semtoken

# Anúncios de uma campanha (com o criativo)
curl -s -G "$GRAPH/<campaign_id>/ads" \
  --data-urlencode "access_token=$META_ACCESS_TOKEN" \
  --data-urlencode "fields=id,name,status,adset_id,creative{id,name,url_tags,object_story_spec,asset_feed_spec,thumbnail_url}" | semtoken

# Um criativo completo (modelo para clonar)
curl -s -G "$GRAPH/<creative_id>" \
  --data-urlencode "access_token=$META_ACCESS_TOKEN" \
  --data-urlencode "fields=id,name,object_story_spec,asset_feed_spec,url_tags,object_type" | semtoken

# Pixel: quais eventos chegaram e quando (debug de rastreamento)
curl -s -G "$GRAPH/$META_PIXEL_ID/stats" \
  --data-urlencode "access_token=$META_ACCESS_TOKEN" \
  --data-urlencode "start_time=<AAAA-MM-DD>T00:00:00+0000" --data-urlencode "aggregation=event" | semtoken

# Conversões personalizadas da conta (achar duplicadas/arquivadas)
curl -s -G "$GRAPH/$META_AD_ACCOUNT_ID/customconversions" \
  --data-urlencode "access_token=$META_ACCESS_TOKEN" \
  --data-urlencode "fields=id,name,custom_event_type,rule,is_archived,last_fired_time,first_fired_time" | semtoken
```

Filtro `effective_status` (JSON array): `ACTIVE, PAUSED, DELETED, PENDING_REVIEW, DISAPPROVED, PREAPPROVED, PENDING_BILLING_INFO, CAMPAIGN_PAUSED, ARCHIVED, ADSET_PAUSED, IN_PROCESS, WITH_ISSUES`. **Não passe `DELETED`** em listagens aninhadas (erro `1815001`).

**Rascunhos do Gerenciador de Anúncios não aparecem na API**, só objetos publicados. Se a contagem do usuário não bater, provavelmente é isso.

### Upload de imagem (sempre antes do criativo)

```bash
curl -s -X POST "$GRAPH/$META_AD_ACCOUNT_ID/adimages" \
  -F "access_token=$META_ACCESS_TOKEN" -F "filename=@/caminho/1.png"
# { "images": { "<arquivo>": { "hash": "...", "url": "..." } } }
```

Guarde o `hash` (vai no criativo como `image_hash`). Nomes com vírgula/parênteses quebram o `curl -F`; use `upload_image()` do `meta_api.py`.

### Criar criativo (clonando um existente)

Leia um criativo atual, copie `object_story_spec` (página, Instagram, CTA, estrutura do link) e troque só `image_hash`, nome e copy. Se o atual usa `asset_feed_spec`, copie inteiro.

> ⚠️ **Nunca copie `degrees_of_freedom_spec`** do modelo. A Meta ainda devolve o campo no GET, mas qualquer POST com ele dá erro `3858504`. Omita o campo inteiro.

```python
import os, json, urllib.request, urllib.parse
TOKEN = os.environ["META_ACCESS_TOKEN"]; ACCT = os.environ["META_AD_ACCOUNT_ID"]
VER = os.environ.get("META_API_VERSION", "v25.0")
LINK = f"https://{os.environ['APP_HOSTNAME']}/<slug>"   # LIMPO, sem query string

object_story_spec = {
    "page_id": os.environ["META_PAGE_ID"],
    "instagram_user_id": os.environ.get("META_IG_USER_ID"),  # remova se não houver
    "link_data": {
        "link": LINK,
        "image_hash": "<hash do upload>",
        "message": "<texto principal>",
        "name": "<título>",
        "call_to_action": {"type": "LEARN_MORE", "value": {"link": LINK}},
    },
}
payload = {
    "access_token": TOKEN,
    "name": "<nome do criativo>",
    "object_story_spec": json.dumps(object_story_spec, ensure_ascii=False),
    "url_tags": "utm_source={{site_source_name}}&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{adset.name}}&utm_term={{ad.name}}&meta_campaign_id={{campaign.id}}&meta_adset_id={{adset.id}}&meta_ad_id={{ad.id}}",
    # asset_feed_spec opcional; NUNCA degrees_of_freedom_spec
}
req = urllib.request.Request(f"https://graph.facebook.com/{VER}/{ACCT}/adcreatives",
                             data=urllib.parse.urlencode(payload).encode(), method="POST")
print(urllib.request.urlopen(req).read())   # {"id": "<creative_id>"}
```

Copy rotativa (criativo dinâmico):
```python
asset_feed_spec = {"bodies": [{"text": "..."}], "titles": [{"text": "..."}],
                   "descriptions": [{"text": ""}], "optimization_type": "DEGREES_OF_FREEDOM"}
```

### Criar anúncio

```python
payload = {"access_token": TOKEN, "name": "<número do criativo>", "adset_id": "<adset_id>",
           "creative": json.dumps({"creative_id": "<creative_id>"}),
           "status": "PAUSED"}   # SEMPRE pausado; ative depois de confirmar
# POST /<META_AD_ACCOUNT_ID>/ads  ->  {"id": "<ad_id>"}
```

### Ativar, pausar, atualizar

```bash
curl -s -X POST "$GRAPH/<id>" --data-urlencode "access_token=$META_ACCESS_TOKEN" -d "status=ACTIVE"   # ou PAUSED
```

`effective_status=IN_PROCESS` logo após ativar é normal (revisão da Meta, 5 a 60 minutos).

### Apagar (ordem inversa)

```bash
curl -s -X DELETE -G "$GRAPH/<ad_id>" --data-urlencode "access_token=$META_ACCESS_TOKEN"
curl -s -X DELETE -G "$GRAPH/<creative_id>" --data-urlencode "access_token=$META_ACCESS_TOKEN"
curl -s -X DELETE -G "$GRAPH/$META_AD_ACCOUNT_ID/adimages" \
  --data-urlencode "access_token=$META_ACCESS_TOKEN" --data-urlencode "hash=<hash>"   # opcional
```

Pausar é mais seguro que apagar: preserva o histórico.

### Insights (métricas)

```bash
curl -s -G "$GRAPH/<id>/insights" \
  --data-urlencode "access_token=$META_ACCESS_TOKEN" \
  --data-urlencode "fields=spend,impressions,clicks,inline_link_clicks,ctr,cpc,cpm,actions,action_values,cost_per_action_type" \
  --data-urlencode "date_preset=last_7d" | semtoken
# ou: --data-urlencode 'time_range={"since":"AAAA-MM-DD","until":"AAAA-MM-DD"}'
# por anúncio: --data-urlencode "level=ad"
```

`<id>` pode ser conta, campanha, conjunto ou anúncio. Ações úteis em `actions`: `link_click`, `landing_page_view`, `lead`, `initiate_checkout`, `purchase` (ou `offsite_conversion.fb_pixel_purchase`).

## 5. Erros comuns (e como destravar)

| Código | Significado | Solução |
|---|---|---|
| `1885183` | Post criado por app em modo desenvolvimento | O admin muda o app para **Live** em developers.facebook.com (exige URL de política de privacidade). |
| `3858504` | `standard_enhancements` descontinuado | Omita `degrees_of_freedom_spec` inteiro no POST do criativo. |
| `2859024` | Certificação de não discriminação obrigatória | Admin do Business abre Configurações do negócio, Usuários do sistema, clica em **Adicionar**, aceita a política no modal e cancela o formulário. O aceite vale para todos os usuários do sistema. A interface deixa criar anúncio sem isso; a API não. |
| `1815001` | Objeto excluído na listagem | Remova `DELETED` do filtro `effective_status`. |
| `1885501` | Janela de atribuição inválida | Ver tabela abaixo; na dúvida, omita `attribution_spec`. |
| `100` | Parâmetro inválido | Quase sempre JSON malformado em `object_story_spec`/`asset_feed_spec`. Use `json.dumps(..., ensure_ascii=False)` em Python. |
| `100/4834011` | Falta `is_adset_budget_sharing_enabled` | Campanha sem orçamento próprio: envie `false`. |
| `1885665` | Piso e teto de gasto conflitantes (CBO) | `daily_min_spend_target` no máximo 90% de `daily_spend_cap`; para só limitar, envie só o teto. |
| `2446814` | Evento indisponível para o objetivo | Ver tabela de eventos abaixo; objetivo de campanha publicada não muda, crie outra. |
| `1815149` | Cópia entre objetivos diferentes | Não use `/copies`; crie criativo e anúncio novos manualmente. |
| `3260011` | Edição de Pixel/evento/otimização em conjunto publicado | Não tem como: crie conjunto (ou campanha) novo. |
| `17` / `2446079` | Rate limit da conta | Pare 5 a 15 minutos; veja seção 6. |
| `190` | Token expirado ou revogado | Gere outro token de usuário do sistema e atualize o `.env`. |

Janelas de atribuição válidas:

| Objetivo | `optimization_goal` | `attribution_spec` |
|---|---|---|
| `OUTCOME_SALES` | `OFFSITE_CONVERSIONS` | clique 7d (+ visualização 1d) ou clique 1d |
| `OUTCOME_LEADS` | `OFFSITE_CONVERSIONS` | igual a vendas |
| `OUTCOME_LEADS` | `LEAD_GENERATION` (formulário nativo) | clique 1d |
| `OUTCOME_TRAFFIC` | `LANDING_PAGE_VIEWS` / `LINK_CLICKS` | só clique 1d |
| `OUTCOME_AWARENESS` / `OUTCOME_ENGAGEMENT` | `REACH`, `IMPRESSIONS`, `POST_ENGAGEMENT`, `THRUPLAY` | omitir |

Eventos por objetivo:

| `custom_event_type` | Objetivo compatível |
|---|---|
| `PURCHASE`, `ADD_TO_CART`, `INITIATE_CHECKOUT` | `OUTCOME_SALES` |
| `LEAD`, `COMPLETE_REGISTRATION` | `OUTCOME_LEADS` |
| `VIEW_CONTENT` | `OUTCOME_TRAFFIC`, `OUTCOME_LEADS`, `OUTCOME_SALES` |
| conversão personalizada | qualquer objetivo de conversão (frágil, ver 7.2) |

**Conversão personalizada arquivada é irreversível**: `POST` com `is_archived=false` responde `success:true` mas nada muda. Confirme com novo GET; se continuar arquivada, crie outra ou migre para evento padrão.

## 5b. Renomear criativos ANTES de subir

Sempre renomeie os arquivos da pasta de criativos para `1.<ext>`, `2.<ext>`, ... antes do upload, mesmo que o usuário não peça:

- O número do arquivo vira o nome do anúncio, que vira `utm_term` pela macro `{{ad.name}}`. Cruzar criativo com venda no banco fica trivial.
- Nomes com espaço, parênteses ou acento quebram glob/shell e são ilegíveis em relatórios.
- Se a campanha já tem anúncios numerados, **continue a sequência** (o próximo lote começa no maior número + 1) para o `utm_term` nunca repetir dentro da campanha.

Como: liste a pasta, descubra o maior número em uso (`GET /<campaign_id>/ads?fields=name`), renomeie na ordem original (ou na que o usuário pedir), confira com `ls` e só então suba. Se o usuário pedir outro esquema de nomes, siga, mas avise que o padrão numérico facilita a análise.

## 5c. Fluxo: subir N criativos novos numa campanha existente

1. Listar campanhas e achar o `campaign_id`.
2. Listar conjuntos e escolher o `adset_id`.
3. Listar anúncios com `creative{...}`; escolher um modelo e o **maior número** de nome em uso.
4. GET do criativo modelo (com `url_tags` e `asset_feed_spec`, **sem** `degrees_of_freedom_spec`).
5. Conferir que o `url_tags` do modelo é o padrão (7.1); se não for, aplicar o padrão e avisar o usuário.
6. Renomear os arquivos para continuar a sequência (5b).
7. Upload das imagens (pausa de 0,5 s entre uploads acima de 5).
8. Criar criativos com link **limpo** + `url_tags` padrão.
9. Criar anúncios em `PAUSED` com `name=<número>` (pausa de 1 s entre criações acima de 5).
10. Mostrar a tabela e **perguntar antes de ativar**.
11. Ativar (`status=ACTIVE`) e conferir `effective_status`.

`upload_image_ads.py` faz os passos 7 a 9 de uma vez.

## 6. Rate limit e operações em lote

A Meta limita por conta de anúncios (Business Use Case): uma pontuação com `call_count`, `total_cputime` e `total_time`, que zera aos poucos em cerca de 1 hora. Upload de imagem, criação de criativo e de anúncio custam caro.

**Regra:** antes de criar mais de 5 objetos em loop, decida entre pausa, Batch API ou os dois. Acima de 20, é obrigatório.

- **Pausa simples:** `time.sleep(1.0)` entre iterações (cerca de 1 operação por segundo).
- **Ler o cabeçalho `X-Business-Use-Case-Usage`** de cada resposta e parar se qualquer dimensão passar de 80% (espere 60 s e retome):
  ```python
  def buc_pct(headers, acct):
      j = json.loads(headers.get("x-business-use-case-usage", "{}")).get(acct.replace("act_", ""), [{}])[0]
      return max(j.get("call_count", 0), j.get("total_cputime", 0), j.get("total_time", 0))
  ```
- **Batch API:** até 50 subrequisições por chamada em `POST https://graph.facebook.com/<VER>/` com `batch=[{"method":"POST","relative_url":"<act>/ads","body":"..."}]`. Reduz overhead HTTP, mas cada subrequisição ainda conta no limite. Suporta dependências (`{result=nome:$.id}`). Upload de imagem via batch exige `attached_files`.
- **Backoff no erro 17:** 10 s, 30 s, 90 s; depois desista e retome em 10 a 15 minutos.

Com bloqueio duro (`estimated_time_to_regain_access > 0`) não há atalho: espere, revise o que já foi criado (guarde IDs parciais com `--ids-out`) e retome de onde parou.

## 7. Padrões obrigatórios

### 7.1 UTMs sempre em `url_tags`, nunca no link

O link de `object_story_spec.link_data.link` (e do `call_to_action`) fica **limpo**: `https://$APP_HOSTNAME/<slug>`. As UTMs vão **só** em `url_tags`, literalmente:

```
utm_source={{site_source_name}}&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{adset.name}}&utm_term={{ad.name}}&meta_campaign_id={{campaign.id}}&meta_adset_id={{adset.id}}&meta_ad_id={{ad.id}}
```

- A Meta troca as macros na entrega (`fb`/`ig`, nome da campanha, do conjunto, do anúncio e os IDs numéricos). O mesmo criativo funciona em qualquer campanha.
- Esses valores chegam a `page_views`, `leads` e `orders`; o `/funil` filtra por `utm_campaign`/`utm_term` e o `/meta` cruza gasto com vendas pelo `meta_ad_id` (robusto a renomear) ou, na falta dele, pelo `utm_term`.
- `url_tags` é **imutável** depois de criado. Para mudar, só recriando o criativo (o anúncio ativo reinicia o aprendizado).
- UTM no link **e** em `url_tags` = a Meta concatena e o tráfego chega duplicado.
- Antes de clonar um criativo, confira o `url_tags` do modelo. Criativos feitos pela interface às vezes nascem sem ele.
- Não use `/copies` para clonar entre campanhas: o criativo vem com `url_tags` já interpolado e perde as macros.

### 7.2 Evento de conversão: perguntar ou sugerir

Antes de criar um conjunto com `OFFSITE_CONVERSIONS`, confirme o evento. Padrões:

- Página de venda com checkout: `PURCHASE` em `OUTCOME_SALES` (padrão deste projeto).
- Captura de contato: `LEAD` em `OUTCOME_LEADS`.

Prefira **eventos padrão** a conversões personalizadas: conversão personalizada pode ser arquivada sem volta, não pode ser trocada em conjunto publicado (`3260011`), não tem histórico global (aprendizado começa do zero) e demora mais para valer em iOS. Use conversão personalizada só com volume alto e necessidade real de otimizar ações diferentes separadamente.

Se a campanha otimiza `PURCHASE` e há poucas compras (o algoritmo fica sem sinal), considere um conjunto separado otimizando `INITIATE_CHECKOUT` ou `LEAD` até ter volume.

### 7.3 Conversions API e deduplicação

O Pixel sozinho perde de 20% a 40% dos eventos (bloqueadores, iOS, rede). Este projeto já envia CAPI pelo servidor:

1. O navegador gera um `event_id` único.
2. `fbq('track', 'Purchase', dados, { eventID: event_id })`.
3. O mesmo evento sai pelo servidor (`POST https://graph.facebook.com/<VER>/<PIXEL_ID>/events`) com o **mesmo** `event_id`, `action_source: "website"`, `event_source_url`, `user_data` com IP, user-agent, `fbp`, `fbc` e e-mail/telefone em SHA-256 (`sha256(valor.trim().toLowerCase())`).
4. A Meta deduplica pelo `event_id`.

Para testar, use `test_event_code` (variável `META_TEST_EVENT_CODE`) e confira em Gerenciador de Eventos, Eventos de teste. Taxa de deduplicação deve ficar perto de 100%.

## 8. Diagnóstico de "aprendizado limitado / 0 conversões"

Antes de pausar ou duplicar algo que "não converte":

1. `GET /<adset_id>?fields=optimization_goal,promoted_object,learning_stage_info`: `learning_stage_info` vazio com `OFFSITE_CONVERSIONS` indica zero conversões registradas.
2. `GET /<campaign_id>/insights?fields=actions,spend,impressions&date_preset=last_7d`: o evento alvo aparece em `actions`? Se não, o Pixel não está fechando o ciclo.
3. Se houver `custom_conversion_id`, verifique se está arquivada.
4. Confira no HTML/JS da página se o evento que o conjunto espera é o que realmente dispara.
5. Cruze com o banco (seção 9).

## 9. Cruzar Meta Ads com o banco D1 deste projeto

Consulte o banco remoto com o Wrangler do projeto (o nome do banco está em `D1_NAME` no `.env`):

```bash
set -a; . ./.env; set +a
npx wrangler d1 execute "$D1_NAME" --remote --json --command "<SQL>"
```

Consultas úteis, filtrando pela campanha (`utm_campaign` = nome da campanha) e agrupando por anúncio (`utm_term` = nome do anúncio):

```sql
-- Visitas por anúncio
SELECT utm_term, page, COUNT(*) views, COUNT(DISTINCT COALESCE(session_uuid, ip)) visitantes
FROM page_views WHERE utm_campaign='<NOME_CAMPANHA>' AND is_bot=0
GROUP BY utm_term, page ORDER BY utm_term;

-- Vendas aprovadas por anúncio (fonte única de compras)
SELECT COALESCE(meta_ad_id, utm_term) anuncio, COUNT(*) vendas, SUM(amount_cents)/100.0 receita
FROM orders WHERE status='approved' AND utm_campaign='<NOME_CAMPANHA>'
GROUP BY anuncio;

-- Leads por etapa do checkout
SELECT status, COUNT(*) FROM leads WHERE utm_campaign='<NOME_CAMPANHA>' GROUP BY status;
```

Compare `inline_link_clicks` e `landing_page_view` da Meta com as visitas do banco, e `purchase` da Meta com `orders` aprovados. Para análise completa com relatório, use a skill `analise-campanha`. Datas do banco estão no fuso de Brasília (`-03:00`); confira o `timezone_name` da conta de anúncios antes de comparar por hora ou dia.

## 10. Boas práticas

- **Nunca** crie anúncio direto em `ACTIVE` sem confirmação: sempre `PAUSED`, mostre o resumo e espere o "ok".
- **Nunca** altere campanha, conjunto ou anúncio existente sem pedir; por padrão, só crie novos.
- Antes de apagar, confirme e diga exatamente o que vai sumir.
- `curl -s -G --data-urlencode` para GETs; Python para POSTs com JSON aninhado.
- Depois de operação destrutiva, liste de novo para confirmar o estado final.

## 11. Referência rápida

**Objetivos:** `OUTCOME_AWARENESS`, `OUTCOME_TRAFFIC`, `OUTCOME_ENGAGEMENT`, `OUTCOME_LEADS`, `OUTCOME_APP_PROMOTION`, `OUTCOME_SALES`.

**`destination_type` do conjunto:** `WEBSITE` (padrão deste projeto), `APP`, `MESSENGER`, `INSTAGRAM_DIRECT`, `WEBSITE_AND_PHONE_CALL`.

**CTAs comuns:** `LEARN_MORE`, `SEE_DETAILS`, `SHOP_NOW`, `SIGN_UP`, `DOWNLOAD`, `GET_OFFER`, `SUBSCRIBE`, `CONTACT_US`, `MESSAGE_PAGE`.

**`promoted_object`:** `{"pixel_id": "$META_PIXEL_ID", "custom_event_type": "PURCHASE"}` (outros: `LEAD`, `COMPLETE_REGISTRATION`, `ADD_TO_CART`, `INITIATE_CHECKOUT`, `VIEW_CONTENT`).

**Público Advantage+ aberto (Brasil):**
```json
{"geo_locations": {"countries": ["BR"], "location_types": ["home", "recent"]},
 "age_min": 18, "age_max": 65, "locales": [6],
 "targeting_automation": {"advantage_audience": 1}}
```
Gênero: omita `genders` para ambos; `[1]` homens, `[2]` mulheres.
