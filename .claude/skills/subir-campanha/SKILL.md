---
name: subir-campanha
description: Sobe uma campanha de vendas nova na Meta Ads para uma página deste projeto, com nome sequencial automático (prefixo CAMPAIGN_PREFIX + número), objetivo Vendas otimizando Purchase no Pixel do .env, público Advantage+, padrão de UTM nos criativos e tudo PAUSADO até o usuário confirmar. Exige funil cadastrado antes. Use quando o usuário pedir "subir campanha", "criar nova campanha", "rodar campanha na Meta", "nova CP" ou invocar /subir-campanha.
---

# Subir campanha de vendas na Meta

Wrapper opinativo sobre a skill `meta-ads` (mesmo repositório, `.claude/skills/meta-ads/`). Encapsula o padrão do projeto: Pixel do `.env`, objetivo de vendas com evento `Purchase`, público Advantage+, UTMs por macros no criativo, nome sequencial e **nada ativo sem confirmação**.

Todos os caminhos são relativos à raiz do repositório.

## Segurança (credenciais)

- Carregue o `.env` só com `set -a; . ./.env; set +a`. Isso não imprime nada.
- **Nunca** rode `cat .env`, `echo $META_ACCESS_TOKEN`, `printenv`, `env | grep`, nem `curl -v`.
- Use o token sempre por expansão (`"access_token=$META_ACCESS_TOKEN"`), nunca com o valor literal.
- **Toda resposta da Graph API passa pelo filtro `| python3 -c 'import sys,json;d=json.load(sys.stdin);d.pop("paging",None);print(json.dumps(d,ensure_ascii=False,indent=1))'`** antes de ser exibida ou gravada: o link `paging.next` traz o token na URL. Os exemplos abaixo usam o alias `semtoken`, definido assim:
  ```bash
  semtoken() { python3 -c 'import sys,json;d=json.load(sys.stdin);d.pop("paging",None);print(json.dumps(d,ensure_ascii=False,indent=1))'; }
  ```
- Não cole tokens no chat. Se o usuário colar um, peça para revogar no Business Manager e não repita o valor.

## Variáveis do `.env` usadas

| Variável | Uso |
|---|---|
| `META_ACCESS_TOKEN` | Token de usuário do sistema com `ads_management`. |
| `META_AD_ACCOUNT_ID` | Conta de anúncios, com prefixo `act_`. |
| `META_PIXEL_ID` | Pixel otimizado no conjunto (`promoted_object`). Nunca use outro ID fixo. |
| `META_PAGE_ID` | Página do Facebook que assina os anúncios. |
| `META_IG_USER_ID` | Conta do Instagram dos anúncios (opcional, mas recomendado). |
| `META_API_VERSION` | Opcional; padrão `v25.0`. |
| `CAMPAIGN_PREFIX` | Prefixo do nome das campanhas; padrão `CP` (gera o prefixo seguido de um número sequencial). |
| `APP_HOSTNAME` | Domínio público das páginas (`https://$APP_HOSTNAME/<slug>`). |
| `DASH_USER` / `DASH_PASS` | Basic Auth do dashboard (checagem de funil). |

Se faltar alguma, pare e peça para o usuário preencher no `.env` (sem colar o valor no chat).

## Passo 1 (obrigatório): o funil existe?

Antes de criar qualquer coisa na Meta, confirme que a página de destino tem funil cadastrado. Sem isso, as vendas da campanha não aparecem no `/funil` nem no `/meta`.

```bash
set -a; . ./.env; set +a
curl -s -u "$DASH_USER:$DASH_PASS" "https://$APP_HOSTNAME/dashboard/api/funnels" \
  | python3 -c "import sys,json; [print(f['slug'], '|', f['name'], '|', [s['match_value'] for s in f['steps']]) for f in json.load(sys.stdin)['funnels']]"
```

- Identifique o slug da página (`https://$APP_HOSTNAME/<slug>`) e confira se há um funil cujo `slug` é o `funnel` registrado em `site/pages.config.mjs` e cuja 1ª etapa casa com a página.
- **Se existir**, reutilize: campanhas diferentes na mesma página compartilham o funil e se diferenciam por `utm_campaign`.
- **Se não existir**, pare e rode a skill `nova-pagina` (ela cria página, oferta, funil e painel). Só volte aqui depois do smoke test dela passar.

## Passo 2: coletar o que falta (perguntar, sem assumir)

1. **Página de destino**: slug (o link final é `https://$APP_HOSTNAME/<slug>`, sem query string).
2. **Orçamento diário** em reais (ex.: 150). No payload vai em centavos (`15000`).
3. **Pasta dos criativos** com as imagens (ou vídeos).
4. **Copy**: texto principal (`message`), título (`name`) e descrição opcional. Se o usuário não tiver, ofereça gerar a partir do HTML da página (`public/pages/<slug>/v1.html`: headline, subheadline, benefícios), ou reaproveitar a copy da última campanha que apontava para a mesma página.

