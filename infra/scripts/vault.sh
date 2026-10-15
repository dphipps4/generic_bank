#!/usr/bin/env bash
# Bring Vault to a usable state: initialize it once, unseal it on every start, and keep its
# root token and unseal key only in the operator-only SOPS file.
#   vault.sh ensure | status
source "$(dirname "$0")/lib.sh"
COMPOSE=(docker compose -f infra/compose/compose.yaml --env-file config/app.env)
[[ -f config/local.env ]] && COMPOSE+=(--env-file config/local.env)
COMPOSE+=(-p "${GB_PROJECT:-generic-bank}")
v() { "${COMPOSE[@]}" exec -T vault vault "$@"; }

status_json() { v status -format=json 2>/dev/null || true; }

case "${1:-ensure}" in
  status)
    status_json | jq '{initialized, sealed, version}'
    ;;
  ensure)
    st="$(status_json)"
    [[ -n "$st" ]] || die "Vault is not answering; is the vault container running?"
    if [[ "$(jq -r .initialized <<<"$st")" != "true" ]]; then
      info "Initializing Vault (once)"
      init="$(v operator init -key-shares=1 -key-threshold=1 -format=json)"
      root="$(jq -r .root_token <<<"$init")"; key="$(jq -r .unseal_keys_b64[0] <<<"$init")"
      for pair in "VAULT_ROOT_TOKEN:$root" "VAULT_UNSEAL_KEY:$key"; do
        printf '%s' "${pair#*:}" | json_string \
          | sops set --value-stdin "$(secret_path ops)" "[\"${pair%%:*}\"]"
      done
      unset init root key
      ok "root token and unseal key stored in $(secret_path ops) (operator-only)"
      st="$(status_json)"
    fi
    if [[ "$(jq -r .sealed <<<"$st")" == "true" ]]; then
      key="$(decrypt ops | grep '^VAULT_UNSEAL_KEY=' | cut -d= -f2-)"
      [[ -n "$key" ]] || die "Vault is sealed and no unseal key is stored; see make vault-status"
      v operator unseal "$key" >/dev/null; unset key
      ok "Vault unsealed"
    else
      ok "Vault is unsealed"
    fi
    root="$(decrypt ops | grep '^VAULT_ROOT_TOKEN=' | cut -d= -f2-)"
    if ! "${COMPOSE[@]}" exec -T -e VAULT_TOKEN="$root" vault vault secrets list -format=json | jq -e '."secret/"' >/dev/null 2>&1; then
      "${COMPOSE[@]}" exec -T -e VAULT_TOKEN="$root" vault vault secrets enable -path=secret kv-v2 >/dev/null
      ok "enabled the key-value store at secret/"
    fi
    unset root
    ;;
  *) die "usage: vault.sh ensure|status" ;;
esac
