#!/usr/bin/env bash
# One line saying whether the factory runs live, and on which provider, or in mock mode: the last
# thing just setup and just up print. Names only; no value is ever shown.
source "$(dirname "$0")/lib.sh"
set_keys="$(decrypt factory 2>/dev/null | grep -E '^(ANTHROPIC|OPENAI)_API_KEY=.' | cut -d= -f1 || true)"
case "$set_keys" in
  *ANTHROPIC_API_KEY*) echo "  ${G}Factory: live, on Claude${N} (ANTHROPIC_API_KEY is set)" ;;
  *OPENAI_API_KEY*) echo "  ${G}Factory: live, on OpenAI${N} (OPENAI_API_KEY is set)" ;;
  *)
    echo
    echo "  ${R}✗ The factory needs a model key to work. Set ANTHROPIC_API_KEY or OPENAI_API_KEY:${N}"
    echo "  ${R}  copy your key, then run: just secret-set factory ANTHROPIC_API_KEY${N}"
    ;;
esac
