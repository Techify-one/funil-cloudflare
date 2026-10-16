"""
Helpers da Marketing API da Meta. Sem dependência externa (urllib da stdlib).

Lê credenciais e IDs de variáveis de ambiente (carregue antes com
`set -a; . ./.env; set +a` na raiz do repositório):
  META_ACCESS_TOKEN   token de usuário do sistema com ads_management (obrigatório)
  META_AD_ACCOUNT_ID  conta de anúncios com prefixo act_ (obrigatório)
  META_API_VERSION    opcional, padrão v25.0
  META_PIXEL_ID, META_PAGE_ID, META_IG_USER_ID  usados como padrão pelos scripts

O token nunca é impresso: mensagens de erro passam por redact().

Uso:
    from meta_api import api, upload_image, ACCT, DEFAULT_URL_TAGS

    res = api("POST", f"{ACCT}/campaigns", {"name": "X", "objective": "OUTCOME_SALES", ...})
    h = upload_image("/caminho/1.png")
"""
import os, json, sys, time, uuid, urllib.request, urllib.parse, urllib.error

# Padrão de UTM do projeto. Vai SEMPRE no campo url_tags do criativo; o link
# de destino fica limpo (sem query string). A Meta troca as macros na entrega.
DEFAULT_URL_TAGS = (
    "utm_source={{site_source_name}}&utm_medium=paid&utm_campaign={{campaign.name}}"
    "&utm_content={{adset.name}}&utm_term={{ad.name}}"
    "&meta_campaign_id={{campaign.id}}&meta_adset_id={{adset.id}}&meta_ad_id={{ad.id}}"
)


def _require(name):
    value = (os.environ.get(name) or "").strip()
    if not value:
        print(f"ERRO: variável {name} ausente. Rode `set -a; . ./.env; set +a` na raiz do "
              f"repositório e confira se {name} está preenchida no .env.", file=sys.stderr)
        sys.exit(2)
    return value


def normalize_account(value):
    value = (value or "").strip()
    if not value:
        return value
    return value if value.startswith("act_") else f"act_{value}"


TOKEN = _require("META_ACCESS_TOKEN")
ACCT = normalize_account(_require("META_AD_ACCOUNT_ID"))
VER = os.environ.get("META_API_VERSION") or "v25.0"
GRAPH = f"https://graph.facebook.com/{VER}"


def env_default(name):
    """Valor opcional do ambiente (string vazia vira None)."""
    value = (os.environ.get(name) or "").strip()
    return value or None


def redact(text):
    """Remove o token de qualquer texto antes de imprimir."""
    text = str(text)
    if TOKEN:
        text = text.replace(TOKEN, "***")
        text = text.replace(urllib.parse.quote(TOKEN, safe=""), "***")
    return text


def api(method, path, payload=None, raise_on_error=True):
    """GET/POST/DELETE genérico. Retorna dict JSON parseado.
    payload: dict; valores complexos (dict/list) DEVEM vir já em json.dumps().
    """
    payload = dict(payload or {})
    payload.setdefault("access_token", TOKEN)
    url = f"{GRAPH}/{path}"
    if method in ("GET", "DELETE"):
        url += "?" + urllib.parse.urlencode(payload)
        req = urllib.request.Request(url, method=method)
    else:
        data = urllib.parse.urlencode(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = redact(e.read().decode("utf-8", errors="replace"))
        msg = f"HTTP {e.code} em {method} /{path}\n{body}"
        if raise_on_error:
            print(msg, file=sys.stderr)
            sys.exit(1)
        try:
            return {"error": json.loads(body)}
        except ValueError:
            return {"error": {"message": msg}}
    except urllib.error.URLError as e:
        msg = f"Falha de rede em {method} /{path}: {redact(e.reason)}"
        if raise_on_error:
            print(msg, file=sys.stderr)
            sys.exit(1)
        return {"error": {"message": msg}}


def upload_image(path, sleep_after=0.7):
    """Upload de imagem via multipart. Retorna o image_hash. Tolera nomes com
    vírgulas/parênteses (problema comum com curl -F)."""
    boundary = uuid.uuid4().hex
    sep = f"--{boundary}".encode()
    end = f"--{boundary}--".encode()
    fname = os.path.basename(path)
    lower = fname.lower()
    if lower.endswith(".png"):
        ctype = "image/png"
    elif lower.endswith(".gif"):
        ctype = "image/gif"
    else:
        ctype = "image/jpeg"
    with open(path, "rb") as f:
        body = f.read()

    parts = [
        sep,
        b'Content-Disposition: form-data; name="access_token"', b"", TOKEN.encode(),
        sep,
        f'Content-Disposition: form-data; name="filename"; filename="{fname}"'.encode(),
        f"Content-Type: {ctype}".encode(), b"", body,
        end,
    ]
    payload = b"\r\n".join(parts)
    req = urllib.request.Request(
        f"{GRAPH}/{ACCT}/adimages",
        data=payload,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            res = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code} no upload de {fname}: {redact(e.read().decode('utf-8', 'replace'))}",
              file=sys.stderr)
        sys.exit(1)
    h = next(iter(res["images"].values()))["hash"]
    if sleep_after:
        time.sleep(sleep_after)
    return h


def validate_token():
    """Valida o token. Mostra usuário, app e scopes (nunca o token); sai se
    inválido ou sem ads_management."""
    me = api("GET", "me", {"fields": "id,name"})
    dbg = api("GET", "debug_token", {"input_token": TOKEN, "access_token": TOKEN})["data"]
    if not dbg.get("is_valid"):
        print("ERRO: token inválido ou expirado.", file=sys.stderr)
        sys.exit(1)
    scopes = dbg.get("scopes", [])
    if "ads_management" not in scopes:
        print(f"ERRO: token sem scope ads_management. scopes={scopes}", file=sys.stderr)
        sys.exit(1)
    print(f"Token OK: usuário {me.get('name')} ({me.get('id')}), app {dbg.get('application')}, "
          f"expira={dbg.get('expires_at') or 'nunca'}, scopes={','.join(scopes)}")
    return me, dbg


if __name__ == "__main__":
    # Smoke test: python3 meta_api.py
    validate_token()
    res = api("GET", f"{ACCT}/campaigns", {"fields": "id,name,status,daily_budget", "limit": "5"})
    print("\nÚltimas campanhas:")
    for c in res.get("data", []):
        print(f"  {c['id']:20} {c['status']:10} {c['name']}")
