#!/usr/bin/env python3
"""
Sobe um anúncio CARROSSEL (1 anúncio com N cards) num conjunto existente.

Cobre:
  - Upload sequencial das imagens (multipart em Python; funciona com nomes que
    têm vírgula/parênteses, que quebram o curl -F)
  - Criativo com object_story_spec.link_data.child_attachments
  - url_tags com o padrão de UTM do projeto (link de destino limpo)
  - Anúncio em PAUSED (use --activate para criar ACTIVE)

Uso típico (rode `set -a; . ./.env; set +a` antes, na raiz do repositório):
  python3 upload_carousel_ad.py \\
    --adset-id <ADSET_ID> \\
    --link 'https://<APP_HOSTNAME>/<slug>' \\
    --message-file /tmp/copy.txt \\
    --headline 'Título do anúncio' \\
    --cta LEARN_MORE \\
    --image-dir ./carrossel \\
    --image-pattern '{i}.png' \\
    --first 1 --last 5 \\
    --ad-name 'carrossel-1'

Página e Instagram vêm de --page-id / --ig-user-id ou de META_PAGE_ID /
META_IG_USER_ID.

Saída: JSON no stdout com {creative_id, ad_id, image_hashes}.

Notas:
  - {i} em --image-pattern (e em --link-template, legado) é a posição do card.
  - --link usa a mesma URL limpa em todos os cards. Prefira isso a UTMs no link.
  - --url-tags tem como padrão o padrão de UTM do projeto; '' desliga.
  - NÃO ativa campanha nem conjunto.
  - multi_share_optimized=true (a Meta reordena cards por desempenho) e
    multi_share_end_card=true (card final com o perfil). Use --no-optimize e
    --no-end-card para desligar.
"""
import os, sys, json, glob, argparse
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
    link.add_argument("--link", help="URL de destino LIMPA, usada em todos os cards")
    link.add_argument("--link-template", help="URL com {i} por card (legado)")
    p.add_argument("--url-tags", default=DEFAULT_URL_TAGS,
                   help="Parâmetros de URL do criativo (padrão: padrão de UTM do projeto). "
                        "Passe '' para não enviar.")
    p.add_argument("--message", help="Texto principal (inline)")
    p.add_argument("--message-file", help="Arquivo com o texto principal")
    p.add_argument("--headline", required=True, help="Título (link_data.name)")
    p.add_argument("--cta", default="LEARN_MORE",
                   help="LEARN_MORE | SEE_DETAILS | SHOP_NOW | SIGN_UP | ...")
    p.add_argument("--image-dir", required=True)
    p.add_argument("--image-pattern", required=True, help="Glob com {i}. Ex.: '{i}.png'")
    p.add_argument("--first", type=int, default=1)
    p.add_argument("--last", type=int, required=True, help="Último índice (inclusivo)")
    p.add_argument("--ad-name", required=True)
    p.add_argument("--creative-name", default=None)
    p.add_argument("--no-optimize", action="store_true",
                   help="Desliga multi_share_optimized (mantém a ordem dos cards)")
    p.add_argument("--no-end-card", action="store_true",
                   help="Desliga multi_share_end_card")
    p.add_argument("--activate", action="store_true",
                   help="Cria o anúncio em ACTIVE. Sem isso, fica PAUSED.")
    p.add_argument("--default-link", default=None,
                   help="Link principal do post (padrão: o do primeiro card)")
    p.add_argument("--ids-out", help="Salva o JSON com todos os IDs neste caminho")
    return p.parse_args()


def resolve_message(a):
    if a.message_file:
        with open(a.message_file, encoding="utf-8") as f:
            return f.read().rstrip("\n")
    if a.message:
        return a.message
    print("ERRO: passe --message ou --message-file", file=sys.stderr); sys.exit(1)


def card_link(a, i):
    return a.link if a.link else a.link_template.format(i=i)


def main():
    a = parse_args()
    if not a.page_id:
        print("ERRO: defina META_PAGE_ID no .env ou passe --page-id.", file=sys.stderr)
        sys.exit(2)
    message = resolve_message(a)
    indices = list(range(a.first, a.last + 1))
    if len(indices) < 2:
        print("ERRO: carrossel precisa de pelo menos 2 cards", file=sys.stderr); sys.exit(1)
    if len(indices) > 10:
        print(f"AVISO: {len(indices)} cards; a Meta limita o carrossel a 10", file=sys.stderr)

    hashes = {}
    for i in indices:
        pat = os.path.join(a.image_dir, a.image_pattern.format(i=i))
        matches = sorted(glob.glob(pat))
        if not matches:
            print(f"ERRO: nenhum arquivo casa com {pat}", file=sys.stderr); sys.exit(1)
        path = matches[0]
        print(f">>> [{i}] upload: {os.path.basename(path)}", file=sys.stderr)
        hashes[i] = upload_image(path)
        print(f"        hash = {hashes[i]}", file=sys.stderr)

    child_attachments = [
        {
            "image_hash": hashes[i],
            "link": card_link(a, i),
            "call_to_action": {"type": a.cta, "value": {"link": card_link(a, i)}},
        }
        for i in indices
    ]
    default_link = a.default_link or card_link(a, indices[0])

    story = {
        "page_id": a.page_id,
        "link_data": {
            "link": default_link,
            "message": message,
            "name": a.headline,
            "child_attachments": child_attachments,
            "call_to_action": {"type": a.cta, "value": {"link": default_link}},
            "multi_share_optimized": not a.no_optimize,
            "multi_share_end_card": not a.no_end_card,
        },
    }
    if a.ig_user_id:
        story["instagram_user_id"] = a.ig_user_id

    creative_name = a.creative_name or f"{a.ad_name} - Carrossel {len(indices)} cards"
    creative_payload = {
        "name": creative_name,
        "object_story_spec": json.dumps(story, ensure_ascii=False),
    }
    if a.url_tags:
        creative_payload["url_tags"] = a.url_tags

    print(f">>> Criando criativo {creative_name!r}...", file=sys.stderr)
    creative = api("POST", f"{ACCT}/adcreatives", creative_payload)
    creative_id = creative["id"]
    print(f"    creative_id = {creative_id}", file=sys.stderr)

    status = "ACTIVE" if a.activate else "PAUSED"
    print(f">>> Criando anúncio {a.ad_name!r} ({status})...", file=sys.stderr)
    ad = api("POST", f"{ACCT}/ads", {
        "name": a.ad_name,
        "adset_id": a.adset_id,
        "creative": json.dumps({"creative_id": creative_id}),
        "status": status,
    })
    ad_id = ad["id"]
    print(f"    ad_id       = {ad_id}", file=sys.stderr)

    out = {
        "creative_id": creative_id,
        "ad_id": ad_id,
        "ad_status": status,
        "url_tags": a.url_tags or None,
        "image_hashes": hashes,
        "cards": len(indices),
    }
    if a.ids_out:
        with open(a.ids_out, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=2, ensure_ascii=False)
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
