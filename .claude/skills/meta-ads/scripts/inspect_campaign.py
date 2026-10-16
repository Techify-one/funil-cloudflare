#!/usr/bin/env python3
"""Diagnóstico genérico e somente leitura de uma campanha Meta Ads.

Uso (rode `set -a; . ./.env; set +a` antes, na raiz do repositório):
    python3 inspect_campaign.py <CAMPAIGN_ID>
    python3 inspect_campaign.py CP<N>
    python3 inspect_campaign.py CP<N> --account act_<ID_DA_CONTA>
    python3 inspect_campaign.py <CAMPAIGN_ID> --json

Credenciais e contas (variáveis de ambiente):
    META_ACCESS_TOKEN
    META_API_VERSION (opcional, padrão v25.0)
    META_AD_ACCOUNT_ID e/ou META_AD_ACCOUNT_IDS (lista separada por vírgula),
    usadas na busca por nome.

Não altera nada na Meta e nunca imprime o token.
"""

import argparse
import collections
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

TOKEN = os.environ.get("META_ACCESS_TOKEN")
VERSION = os.environ.get("META_API_VERSION", "v25.0")
GRAPH = f"https://graph.facebook.com/{VERSION}"


def redact(text):
    text = str(text)
    if TOKEN:
        text = text.replace(TOKEN, "***").replace(urllib.parse.quote(TOKEN, safe=""), "***")
    return text

def fail(message):
    print(f"ERRO: {redact(message)}", file=sys.stderr)
    raise SystemExit(1)


def api_get(path, params=None):
    params = dict(params or {})
    params["access_token"] = TOKEN
    url = f"{GRAPH}/{path}?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(url, timeout=40) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        fail(f"Meta API HTTP {exc.code} em GET /{path}: {body}")
    except urllib.error.URLError as exc:
        fail(f"Falha de rede em GET /{path}: {exc}")


def get_all(path, params=None):
    result = api_get(path, params)
    rows = list(result.get("data", []))
    next_url = result.get("paging", {}).get("next")
    while next_url:
        try:
            with urllib.request.urlopen(next_url, timeout=40) as response:
                result = json.loads(response.read())
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")
            fail(f"Meta API HTTP {exc.code} durante paginação: {body}")
        rows.extend(result.get("data", []))
        next_url = result.get("paging", {}).get("next")
    return rows


def normalize_account(value):
    if not value:
        return None
    return value if value.startswith("act_") else f"act_{value}"


def env_accounts():
    accounts = []
    for key, value in sorted(os.environ.items()):
        if not key.startswith("META_AD_ACCOUNT_ID") or not value:
            continue
        for part in value.split(","):
            account = normalize_account(part.strip())
            if account and account not in accounts:
                accounts.append(account)
    return accounts


def find_campaign(identifier, account=None):
    if identifier.isdigit():
        return api_get(
            identifier,
            {
                "fields": (
                    "id,name,account_id,status,effective_status,objective,buying_type,"
                    "daily_budget,lifetime_budget,budget_remaining,created_time,updated_time,"
                    "start_time,stop_time,issues_info,special_ad_categories"
                )
            },
        )

    accounts = [normalize_account(account)] if account else env_accounts()
    if not accounts:
        fail("para buscar por nome, informe --account ou configure META_AD_ACCOUNT_ID")

    matches = []
    for current_account in accounts:
        campaigns = get_all(
            f"{current_account}/campaigns",
            {
                "fields": (
                    "id,name,account_id,status,effective_status,objective,buying_type,"
                    "daily_budget,lifetime_budget,budget_remaining,created_time,updated_time,"
                    "start_time,stop_time,issues_info,special_ad_categories"
                ),
                "limit": 200,
            },
        )
        matches.extend(c for c in campaigns if c.get("name", "").casefold() == identifier.casefold())

    if not matches:
        fail(f"campanha '{identifier}' não encontrada nas contas configuradas")
    if len(matches) > 1:
        options = ", ".join(f"{c['id']} ({c.get('account_id')})" for c in matches)
        fail(f"nome ambíguo; use o ID da campanha. Encontradas: {options}")
    return matches[0]


def minor_to_money(value, currency):
    try:
        return f"{currency} {int(value) / 100:.2f}"
    except (TypeError, ValueError):
        return "n/d"


def action_count(insight, names):
    wanted = set(names)
    return sum(
        float(action.get("value", 0))
        for action in insight.get("actions", [])
        if action.get("action_type") in wanted
    )


def get_insight(campaign_id, preset):
    rows = get_all(
        f"{campaign_id}/insights",
        {
            "fields": "spend,impressions,reach,clicks,inline_link_clicks,cpm,actions",
            "date_preset": preset,
            "limit": 100,
        },
    )
    return rows[0] if rows else {}


def status_counts(rows):
    return dict(sorted(collections.Counter(row.get("effective_status", "UNKNOWN") for row in rows).items()))


def print_json(label, value):
    print(f"{label}: {json.dumps(value, ensure_ascii=False, sort_keys=True)}")