Padrões do projeto (não pergunte, só confirme se o usuário quiser mudar):

| Item | Padrão |
|---|---|
| Evento de conversão | `Purchase` (`custom_event_type: PURCHASE`) no Pixel `$META_PIXEL_ID` |
| Público | Brasil, 18 a 65, ambos os gêneros, pt-BR, Advantage+ audience |
| Posicionamentos | Advantage+ (automáticos) |
| CTA | `LEARN_MORE` (Saiba mais) |
| Status inicial | Tudo `PAUSED` |

O público é configurável: país (`countries`), idade (`age_min`/`age_max`), idioma (`locales`) e gênero podem ser trocados se o usuário pedir. Para um gênero só use `genders: [1]` (homens) ou `[2]` (mulheres); para ambos, **omita** o campo.

## Passo 3: nomes automáticos

- **Campanha**: `${CAMPAIGN_PREFIX}<N>`, com N = maior número existente + 1.
- **Conjunto**: `${CAMPAIGN_PREFIX}<N>_ADSET1`.
- **Anúncios**: `1`, `2`, `3`... igual ao nome dos arquivos de criativo.

Próximo nome livre:

```bash
set -a; . ./.env; set +a
PREFIX="${CAMPAIGN_PREFIX:-CP}"
VER="${META_API_VERSION:-v25.0}"
curl -s -G "https://graph.facebook.com/$VER/$META_AD_ACCOUNT_ID/campaigns" \
  --data-urlencode "access_token=$META_ACCESS_TOKEN" \
  --data-urlencode "fields=name" --data-urlencode "limit=500" \
  --data-urlencode 'effective_status=["ACTIVE","PAUSED","ARCHIVED","IN_PROCESS","WITH_ISSUES","CAMPAIGN_PAUSED"]' \
  | PREFIX="$PREFIX" python3 -c "
import sys, json, os, re
p = os.environ['PREFIX']
ns = [int(m.group(1)) for c in json.load(sys.stdin).get('data', []) if (m := re.fullmatch(re.escape(p) + r'(\d+)', c.get('name', '').strip(), re.I))]
print(p + str(max(ns) + 1 if ns else 1))"
```

Se a conta tiver mais de 500 campanhas, siga `paging.next` antes de concluir o número.

## Passo 4: preparar os criativos

Renomeie os arquivos da pasta para `1.<ext>`, `2.<ext>`, ... na ordem desejada (ver skill `meta-ads`, seção "Renomear criativos"). O número do arquivo vira o nome do anúncio, que vira `utm_term` pelas macros e permite cruzar cada criativo com as vendas.

## Padrão de UTM (obrigatório e literal)

O link do criativo fica **limpo**: `https://$APP_HOSTNAME/<slug>`, sem `?utm_...`. Os parâmetros vão **só** no campo `url_tags` do criativo, exatamente:

```
utm_source={{site_source_name}}&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{adset.name}}&utm_term={{ad.name}}&meta_campaign_id={{campaign.id}}&meta_adset_id={{adset.id}}&meta_ad_id={{ad.id}}
```

Por que isso importa:

- A Meta troca as macros na entrega: `utm_source` vira `fb`/`ig`, `utm_campaign` vira `${CAMPAIGN_PREFIX}<N>`, `utm_content` vira o nome do conjunto, `utm_term` vira o nome do anúncio (`1`, `2`...), e os `meta_*_id` viram os IDs numéricos.
- A página grava esses valores em `page_views`; o `lp-tracking.js` repassa todos para o checkout, que grava em `leads` e `orders`.
- O `/funil` filtra por `utm_campaign`/`utm_term`. O `/meta` cruza gasto da Meta com vendas de `orders` pelo `meta_ad_id` (robusto a renomear anúncio) e, sem ele, por `utm_term`.
- `url_tags` é **imutável** depois que o criativo é criado. Se nascer errado, só recriando o criativo (o que reinicia o aprendizado do anúncio).
- Nunca coloque UTM no link **e** em `url_tags`: a Meta concatena e o tráfego chega com parâmetros duplicados.

## Passo 5: confirmar o resumo com o usuário

Antes de qualquer POST na Meta, mostre e peça "ok":

- Nome da campanha, do conjunto e lista de anúncios (`1` a `N` com o arquivo de cada um).
- Orçamento diário (R$).
- Link de destino limpo e a string de `url_tags`.
- Pixel (só o fato de vir de `META_PIXEL_ID`), evento `Purchase`, público.
- Copy completa.
- Funil que vai receber o tráfego.

## Passo 6: criar tudo PAUSADO

