#!/usr/bin/env python3
"""
Cria uma campanha + 1 conjunto com público Advantage+ aberto, tudo em PAUSED.
Imprime os IDs (campaign_id, adset_id) em JSON no stdout para encadear scripts.

Cobre as pegadinhas mais comuns:
  - is_adset_budget_sharing_enabled=false obrigatório quando o orçamento é do conjunto
  - bid_strategy explícito (LOWEST_COST_WITHOUT_CAP); sem ele a Meta exige bid_amount
  - promoted_object (Pixel + evento) quando a otimização é OFFSITE_CONVERSIONS

Uso:
  python3 create_campaign.py NOME OBJECTIVE ORCAMENTO_DIARIO_REAIS [opções]

Exemplos:
  # Vendas otimizando Purchase no Pixel do .env (META_PIXEL_ID), janela de 7 dias
  python3 create_campaign.py CP<N> OUTCOME_SALES 150 --adset-name CP<N>_ADSET1

  # Tráfego otimizando visualização da página de destino
  python3 create_campaign.py CP<N> OUTCOME_TRAFFIC 50

OBJECTIVE: OUTCOME_SALES | OUTCOME_LEADS | OUTCOME_TRAFFIC | OUTCOME_AWARENESS | OUTCOME_ENGAGEMENT

Padrões derivados do objetivo (todos sobrescrevíveis):
  OUTCOME_SALES  -> OFFSITE_CONVERSIONS + PURCHASE, atribuição clique 7 dias
  OUTCOME_LEADS  -> OFFSITE_CONVERSIONS + LEAD, atribuição clique 7 dias
  demais         -> LANDING_PAGE_VIEWS, atribuição clique 1 dia

Notas:
  - O orçamento é em REAIS; o script converte para centavos.
  - Público padrão: BR, 18-65, ambos os gêneros, Advantage+ audience ligado.
  - O Pixel vem de --pixel-id ou da variável META_PIXEL_ID. Nunca fixe IDs aqui.
"""
import sys, json, argparse
from meta_api import api, ACCT, env_default

DEFAULT_EVENT = {"OUTCOME_SALES": "PURCHASE", "OUTCOME_LEADS": "LEAD"}


def parse_args():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("name", help="Nome da campanha (ex.: CP<N>)")
    p.add_argument("objective", help="OUTCOME_SALES | OUTCOME_LEADS | OUTCOME_TRAFFIC | ...")
    p.add_argument("daily_budget_brl", type=float, help="Orçamento diário em REAIS")
    p.add_argument("--adset-name", default=None,
                   help="Nome do conjunto (padrão: '<nome>_ADSET1')")
    p.add_argument("--country", default="BR", help="Código do país (padrão BR)")
    p.add_argument("--age-min", type=int, default=18)
    p.add_argument("--age-max", type=int, default=65)
    p.add_argument("--gender", choices=["all", "male", "female"], default="all",
                   help="all omite o campo genders (ambos)")
    p.add_argument("--locale", type=int, action="append", default=None,
                   help="ID de idioma da Meta (6 = português). Pode repetir.")
    p.add_argument("--no-advantage-audience", action="store_true",
                   help="Desliga o Advantage+ audience")
    p.add_argument("--optimization-goal", default=None,
                   help="Padrão derivado do objetivo (ver docstring)")
    p.add_argument("--custom-event-type", default=None,
                   help="PURCHASE | LEAD | INITIATE_CHECKOUT | ... (padrão derivado do objetivo)")
    p.add_argument("--pixel-id", default=env_default("META_PIXEL_ID"),
                   help="Pixel do promoted_object (padrão: META_PIXEL_ID)")
    p.add_argument("--destination-type", default="WEBSITE")
    p.add_argument("--attribution-days", type=int, default=None,
                   help="Janela de clique (1 ou 7). Padrão derivado do objetivo.")
    p.add_argument("--no-attribution", action="store_true",
                   help="Omite attribution_spec (AWARENESS/ENGAGEMENT, ou deixar o padrão da Meta)")
    p.add_argument("--start-time", default=None,
                   help="Agendamento ISO, ex.: 2026-01-31T08:00:00-0300")
    return p.parse_args()


