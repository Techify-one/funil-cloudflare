#!/usr/bin/env bash
# Varredura de segredos antes de commit/push. Exige gitleaks no PATH.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks não encontrado. Instale: https://github.com/gitleaks/gitleaks#installing" >&2
  exit 1
fi
# Varre só o que pode ir para o git (o .env local é ignorado de propósito).
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git ls-files -co --exclude-standard -z | grep -zv '^node_modules/' | tar --null -T - -cf - | tar -xf - -C "$TMP"
gitleaks detect --no-git --source "$TMP" --config .gitleaks.toml --redact --no-banner
if git rev-parse HEAD >/dev/null 2>&1; then
  gitleaks git --config .gitleaks.toml --redact --no-banner
fi
# Lista local opcional de termos proibidos (um por linha), fora do repositório.
if [[ -n "${NEUTRALITY_DENYLIST:-}" && -f "$NEUTRALITY_DENYLIST" ]]; then
  if git ls-files -co --exclude-standard | grep -v '^node_modules/' | xargs grep -n -i -F -f "$NEUTRALITY_DENYLIST" 2>/dev/null; then
    echo "Termos proibidos encontrados (lista em NEUTRALITY_DENYLIST)." >&2
    exit 1
  fi
fi
echo "Varredura limpa."