Configuração aplicada:

**Campanha**: `objective=OUTCOME_SALES`, `buying_type=AUCTION`, `status=PAUSED`, `special_ad_categories=[]`, `is_adset_budget_sharing_enabled=false` (orçamento no conjunto).

**Conjunto**: `daily_budget=<centavos>`, `billing_event=IMPRESSIONS`, `optimization_goal=OFFSITE_CONVERSIONS`, `bid_strategy=LOWEST_COST_WITHOUT_CAP`, `destination_type=WEBSITE`, `promoted_object={"pixel_id":"$META_PIXEL_ID","custom_event_type":"PURCHASE"}`, `attribution_spec=[{"event_type":"CLICK_THROUGH","window_days":7}]`, `status=PAUSED`, targeting:

```json
{
  "geo_locations": {"countries": ["BR"], "location_types": ["home", "recent"]},
  "age_min": 18,
  "age_max": 65,
  "locales": [6],
  "targeting_automation": {"advantage_audience": 1}
}
```

Pelos scripts da skill `meta-ads`:

```bash
set -a; . ./.env; set +a
S=.claude/skills/meta-ads/scripts

# 6a. Campanha + conjunto (imprime {"campaign_id","adset_id"})
IDS=$(python3 $S/create_campaign.py "<NOME_CAMPANHA>" OUTCOME_SALES <ORCAMENTO_REAIS> \
  --adset-name "<NOME_CAMPANHA>_ADSET1" \
  --optimization-goal OFFSITE_CONVERSIONS \
  --custom-event-type PURCHASE \
  --attribution-days 7 \
  --locale 6)
ADSET=$(printf '%s' "$IDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['adset_id'])")

# 6b. Um anúncio por imagem (link limpo; url_tags padrão aplicado por default)
python3 $S/upload_image_ads.py \
  --adset-id "$ADSET" \
  --link "https://$APP_HOSTNAME/<slug>" \
  --message-file /caminho/copy.txt --headline "<título>" --cta LEARN_MORE \
  --image-dir /caminho/criativos --image-pattern '{i}.png' \
  --first 1 --last <N> --ad-name-template '{i}'
```

`create_campaign.py` lê o Pixel de `META_PIXEL_ID` e `upload_image_ads.py` lê página/Instagram de `META_PAGE_ID`/`META_IG_USER_ID` (ambos aceitam sobrescrever por argumento). Os anúncios nascem `PAUSED` (não use `--activate` aqui). Entre operações em lote os scripts já fazem pausa contra rate limit.

## Passo 7: ativar só depois do "ok" do usuário

Mostre a tabela (anúncio, `ad_id`, `creative_id`, `image_hash`) e pergunte se pode ativar. Com o "ok", ative na ordem campanha, conjunto, anúncios:

```bash
VER="${META_API_VERSION:-v25.0}"
for ID in <campaign_id> <adset_id> <ad_id_1> <ad_id_2>; do
  curl -s -X POST "https://graph.facebook.com/$VER/$ID" \
    --data-urlencode "access_token=$META_ACCESS_TOKEN" -d "status=ACTIVE"
  echo; sleep 1
done
```

Depois verifique:

```bash
curl -s -G "https://graph.facebook.com/$VER/<campaign_id>/ads" \
  --data-urlencode "access_token=$META_ACCESS_TOKEN" \
  --data-urlencode "fields=name,status,effective_status,creative{url_tags}"
```

`effective_status=IN_PROCESS` logo após ativar é normal (revisão da Meta). Confirme que `url_tags` saiu idêntico ao padrão.

## Passo 8: reportar

Entregue: nome e `campaign_id`, `adset_id`, tabela de anúncios, link de destino e o link do funil filtrado: `https://$APP_HOSTNAME/funil?funnel=<funil>&utm_campaign=<NOME_CAMPANHA>`.

## Erros comuns

Detalhes na skill `meta-ads` (seção de erros). Os mais frequentes neste fluxo:

- `100/4834011`: faltou `is_adset_budget_sharing_enabled=false` na campanha.
- `2446814`: evento incompatível com o objetivo (`PURCHASE` exige `OUTCOME_SALES`).
- `1885501`: janela de atribuição inválida para a otimização; na dúvida, omita `attribution_spec`.
- `3858504`: criativo clonado com `degrees_of_freedom_spec`; omita o campo.
- `17` / `2446079`: rate limit; espere 5 a 15 minutos e retome de onde parou.
- `2859024`: falta o aceite da política de não discriminação no Business Manager.

## Fora do escopo desta skill

- Criar página, oferta ou funil: skill `nova-pagina`.
- Gerar as imagens dos criativos.
- Analisar resultados: skill `analise-campanha`.
- Operações avulsas (pausar, duplicar, listar): skill `meta-ads`.
