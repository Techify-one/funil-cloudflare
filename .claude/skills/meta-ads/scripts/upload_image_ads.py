#!/usr/bin/env python3
"""
Sobe N anúncios SINGLE-IMAGE separados num mesmo conjunto (um criativo + um
anúncio por imagem).

Diferente de upload_carousel_ad.py: aqui cada imagem vira UM ANÚNCIO
independente, o que permite medir cada criativo separadamente.

Padrão de rastreamento do projeto:
  - O link de destino fica LIMPO (sem query string). Ex.: https://seudominio/pagina
  - As UTMs vão no campo url_tags do criativo. Padrão (--url-tags):
      utm_source={{site_source_name}}&utm_medium=paid&utm_campaign={{campaign.name}}
      &utm_content={{adset.name}}&utm_term={{ad.name}}&meta_campaign_id={{campaign.id}}
      &meta_adset_id={{adset.id}}&meta_ad_id={{ad.id}}
  - O nome do anúncio deve ser o número do arquivo ('{i}' -> 1, 2, 3...), que
    vira utm_term pela macro {{ad.name}}.

Uso típico (rode `set -a; . ./.env; set +a` antes, na raiz do repositório):
  python3 upload_image_ads.py \\
    --adset-id <ADSET_ID> \\
    --link 'https://<APP_HOSTNAME>/<slug>' \\
    --message-file /tmp/copy.txt \\
    --headline 'Título do anúncio' \\
    --cta LEARN_MORE \\
    --image-dir ./criativos \\
    --image-pattern '{i}.png' \\
    --first 1 --last 5 \\
    --ad-name-template '{i}'

Página e Instagram vêm de --page-id / --ig-user-id ou de META_PAGE_ID /
META_IG_USER_ID. Sem Instagram, o anúncio usa a identidade da página.

Saída: JSON no stdout com a lista {i, ad_id, creative_id, image_hash}.

Bodies/títulos rotativos (asset_feed_spec):
  --bodies-file (parágrafos separados por linha em branco) e --titles-file
  (um por linha). Com eles, cada anúncio recebe asset_feed_spec com
  optimization_type=DEGREES_OF_FREEDOM em vez de message/name fixos.

Notas:
  - --link-template aceita {i} (legado). Prefira --link limpo + url_tags.
  - --activate cria os anúncios em ACTIVE. Sem ele, ficam PAUSED (recomendado).
  - NÃO ativa campanha nem conjunto.
  - Pausas: 0.7 s por upload, 1.0 s entre anúncios. Para lotes > 20, aumente
    --sleep-between-ads ou use a Batch API.
"""
import os, sys, json, glob, time, argparse
from meta_api import api, upload_image, ACCT, DEFAULT_URL_TAGS, env_default


def parse_args():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--adset-id", required=True)
    p.add_argument("--page-id", default=env_default("META_PAGE_ID"),
                   help="Página do Facebook (padrão: META_PAGE_ID)")
    p.add_argument("--ig-user-id", default=env_default("META_IG_USER_ID"),
                   help="Conta do Instagram (padrão: META_IG_USER_ID; opcional)")
    link = p.add_mutually_exclusive_group(required=True)
    link.add_argument("--link", help="URL de destino LIMPA, igual para todos os anúncios")
    link.add_argument("--link-template", help="URL com {i} (legado; evite UTMs aqui)")
    p.add_argument("--url-tags", default=DEFAULT_URL_TAGS,
                   help="Parâmetros de URL do criativo (padrão: padrão de UTM do projeto). "
                        "Passe '' para não enviar.")
    p.add_argument("--message", help="Texto principal inline. Ignorado com --bodies-file.")
    p.add_argument("--message-file", help="Arquivo com o texto principal")
    p.add_argument("--headline", help="Título (link_data.name). Ignorado com --titles-file.")
    p.add_argument("--description", default=None, help="Descrição opcional (link_data.description)")
    p.add_argument("--bodies-file",
                   help="Vários textos separados por linha em branco (ativa asset_feed_spec)")
    p.add_argument("--titles-file", help="Vários títulos, um por linha (ativa asset_feed_spec)")
    p.add_argument("--cta", default="LEARN_MORE")
    p.add_argument("--image-dir", required=True)
    p.add_argument("--image-pattern", required=True,
                   help="Glob com {i}. Ex.: '{i}.png' ou '{i}.*'")
    p.add_argument("--first", type=int, default=1)
    p.add_argument("--last", type=int, required=True)
    p.add_argument("--ad-name-template", default="{i}",
                   help="Nome do anúncio com {i} (padrão '{i}', vira utm_term)")
    p.add_argument("--creative-name-template", default=None,
                   help="Nome do criativo com {i} (padrão: igual ao anúncio)")
    p.add_argument("--activate", action="store_true")
    p.add_argument("--sleep-between-ads", type=float, default=1.0)
    p.add_argument("--ids-out", help="Salva o JSON com todos os IDs neste caminho")
    return p.parse_args()