def main():
    a = parse_args()
    objective = a.objective.strip().upper()
    daily_cents = int(round(a.daily_budget_brl * 100))
    adset_name = a.adset_name or f"{a.name}_ADSET1"

    conversion = objective in DEFAULT_EVENT
    optimization_goal = a.optimization_goal or ("OFFSITE_CONVERSIONS" if conversion else "LANDING_PAGE_VIEWS")
    event_type = a.custom_event_type or DEFAULT_EVENT.get(objective)
    attribution_days = a.attribution_days
    if attribution_days is None:
        attribution_days = 7 if optimization_goal == "OFFSITE_CONVERSIONS" else 1

    promoted_object = None
    if optimization_goal == "OFFSITE_CONVERSIONS":
        if not a.pixel_id:
            print("ERRO: otimização por conversão exige Pixel. Defina META_PIXEL_ID no .env "
                  "ou passe --pixel-id.", file=sys.stderr)
            sys.exit(2)
        if not event_type:
            print("ERRO: informe --custom-event-type (ex.: PURCHASE).", file=sys.stderr)
            sys.exit(2)
        promoted_object = {"pixel_id": a.pixel_id, "custom_event_type": event_type.upper()}

    print(f">>> Criando campanha {a.name!r} ({objective}) em PAUSED...", file=sys.stderr)
    campaign = api("POST", f"{ACCT}/campaigns", {
        "name": a.name,
        "objective": objective,
        "status": "PAUSED",
        "buying_type": "AUCTION",
        "special_ad_categories": json.dumps([]),
        "is_adset_budget_sharing_enabled": "false",
    })
    campaign_id = campaign["id"]
    print(f"    campaign_id = {campaign_id}", file=sys.stderr)

    targeting = {
        "age_min": a.age_min,
        "age_max": a.age_max,
        "geo_locations": {"countries": [a.country.upper()], "location_types": ["home", "recent"]},
        "brand_safety_content_filter_levels": ["FACEBOOK_RELAXED", "AN_RELAXED"],
        "targeting_automation": {"advantage_audience": 0 if a.no_advantage_audience else 1},
    }
    if a.gender == "male":
        targeting["genders"] = [1]
    elif a.gender == "female":
        targeting["genders"] = [2]
    if a.locale:
        targeting["locales"] = a.locale

    adset_payload = {
        "name": adset_name,
        "campaign_id": campaign_id,
        "daily_budget": daily_cents,
        "billing_event": "IMPRESSIONS",
        "optimization_goal": optimization_goal,
        "destination_type": a.destination_type,
        "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
        "status": "PAUSED",
        "targeting": json.dumps(targeting, ensure_ascii=False),
    }
    if promoted_object:
        adset_payload["promoted_object"] = json.dumps(promoted_object)
    if not a.no_attribution:
        adset_payload["attribution_spec"] = json.dumps(
            [{"event_type": "CLICK_THROUGH", "window_days": attribution_days}]
        )
    if a.start_time:
        adset_payload["start_time"] = a.start_time

    goal_desc = optimization_goal + (f" / {promoted_object['custom_event_type']}" if promoted_object else "")
    print(f">>> Criando conjunto {adset_name!r} (R$ {a.daily_budget_brl:.2f}/dia, {goal_desc})...",
          file=sys.stderr)
    adset = api("POST", f"{ACCT}/adsets", adset_payload)
    adset_id = adset["id"]
    print(f"    adset_id    = {adset_id}", file=sys.stderr)

    print(json.dumps({"campaign_id": campaign_id, "adset_id": adset_id}, indent=2))


if __name__ == "__main__":
    main()
