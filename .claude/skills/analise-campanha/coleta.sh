#!/usr/bin/env bash
# Coleta automatizada para a análise de uma campanha da Meta Ads deste projeto.
#
# Uso (de qualquer pasta dentro do repositório):
#   .claude/skills/analise-campanha/coleta.sh <NOME_OU_NUMERO_DA_CAMPANHA>
# Exemplos:
#   .claude/skills/analise-campanha/coleta.sh <N>       # vira ${CAMPAIGN_PREFIX:-CP}<N>
#   .claude/skills/analise-campanha/coleta.sh CP<N>
#
# Saída: <repo>/analises/<campanha>/{dados,criativos,transcricoes}/
# Idempotente: sobrescreve os arquivos a cada execução.
# Nunca imprime o token nem a senha do dashboard.
set -euo pipefail

ARG="${1:?Uso: $0 <nome ou número da campanha>}"

REPO="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel 2>/dev/null || git rev-parse --show-toplevel)"
cd "$REPO"

if [ ! -f "$REPO/.env" ]; then
  echo "ERRO: .env não encontrado na raiz do repositório ($REPO)." >&2
  exit 1
fi
set -a; . "$REPO/.env"; set +a

PREFIX="${CAMPAIGN_PREFIX:-CP}"
if [[ "$ARG" =~ ^[0-9]+$ ]]; then CAMP_NAME="${PREFIX}${ARG}"; else CAMP_NAME="$ARG"; fi
SLUG="$(printf '%s' "$CAMP_NAME" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-')"
SLUG="${SLUG%-}"

: "${META_ACCESS_TOKEN:?defina META_ACCESS_TOKEN no .env}"
: "${META_AD_ACCOUNT_ID:?defina META_AD_ACCOUNT_ID no .env}"
: "${D1_NAME:?defina D1_NAME no .env}"
: "${APP_HOSTNAME:?defina APP_HOSTNAME no .env}"
VER="${META_API_VERSION:-v25.0}"
case "$META_AD_ACCOUNT_ID" in act_*) ACCT="$META_AD_ACCOUNT_ID" ;; *) ACCT="act_$META_AD_ACCOUNT_ID" ;; esac
GRAPH="https://graph.facebook.com/$VER"
export VER ACCT GRAPH

ANALISE_DIR="$REPO/analises/$SLUG"
DADOS="$ANALISE_DIR/dados"
CRIATIVOS_DIR="$ANALISE_DIR/criativos"
TRANS_DIR="$ANALISE_DIR/transcricoes"
mkdir -p "$DADOS" "$CRIATIVOS_DIR" "$TRANS_DIR"

# GET na Graph API. O token vai por --data-urlencode (não aparece no comando) e
# mensagens de erro do curl não incluem a URL com o token.
meta_get() {
  local path="$1"; shift
  local out
  if ! out=$(curl -sS -G "$GRAPH/$path" --data-urlencode "access_token=$META_ACCESS_TOKEN" "$@"); then
    echo "ERRO: falha de rede em GET /$path" >&2; return 1
  fi
  if printf '%s' "$out" | python3 -c "import sys,json; sys.exit(0 if 'error' in json.load(sys.stdin) else 1)" 2>/dev/null; then
    printf '%s' "$out" | python3 -c "import sys,json; e=json.load(sys.stdin)['error']; print('ERRO Meta /' + sys.argv[1] + ': ' + str(e.get('code')) + ' ' + str(e.get('message')), file=sys.stderr)" "$path"
    return 1
  fi
  # Remove `paging` (o link `next` da Graph traz o token na URL) antes de gravar.
  printf '%s' "$out" | python3 -c "
import sys, json, re
d = json.load(sys.stdin)
def limpa(x):
    if isinstance(x, dict):
        return {k: limpa(v) for k, v in x.items() if k != 'paging'}
    if isinstance(x, list):
        return [limpa(v) for v in x]
    if isinstance(x, str):
        return re.sub(r'access_token=[^&\\s\"]+', 'access_token=REMOVIDO', x)
    return x
json.dump(limpa(d), sys.stdout, ensure_ascii=False)
"
}

