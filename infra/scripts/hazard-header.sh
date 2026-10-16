#!/usr/bin/env bash
# Print a signed X-Hazards value that forces the named hazards at a bank, for curl:
#   curl -H "X-Hazards: $(make -s hazard-header HAZARDS=late-rows)" http://localhost:8081/corelink/
# The bank obeys it only while HAZARDS_FORCEABLE is true (config/app.env). The value is the sorted
# names, a semicolon, and their HMAC-SHA256 under HAZARD_HMAC_KEY.
source "$(dirname "$0")/lib.sh"
in_tools "$@"

[[ -n "${1:-}" ]] || die "usage: make hazard-header HAZARDS=late-rows,promo"
key="$(decrypt local | grep '^HAZARD_HMAC_KEY=' | cut -d= -f2-)"
[[ -n "$key" ]] || die "no HAZARD_HMAC_KEY in the local secrets; run make setup"
list="$(tr ',' '\n' <<<"$1" | sed '/^$/d' | sort | paste -sd, -)"
sig="$(printf '%s' "$list" | openssl dgst -sha256 -hmac "$key" -r | cut -d' ' -f1)"
printf '%s;%s\n' "$list" "$sig"
