#!/usr/bin/env bash
# Render one env file per service into .run/env/, from config/app.env (not secret) and the
# SOPS files, giving each service only the secrets infra/secrets/scope.json allows it.
# The ops file is never rendered for any service.
source "$(dirname "$0")/lib.sh"
need sops "brew install sops"; need jq "brew install jq"
for f in local factory; do [[ -f "$(secret_path "$f")" ]] || die "$(secret_path "$f") is missing; run make setup"; done
mkdir -p .run/env && chmod 700 .run .run/env

# All secrets an app may see, as one JSON object (ops excluded on purpose).
all="$( { decrypt local; decrypt factory; } | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const o={}; for (const line of s.split("\n")) { const i=line.indexOf("=");
      if (i>0 && !line.startsWith("#")) o[line.slice(0,i)]=line.slice(i+1); }
    process.stdout.write(JSON.stringify(o)); });')"

# Derived values (database URLs built from passwords).
derived="$(jq -c --argjson all "$all" '.derived | with_entries(.value |= (
  reduce ($all|to_entries[]) as $e (.; gsub("\\$\\{" + $e.key + "\\}"; $e.value))))' infra/secrets/scope.json)"
merged="$(jq -c -n --argjson a "$all" --argjson d "$derived" '$a + $d')"

for svc in $(jq -r '.services | keys[]' infra/secrets/scope.json); do
  out=".run/env/$svc.env"
  umask 077
  {
    echo "# Rendered by make env for $svc. Do not edit; do not commit."
    jq -r --arg s "$svc" --argjson m "$merged" '.services[$s][] as $e |
      ($e | split("=")) as $p | ($p[0]) as $name | ($p[1] // $p[0]) as $src |
      if ($m | has($src)) then "\($name)=\($m[$src])" else error("unknown secret \($src) for \($s)") end' infra/secrets/scope.json
  } > "$out"
done
ok "rendered $(ls .run/env | wc -l | tr -d ' ') service env files into .run/env/ (mode 600)"