def main():
    parser = argparse.ArgumentParser(description="Diagnostica campanha Meta Ads por ID ou nome")
    parser.add_argument("campaign", help="ID numérico da campanha ou nome exato, por exemplo CP<N>")
    parser.add_argument("--account", help="Conta act_... usada somente quando a busca for por nome")
    parser.add_argument("--json", action="store_true", help="Imprime o diagnóstico completo em JSON")
    args = parser.parse_args()

    if not TOKEN:
        fail("META_ACCESS_TOKEN não configurado. Rode `set -a; . ./.env; set +a` na raiz do repositório.")

    campaign = find_campaign(args.campaign, args.account)
    campaign_id = campaign["id"]
    raw_account_id = str(campaign.get("account_id") or args.account or "")
    account_id = normalize_account(raw_account_id)
    if not account_id:
        fail("a API não retornou account_id; informe --account")

    account = api_get(
        account_id,
        {
            "fields": (
                "id,name,account_status,disable_reason,balance,amount_spent,spend_cap,"
                "currency,timezone_name,is_prepay_account,funding_source_details"
            )
        },
    )
    adsets = get_all(
        f"{campaign_id}/adsets",
        {
            "fields": (
                "id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining,"
                "bid_strategy,optimization_goal,billing_event,destination_type,promoted_object,"
                "learning_stage_info,created_time,updated_time,start_time,end_time,targeting,issues_info"
            ),
            "limit": 100,
        },
    )
    ads = get_all(
        f"{campaign_id}/ads",
        {
            "fields": (
                "id,name,status,effective_status,adset_id,created_time,updated_time,issues_info,"
                "ad_review_feedback,creative{id,name,url_tags,object_story_spec}"
            ),
            "limit": 100,
        },
    )
    today = get_insight(campaign_id, "today")
    lifetime = get_insight(campaign_id, "maximum")

    currency = account.get("currency", "")
    daily_minor = sum(int(row.get("daily_budget") or 0) for row in adsets)
    remaining_minor = sum(int(row.get("budget_remaining") or 0) for row in adsets)
    issue_adsets = [row["id"] for row in adsets if row.get("issues_info")]
    issue_ads = [row["id"] for row in ads if row.get("issues_info") or row.get("ad_review_feedback")]

    config_counter = collections.Counter()
    for row in adsets:
        signature = json.dumps(
            {
                "daily_budget": row.get("daily_budget"),
                "optimization_goal": row.get("optimization_goal"),
                "destination_type": row.get("destination_type"),
                "promoted_object": row.get("promoted_object"),
                "targeting": row.get("targeting"),
            },
            sort_keys=True,
            ensure_ascii=False,
        )
        config_counter[signature] += 1
    largest_duplicate_group = max(config_counter.values(), default=0)

    warnings = []
    if account.get("account_status") != 1 or account.get("disable_reason") not in (0, "0", None):
        warnings.append("Conta com possível restrição ou desativação")
    if campaign.get("effective_status") != "ACTIVE":
        warnings.append(f"Campanha não está entregável: {campaign.get('effective_status')}")
    if issue_adsets or issue_ads:
        warnings.append(f"Objetos com issues: {len(issue_adsets)} conjuntos e {len(issue_ads)} anúncios")
    if largest_duplicate_group >= 5:
        warnings.append(
            f"Fragmentação: {largest_duplicate_group} conjuntos têm configuração idêntica de público, orçamento e otimização"
        )
    if len(adsets) >= 20:
        warnings.append(f"Estrutura muito pulverizada: {len(adsets)} conjuntos")
    if not today:
        warnings.append("Sem impressões ou gasto registrados hoje")

    result = {
        "campaign": campaign,
        "account": account,
        "summary": {
            "adsets": len(adsets),
            "adset_statuses": status_counts(adsets),
            "ads": len(ads),
            "ad_statuses": status_counts(ads),
            "daily_budget_total_minor": daily_minor,
            "daily_budget_total": minor_to_money(daily_minor, currency),
            "budget_remaining_total_minor": remaining_minor,
            "budget_remaining_total": minor_to_money(remaining_minor, currency),
            "adsets_with_issues": len(issue_adsets),
            "ads_with_issues": len(issue_ads),
            "largest_identical_adset_group": largest_duplicate_group,
        },
        "insights": {"today": today, "lifetime": lifetime},
        "warnings": warnings,
    }

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    print(f"Campanha: {campaign.get('name')} ({campaign_id})")
    print(f"Conta: {account.get('name')} ({account_id})")
    print(f"Status: {campaign.get('status')} / efetivo {campaign.get('effective_status')}")
    print(f"Objetivo: {campaign.get('objective')}")
    print(f"Criada: {campaign.get('created_time', 'n/d')}")
    print(f"Atualizada: {campaign.get('updated_time', 'n/d')}")
    print(f"Conta ativa: {account.get('account_status') == 1}; motivo desativação: {account.get('disable_reason')}")
    print(f"Forma de pagamento: {account.get('funding_source_details', {}).get('display_string', 'n/d')}")
    print_json("Conjuntos por status", status_counts(adsets))
    print_json("Anúncios por status", status_counts(ads))
    print(f"Quantidade: {len(adsets)} conjuntos, {len(ads)} anúncios")
    print(f"Orçamento diário somado: {minor_to_money(daily_minor, currency)}")
    print(f"Saldo diário restante somado: {minor_to_money(remaining_minor, currency)}")
    print(f"Maior grupo de conjuntos idênticos: {largest_duplicate_group}")

    for label, insight in (("Hoje", today), ("Vida toda", lifetime)):
        if not insight:
            print(f"{label}: sem entrega registrada")
            continue
        print(
            f"{label}: gasto {currency} {float(insight.get('spend', 0)):.2f}, "
            f"impressões {insight.get('impressions', '0')}, cliques {insight.get('clicks', '0')}, "
            f"LPV {action_count(insight, ['landing_page_view']):g}, "
            f"compras {action_count(insight, ['purchase', 'offsite_conversion.fb_pixel_purchase']):g}"
        )

    if warnings:
        print("Alertas:")
        for warning in warnings:
            print(f"  - {warning}")
    else:
        print("Alertas: nenhum")


if __name__ == "__main__":
    main()
