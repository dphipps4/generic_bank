#!/usr/bin/env bash
# Installs Chrome for Testing's headless shell under .run/browser, for the browser tests on this
# machine and in CI. The Runner's container uses Debian's package instead (infra/docker).
source "$(dirname "$0")/lib.sh"
info "Headless Chromium"
out="$(npx --yes @puppeteer/browsers@2 install chrome-headless-shell@stable --path .run/browser 2>&1 | tail -1)"
bin="${out#* }"
[[ -x "$bin" ]] || die "install failed: $out"
ok "$bin"
