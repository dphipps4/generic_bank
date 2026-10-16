#!/usr/bin/env bash
# Installs Chrome for Testing (full Chrome, run in its modern headless mode) under .run/browser, for
# the browser tests on this machine and in CI. Full Chrome, not the headless shell: the identity
# extension needs it (plan, §5). The Runner's container uses Debian's chromium (infra/docker).
source "$(dirname "$0")/lib.sh"
info "Chrome for Testing"
out="$(npx --yes @puppeteer/browsers@3 install chrome@stable --path .run/browser 2>&1)" || die "install failed: $out"
# Found on disk, not read from the installer's output. (Version 2 of the installer exits before it
# finishes unpacking under Node 26, leaving a Chrome that dies on launch; version 3 does not.)
bin="$(find .run/browser/chrome -type f \( -name chrome -o -name 'Google Chrome for Testing' \) -perm -u+x 2>/dev/null | head -1)"
[[ -n "$bin" ]] || die "install failed: no Chrome under .run/browser ($out)"
ok "$bin"