def load_text(inline, file_path):
    if file_path:
        with open(file_path, encoding="utf-8") as f:
            return f.read().rstrip("\n")
    return inline or None


def load_blocks(file_path):
    if not file_path:
        return None
    with open(file_path, encoding="utf-8") as f:
        raw = f.read().strip()
    return [b.strip() for b in raw.split("\n\n") if b.strip()]


def main():
    a = parse_args()
    if not a.page_id:
        print("ERRO: defina META_PAGE_ID no .env ou passe --page-id.", file=sys.stderr)
        sys.exit(2)
    if a.link and "?" in a.link and a.url_tags:
        print("AVISO: o link tem query string e url_tags também será enviado; a Meta concatena "
              "os dois. O padrão do projeto é link limpo + url_tags.", file=sys.stderr)

    bodies = load_blocks(a.bodies_file)
    titles = None
    if a.titles_file:
        with open(a.titles_file, encoding="utf-8") as f:
            titles = [l.strip() for l in f if l.strip()]

    use_asset_feed = bool(bodies and titles)
    message = load_text(a.message, a.message_file)
    headline = a.headline

    if not use_asset_feed:
        if not message:
            print("ERRO: passe --message/--message-file (ou --bodies-file + --titles-file)",
                  file=sys.stderr); sys.exit(1)
        if not headline:
            print("ERRO: passe --headline (ou --bodies-file + --titles-file)", file=sys.stderr)
            sys.exit(1)

    indices = list(range(a.first, a.last + 1))
    creative_name_tpl = a.creative_name_template or a.ad_name_template

    results = []
    for i in indices:
        pat = os.path.join(a.image_dir, a.image_pattern.format(i=i))
        matches = sorted(glob.glob(pat))
        if not matches:
            print(f"ERRO: nenhum arquivo casa com {pat}", file=sys.stderr); sys.exit(1)
        path = matches[0]
        print(f">>> [{i}] upload: {os.path.basename(path)}", file=sys.stderr)
        h = upload_image(path)
        print(f"        hash = {h}", file=sys.stderr)

        link = a.link if a.link else a.link_template.format(i=i)
        link_data = {
            "link": link,
            "image_hash": h,
            "call_to_action": {"type": a.cta, "value": {"link": link}},
        }
        if not use_asset_feed:
            link_data["message"] = message
            link_data["name"] = headline
            if a.description:
                link_data["description"] = a.description

        story = {"page_id": a.page_id, "link_data": link_data}
        if a.ig_user_id:
            story["instagram_user_id"] = a.ig_user_id

        creative_payload = {
            "name": creative_name_tpl.format(i=i),
            "object_story_spec": json.dumps(story, ensure_ascii=False),
        }
        if a.url_tags:
            creative_payload["url_tags"] = a.url_tags
        if use_asset_feed:
            creative_payload["asset_feed_spec"] = json.dumps({
                "bodies": [{"text": b} for b in bodies],
                "titles": [{"text": t} for t in titles],
                "descriptions": [{"text": a.description or ""}],
                "optimization_type": "DEGREES_OF_FREEDOM",
            }, ensure_ascii=False)

        creative = api("POST", f"{ACCT}/adcreatives", creative_payload)
        cid = creative["id"]
        print(f"        creative_id = {cid}", file=sys.stderr)

        status = "ACTIVE" if a.activate else "PAUSED"
        ad = api("POST", f"{ACCT}/ads", {
            "name": a.ad_name_template.format(i=i),
            "adset_id": a.adset_id,
            "creative": json.dumps({"creative_id": cid}),
            "status": status,
        })
        aid = ad["id"]
        print(f"        ad_id       = {aid} ({status})", file=sys.stderr)

        results.append({"i": i, "ad_name": a.ad_name_template.format(i=i),
                        "ad_id": aid, "creative_id": cid, "image_hash": h})

        if i != indices[-1]:
            time.sleep(a.sleep_between_ads)

    out = {
        "adset_id": a.adset_id,
        "ads_status": "ACTIVE" if a.activate else "PAUSED",
        "asset_feed_used": use_asset_feed,
        "url_tags": a.url_tags or None,
        "count": len(results),
        "ads": results,
    }
    if a.ids_out:
        with open(a.ids_out, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=2, ensure_ascii=False)
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