# Consulta no D1 remoto pelo wrangler do projeto. Grava o JSON em $2.
d1q() {
  local sql="$1" out="$2"
  if ! npx --no-install wrangler d1 execute "$D1_NAME" --remote --json --command "$sql" > "$out.tmp" 2> "$out.err"; then
    echo "  ! consulta D1 falhou ($(basename "$out")): $(tail -n 2 "$out.err" | tr '\n' ' ' | cut -c1-200)" >&2
    echo '[]' > "$out"; rm -f "$out.tmp" "$out.err"; return 0
  fi
  python3 - "$out.tmp" "$out" <<'PY'
import json, sys, re
raw = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r"^\s*[\[{]", raw, re.M)
data = json.loads(raw[m.start():] if m else raw)
rows = [r for blk in (data if isinstance(data, list) else [data]) for r in (blk.get("results") or [])]
json.dump(rows, open(sys.argv[2], "w", encoding="utf-8"), indent=2, ensure_ascii=False)
PY
  rm -f "$out.tmp" "$out.err"
}

sql_str() { printf "%s" "$1" | sed "s/'/''/g"; }
CAMP_SQL="$(sql_str "$CAMP_NAME")"

echo "▶ [1/8] Procurando a campanha '$CAMP_NAME' na conta $ACCT..."
CAMP_ID=$(meta_get "$ACCT/campaigns" \
  --data-urlencode "fields=id,name" --data-urlencode "limit=500" \
  --data-urlencode 'effective_status=["ACTIVE","PAUSED","ARCHIVED","IN_PROCESS","WITH_ISSUES","CAMPAIGN_PAUSED","PENDING_REVIEW","DISAPPROVED"]' \
  | python3 -c "import sys,json; n=sys.argv[1].strip().upper(); r=[c['id'] for c in json.load(sys.stdin).get('data',[]) if c.get('name','').strip().upper()==n]; print(r[0] if r else '')" "$CAMP_NAME")
if [ -z "$CAMP_ID" ]; then
  echo "ERRO: campanha '$CAMP_NAME' não encontrada na conta $ACCT." >&2
  exit 2
fi
echo "  ✓ campaign_id=$CAMP_ID"

echo "▶ [2/8] Detalhes da campanha → campaign_info.json"
meta_get "$CAMP_ID" \
  --data-urlencode "fields=id,name,status,effective_status,objective,created_time,start_time,stop_time,daily_budget,lifetime_budget,buying_type,bid_strategy,special_ad_categories,configured_status" \
  | python3 -m json.tool > "$DADOS/campaign_info.json"

echo "▶ [3/8] Conjuntos → adsets.json"
meta_get "$CAMP_ID/adsets" \
  --data-urlencode "fields=id,name,status,effective_status,daily_budget,lifetime_budget,bid_strategy,billing_event,optimization_goal,start_time,end_time,promoted_object,targeting,learning_stage_info" \
  --data-urlencode "limit=200" \
  | python3 -m json.tool > "$DADOS/adsets.json"

echo "▶ [4/8] Anúncios + criativos → ads.json"
meta_get "$CAMP_ID/ads" \
  --data-urlencode "fields=id,name,status,effective_status,adset_id,creative{id,name,thumbnail_url,url_tags,object_story_spec,asset_feed_spec,image_url,image_hash,video_id,body,title,call_to_action_type}" \
  --data-urlencode "limit=200" \
  | python3 -m json.tool > "$DADOS/ads.json"

echo "▶ [5/8] Insights da vida toda (campanha, conjuntos, anúncios)"
for level in campaign adset ad; do
  meta_get "$CAMP_ID/insights" \
    --data-urlencode "fields=campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,inline_link_clicks,unique_clicks,cpc,cpm,ctr,inline_link_click_ctr,reach,frequency,actions,action_values,cost_per_action_type,cost_per_inline_link_click,purchase_roas" \
    --data-urlencode "level=$level" \
    --data-urlencode "date_preset=maximum" \
    --data-urlencode "limit=200" \
    | python3 -m json.tool > "$DADOS/insights_${level}.json"
done
meta_get "$CAMP_ID/insights" \
  --data-urlencode "fields=spend,impressions,inline_link_clicks,actions,action_values" \
  --data-urlencode "date_preset=maximum" --data-urlencode "time_increment=1" --data-urlencode "limit=500" \
  | python3 -m json.tool > "$DADOS/insights_daily.json"

