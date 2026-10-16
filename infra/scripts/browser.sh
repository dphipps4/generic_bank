#!/usr/bin/env bash
# Installs Chrome for Testing (full Chrome, run in its modern headless mode) under .run/browser, for
# the browser tests on this machine and in CI. Full Chrome, not the headless shell: the identity
# extension needs it (plan, §E.8). The Runner's container uses Debian's chromium (infra/docker).
source "$(dirname "$0")/lib.sh"
info "Chrome for Testing"
out="$(npx --yes @puppeteer/browsers@2 install chrome@stable --path .run/browser 2>&1)" || die "install failed: $out"
# Found on disk rather than read from the installer's output, which npm 11 can swallow on a first run.
bin="$(find .run/browser/chrome -type f \( -name chrome -o -name 'Google Chrome for Testing' \) -perm -u+x 2>/dev/null | head -1)"
[[ -n "$bin" ]] || die "install failed: no Chrome under .run/browser ($out)"
ok "$bin"
