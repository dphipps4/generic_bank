#!/usr/bin/env bash
# Check this Mac can build and run the stack, with explicit versions, and fail saying exactly what
# to install or change. Everything else (sops, age, jq, the plan renderer, Postgres, Chromium...)
# runs in containers.
#
#   requirements.sh          to build and run the stack
#   requirements.sh --dev    also to develop: Node for the tests, the type checker and the linter
source "$(dirname "$0")/lib.sh"
DEV=0; [[ "${1:-}" == "--dev" ]] && DEV=1
failed=0
bad() { echo "  ${R}✗${N} $*"; failed=1; }

# version_ge 27.3.1 27.0  ->  true when the first is at least the second
version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }

info "macOS"
if [[ "$(uname -s)" == "Darwin" ]]; then
  mac="$(sw_vers -productVersion)"
  version_ge "$mac" 14.0 && ok "macOS $mac (14 or newer)" || bad "macOS $mac: 14 (Sonoma) or newer is needed"
else
  warn "this is $(uname -s), not macOS: the stack is made for a Mac; Linux works if Docker does"
fi

info "Tools on the Mac"
if command -v git >/dev/null; then
  g="$(git --version | awk '{print $3}')"
  version_ge "$g" 2.39 && ok "git $g (2.39 or newer)" || bad "git $g: 2.39 or newer is needed"
else bad "git is missing: install it from git-scm.com"; fi
if command -v just >/dev/null; then
  j="$(just --version | awk '{print $2}')"
  version_ge "$j" 1.59 && ok "just $j (1.59 or newer)" || bad "just $j: 1.59 or newer is needed (infra/scripts/bootstrap.sh)"
else bad "just is missing: infra/scripts/bootstrap.sh installs it"; fi

info "Docker"
if ! command -v docker >/dev/null; then
  bad "Docker is missing: install Docker Desktop (docker.com/products/docker-desktop), then start it"
elif ! docker info >/dev/null 2>&1; then
  bad "Docker is installed but not running: open Docker Desktop"
else
  engine="$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
  version_ge "$engine" 27.0 && ok "Docker Engine $engine (27 or newer)" \
    || bad "Docker Engine $engine: 27 or newer is needed (update Docker Desktop)"
  compose="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
  if [[ -z "$compose" ]]; then bad "Docker Compose v2 is missing (update Docker Desktop)"
  else version_ge "$compose" 2.29 && ok "Docker Compose $compose (2.29 or newer)" \
    || bad "Docker Compose $compose: 2.29 or newer is needed (update Docker Desktop)"; fi
  docker buildx version >/dev/null 2>&1 && ok "BuildKit (docker buildx)" \
    || bad "docker buildx is missing (update Docker Desktop)"
  mem=$(docker info --format '{{.MemTotal}}')
  gib=$(awk "BEGIN{printf \"%.1f\", $mem/1073741824}")
  if awk "BEGIN{exit !($mem < 4500000000)}"; then
    bad "Docker has ${gib} GiB of memory: give it 5 GB (Docker Desktop, Settings, Resources)"
  else
    ok "Docker has ${gib} GiB of memory (5 GB on an 8 GB laptop)"
  fi
  free=$(df -k . | awk 'NR==2{print int($4/1048576)}')
  [[ "$free" -ge 15 ]] && ok "${free} GiB of disk free (15 or more)" \
    || bad "only ${free} GiB of disk free: images and data need about 15 GiB"
fi

if [[ $DEV == 1 ]]; then
  info "To develop"
  if command -v node >/dev/null; then
    n="$(node --version | sed 's/^v//')"
    if version_ge "$n" 26.0; then ok "Node $n (26 or newer)"
    else bad "Node $n: Node 26 or newer is needed: the Node 26 installer from nodejs.org"; fi
    p="$(npm --version 2>/dev/null)"
    version_ge "${p:-0}" 10.0 && ok "npm $p (10 or newer)" || bad "npm ${p:-missing}: 10 or newer comes with Node 26"
  else
    bad "Node is missing: the Node 26 installer from nodejs.org"
  fi
fi

info "Ports"
busy=0
set -a; source config/app.env; [[ -f config/local.env ]] && source config/local.env; set +a
for p in $API_PORT $CONSOLE_PORT $BANK_GENERIC_PORT $BANK_EXAMPLE_PORT $BANK_INBOX_PORT; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && ! docker ps --format '{{.Ports}}' 2>/dev/null | grep -q ":$p->"; then
    warn "port $p is in use by something other than this stack"; busy=1
  fi
done
[[ $busy == 0 ]] && ok "ports $API_PORT, $CONSOLE_PORT, $BANK_GENERIC_PORT, $BANK_EXAMPLE_PORT, $BANK_INBOX_PORT are free"

echo
if [[ $failed == 1 ]]; then
  die "Some requirements are not met. Fix the lines marked ✗ and run this again."
fi
ok "${B}Every requirement is met.${N}"