echo "▶ [6/8] Criativos completos (copy, url_tags, asset_feed_spec) → creatives_full.json"
python3 - "$DADOS" <<'PY'
import json, os, sys, urllib.request, urllib.parse
dados = sys.argv[1]
graph, token = os.environ["GRAPH"], os.environ["META_ACCESS_TOKEN"]
ads = json.load(open(f"{dados}/ads.json", encoding="utf-8")).get("data", [])
out = []
for ad in ads:
    cr = ad.get("creative") or {}
    cid = cr.get("id")
    if not cid:
        continue
    q = urllib.parse.urlencode({
        "fields": "id,name,thumbnail_url,image_url,image_hash,video_id,body,title,url_tags,"
                  "object_story_spec,asset_feed_spec,effective_object_story_id,call_to_action_type",
        "access_token": token,
    })
    try:
        with urllib.request.urlopen(f"{graph}/{cid}?{q}", timeout=30) as r:
            data = json.loads(r.read())
    except Exception as e:  # nunca imprime a URL (tem o token)
        data = {"error": type(e).__name__, "creative_id": cid}
    data.update({"_ad_id": ad.get("id"), "_ad_name": ad.get("name"),
                 "_adset_id": ad.get("adset_id"), "_status": ad.get("status")})
    out.append(data)
json.dump(out, open(f"{dados}/creatives_full.json", "w", encoding="utf-8"), indent=2, ensure_ascii=False)
print(f"  ✓ {len(out)} criativos")
PY

echo "▶ [7/8] Baixando as imagens → criativos/ad_<nome>.jpg"
python3 - "$DADOS" "$CRIATIVOS_DIR" <<'PY'
import json, os, re, sys, urllib.request, urllib.parse
dados, destino = sys.argv[1], sys.argv[2]
graph, token, acct = os.environ["GRAPH"], os.environ["META_ACCESS_TOKEN"], os.environ["ACCT"]
saved = []
for cr in json.load(open(f"{dados}/creatives_full.json", encoding="utf-8")):
    nome = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(cr.get("_ad_name") or cr.get("_ad_id")))
    img_url, h = None, cr.get("image_hash")
    if h:
        q = urllib.parse.urlencode({"hashes": json.dumps([h]), "fields": "hash,url,width,height",
                                    "access_token": token})
        try:
            with urllib.request.urlopen(f"{graph}/{acct}/adimages?{q}", timeout=30) as r:
                img_url = (json.loads(r.read()).get("data") or [{}])[0].get("url")
        except Exception:
            img_url = None
    img_url = img_url or cr.get("image_url") or cr.get("thumbnail_url")
    if not img_url:
        if cr.get("video_id"):
            saved.append({"ad": cr.get("_ad_name"), "video_id": cr.get("video_id")})
        continue
    path = os.path.join(destino, f"ad_{nome}.jpg")
    try:
        urllib.request.urlretrieve(img_url, path)
        saved.append({"ad": cr.get("_ad_name"), "path": path, "hash": h,
                      "video_id": cr.get("video_id")})
        print(f"  ✓ ad_{nome}.jpg" + (" (miniatura de vídeo)" if cr.get("video_id") else ""))
    except Exception as e:
        print(f"  ✗ {nome}: {type(e).__name__}", file=sys.stderr)
json.dump(saved, open(f"{dados}/creatives_downloaded.json", "w", encoding="utf-8"), indent=2, ensure_ascii=False)
PY

echo "▶ [8/8] Banco D1 ($D1_NAME): visitas, leads, pedidos, funil"
d1q "SELECT page, funnel, utm_page, COUNT(*) c, COUNT(DISTINCT COALESCE(session_uuid, ip)) visitantes FROM page_views WHERE utm_campaign='$CAMP_SQL' AND is_bot=0 GROUP BY page, funnel, utm_page ORDER BY c DESC" "$DADOS/d1_pageviews_overview.json"

