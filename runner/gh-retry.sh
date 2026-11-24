#!/usr/bin/env bash
# Retry a gh call that reads the Actions API.
# 2026-11-24T19:11Z: one HTTP 500 from "gh run list" inside
# queue-snapshot.sh failed the step under set -e. Nothing queued the next
# pass, the kick workflow's schedule was being dropped, and the Kalshi chain
# stayed dead for over four hours. A transient 5xx must not end the chain.
#
# Usage: source runner/gh-retry.sh; out="$(gh_retry gh run list ...)"
# GH_RETRY_SLEEPS overrides the waits between attempts (tests use "0 0 0").

gh_retry() {
  local sleeps="${GH_RETRY_SLEEPS:-5 15 30}"
  local attempt=1 out wait
  for wait in $sleeps ""; do
    if out="$("$@")"; then
      printf '%s\n' "$out"
      return 0
    fi
    echo "attempt $attempt of $* failed" >&2
    attempt=$((attempt + 1))
    if [ -n "$wait" ]; then
      sleep "$wait"
    fi
  done
  return 1
}
