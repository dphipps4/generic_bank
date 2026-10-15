#!/usr/bin/env bash
# Check this machine can run the stack, and say exactly what to change if not.
source "$(dirname "$0")/lib.sh"
info "Tools"
need docker "Install Docker Desktop or OrbStack."
docker compose version >/dev/null 2>&1 || die "docker compose v2 is missing."
need sops "brew install sops"
need age-keygen "brew install age"
need jq "brew install jq"
need openssl "It ships with macOS."
need node "Install Node 22 (nvm install 22)."
node -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)' || die "Node 22 or newer is needed (found $(node -v))."
ok "docker, compose, sops, age, jq, openssl, node $(node -v)"

info "Docker"
docker info >/dev/null 2>&1 || die "Docker is not running. Start Docker Desktop or OrbStack."
mem=$(docker info --format '{{.MemTotal}}')
gib=$(awk "BEGIN{printf \"%.1f\", $mem/1073741824}")
if awk "BEGIN{exit !($mem < 4500000000)}"; then
  warn "Docker has ${gib} GiB. The base stack needs about 2.5 GiB and the factory about 4.3 GiB: give Docker 5 GiB."
else
  ok "Docker has ${gib} GiB (5 GiB recommended on an 8 GB laptop)"
fi
free=$(df -k . | awk 'NR==2{print int($4/1048576)}')
[[ "$free" -ge 15 ]] && ok "${free} GiB of disk free" || warn "only ${free} GiB of disk free; images and data want about 15 GiB"

info "Ports"
busy=0
set -a; source config/app.env; set +a
for p in $API_PORT $CONSOLE_PORT $BANK_GENERIC_PORT $BANK_EXAMPLE_PORT $BANK_INBOX_PORT; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && ! docker ps --format '{{.Ports}}' | grep -q ":$p->"; then
    warn "port $p is in use by something other than this stack"; busy=1
  fi
done
[[ $busy == 0 ]] && ok "ports $API_PORT, $CONSOLE_PORT, $BANK_GENERIC_PORT, $BANK_EXAMPLE_PORT, $BANK_INBOX_PORT are free"