FUNNEL=$(python3 -c "
import json,sys
rows=json.load(open(sys.argv[1], encoding='utf-8')); agg={}
for r in rows:
    if r.get('funnel'): agg[r['funnel']]=agg.get(r['funnel'],0)+int(r.get('c') or 0)
print(max(agg.items(), key=lambda x:x[1])[0] if agg else '')" "$DADOS/d1_pageviews_overview.json")
echo "  funil dominante: ${FUNNEL:-(não detectado)}"
printf '%s\n' "$FUNNEL" > "$DADOS/funnel_slug.txt"
FUN_SQL="$(sql_str "$FUNNEL")"

d1q "SELECT date(created_at) d, page, COUNT(*) c, COUNT(DISTINCT COALESCE(session_uuid, ip)) visitantes FROM page_views WHERE utm_campaign='$CAMP_SQL' AND is_bot=0 GROUP BY d, page ORDER BY d DESC, c DESC" "$DADOS/d1_pageviews_daily.json"
d1q "SELECT utm_term, page, COUNT(*) c, COUNT(DISTINCT COALESCE(session_uuid, ip)) visitantes FROM page_views WHERE utm_campaign='$CAMP_SQL' AND is_bot=0 GROUP BY utm_term, page ORDER BY utm_term, page" "$DADOS/d1_pageviews_by_ad.json"
d1q "WITH lp AS (SELECT DISTINCT COALESCE(session_uuid, ip) k FROM page_views WHERE utm_campaign='$CAMP_SQL' AND is_bot=0 AND page <> 'checkout' AND page <> 'obrigado'), ck AS (SELECT DISTINCT COALESCE(session_uuid, ip) k FROM page_views WHERE utm_campaign='$CAMP_SQL' AND is_bot=0 AND page = 'checkout') SELECT 'visitantes_pagina' tipo, COUNT(*) qtd FROM lp UNION ALL SELECT 'visitantes_checkout', COUNT(*) FROM ck UNION ALL SELECT 'pagina_e_checkout', COUNT(*) FROM lp WHERE k IN (SELECT k FROM ck) UNION ALL SELECT 'so_pagina', COUNT(*) FROM lp WHERE k NOT IN (SELECT k FROM ck)" "$DADOS/d1_funnel_unique_visitors.json"
d1q "SELECT id, created_at, status, method, product, funnel, utm_term, utm_content, utm_page, meta_ad_id FROM leads WHERE utm_campaign='$CAMP_SQL' ORDER BY created_at DESC" "$DADOS/d1_leads.json"
d1q "SELECT status, COUNT(*) n FROM leads WHERE utm_campaign='$CAMP_SQL' GROUP BY status ORDER BY n DESC" "$DADOS/d1_leads_by_status.json"
d1q "SELECT o.id, o.created_at, o.approved_at, o.status, o.method, o.amount_cents, o.utm_term, o.utm_content, o.meta_ad_id, of.code offer_code, f.slug funnel FROM orders o LEFT JOIN offers of ON of.id=o.offer_id LEFT JOIN funnels f ON f.id=o.funnel_id WHERE o.utm_campaign='$CAMP_SQL' ORDER BY o.created_at DESC" "$DADOS/d1_orders.json"
d1q "SELECT COALESCE(NULLIF(meta_ad_id,''), 'term:' || COALESCE(utm_term,'')) anuncio, COUNT(*) vendas, SUM(amount_cents) receita_cents FROM orders WHERE utm_campaign='$CAMP_SQL' AND status='approved' GROUP BY anuncio ORDER BY vendas DESC" "$DADOS/d1_sales_by_ad.json"
d1q "SELECT pd.channel, pd.status, COUNT(*) n FROM purchase_dispatches pd JOIN orders o ON o.id=pd.order_id WHERE o.utm_campaign='$CAMP_SQL' GROUP BY pd.channel, pd.status" "$DADOS/d1_dispatches.json"
d1q "SELECT stage, error_code, COUNT(*) n FROM payment_errors WHERE utm_campaign='$CAMP_SQL' GROUP BY stage, error_code ORDER BY n DESC" "$DADOS/d1_payment_errors.json"
d1q "SELECT last_stage, COUNT(*) n, ROUND(AVG(visible_ms)/1000.0,1) seg_visivel FROM checkout_sessions WHERE is_bot=0 AND session_uuid IN (SELECT DISTINCT session_uuid FROM page_views WHERE utm_campaign='$CAMP_SQL' AND session_uuid IS NOT NULL) GROUP BY last_stage ORDER BY n DESC" "$DADOS/d1_checkout_stages.json"
d1q "SELECT id, code, name, anchor_price_cents, sale_price_cents, is_active, out_of_stock, thanks_url, email_enabled, email_subject, email_access_url FROM offers WHERE is_active=1" "$DADOS/d1_offers.json"

if [ -n "$FUNNEL" ]; then
  d1q "SELECT fs.position, fs.key, fs.label, fs.source, fs.match_value FROM funnel_steps fs JOIN funnels f ON fs.funnel_id=f.id WHERE f.slug='$FUN_SQL' ORDER BY fs.position" "$DADOS/d1_funnel_steps.json"
  d1q "SELECT pv.utm_campaign, COUNT(DISTINCT CASE WHEN pv.page NOT IN ('checkout','obrigado') THEN COALESCE(pv.session_uuid, pv.ip) END) visitantes_pagina, COUNT(DISTINCT CASE WHEN pv.page='checkout' THEN COALESCE(pv.session_uuid, pv.ip) END) visitantes_checkout, (SELECT COUNT(*) FROM orders o JOIN funnels f ON f.id=o.funnel_id WHERE f.slug='$FUN_SQL' AND o.utm_campaign=pv.utm_campaign AND o.status='approved') vendas FROM page_views pv WHERE pv.funnel='$FUN_SQL' AND pv.is_bot=0 AND pv.utm_campaign IS NOT NULL AND pv.utm_campaign<>'' GROUP BY pv.utm_campaign ORDER BY visitantes_pagina DESC LIMIT 10" "$DADOS/d1_compare_campaigns.json"

  if [ -n "${DASH_PASS:-}" ]; then
    if curl -sS -f -G -u "${DASH_USER:-admin}:$DASH_PASS" \
         "https://$APP_HOSTNAME/dashboard/api/funnel" \
         --data-urlencode "funnel=$FUNNEL" --data-urlencode "range=90d" \
         --data-urlencode "utm_campaign=$CAMP_NAME" \
         -o "$DADOS/dashboard_funnel.raw" 2>/dev/null; then
      python3 -m json.tool "$DADOS/dashboard_funnel.raw" > "$DADOS/dashboard_funnel.json" || true
    else
      echo "  ! API do funil no dashboard falhou (confira DASH_USER/DASH_PASS)" >&2
    fi
    rm -f "$DADOS/dashboard_funnel.raw"
  fi
fi

echo ""
echo "✅ Coleta concluída em $ANALISE_DIR"
python3 - "$DADOS" "$FUNNEL" <<'PY'
import json, os, sys
dados, funil = sys.argv[1], sys.argv[2]
def load(n, default=None):
    try: return json.load(open(os.path.join(dados, n), encoding="utf-8"))
    except Exception: return default
ci = load("campaign_info.json", {}) or {}
icd = ((load("insights_campaign.json", {}) or {}).get("data") or [{}])[0]
acts = {a["action_type"]: a["value"] for a in icd.get("actions", [])}
vals = {a["action_type"]: a["value"] for a in icd.get("action_values", [])}
orders = load("d1_orders.json", []) or []
aprov = [o for o in orders if o.get("status") == "approved"]
receita = sum(int(o.get("amount_cents") or 0) for o in aprov) / 100
print(f"   Campanha: {ci.get('name')} status={ci.get('effective_status')} objetivo={ci.get('objective')}")
print(f"   Janela: {ci.get('start_time', '?')} -> {ci.get('stop_time', '?')}")
print(f"   Gasto: R$ {icd.get('spend', '-')}  Impressões: {icd.get('impressions', '-')}  Cliques no link: {icd.get('inline_link_clicks', '-')}  CTR: {icd.get('ctr', '-')}%")
print(f"   Meta: LPV {acts.get('landing_page_view', '-')}  IC {acts.get('initiate_checkout', '-')}  Compras {acts.get('purchase', '-')}  Receita R$ {vals.get('purchase', '-')}")
print(f"   D1: vendas aprovadas {len(aprov)}  receita R$ {receita:.2f}  funil {funil or '(não detectado)'}")
PY
