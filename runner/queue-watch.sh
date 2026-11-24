#!/usr/bin/env bash
# Start the next meme-stop pass unless one is already queued or running.
# Same decision as the Kalshi chain: another active run means skip.
# Pass --backoff to wait before a retry after a failed pass.
set -euo pipefail

if [ "${1:-}" = "--backoff" ]; then
  echo "previous watch failed; waiting 60s before a retry"
  sleep 60
fi

repo="${GITHUB_REPOSITORY:?}"
self="${GITHUB_RUN_ID:?}"
# shellcheck source=runner/gh-retry.sh
source "$(dirname "$0")/gh-retry.sh"
# A list that still fails after retries falls through to a dispatch. The
# workflow's concurrency group (cancel-in-progress: false) makes a duplicate
# wait, so a spare run costs a few seconds and a missed one costs the chain.
if raw="$(gh_retry gh run list --workflow meme-watch.yml --repo "$repo" --limit 30 --json databaseId,status,url)"; then
  choice="$(printf '%s' "$raw" | node runner/queue-next.mjs "$self")"
else
  echo "run list failed after retries; dispatching anyway"
  choice="dispatch"
fi
echo "decision=$choice"
if [ "$choice" = "skip" ]; then
  echo "a watch run is already queued or running"
  exit 0
fi
if [ "$choice" != "dispatch" ]; then
  echo "unexpected decision: $choice"
  exit 1
fi

url=""
for attempt in 1 2 3; do
  if out="$(gh workflow run meme-watch.yml --ref main --repo "$repo" 2>&1)"; then
    echo "$out"
    url="$(printf '%s\n' "$out" | grep -oE 'actions/runs/[0-9]+' | head -1 || true)"
    if [ -n "$url" ]; then
      break
    fi
    echo "dispatch attempt $attempt returned no run URL"
  else
    echo "dispatch attempt $attempt failed"
    echo "$out"
  fi
  sleep 5
done
if [ -z "$url" ]; then
  echo "workflow_dispatch failed"
  exit 1
fi

rid="${url##*/}"
for _ in 1 2 3 4 5 6 7 8; do
  if gh run view "$rid" --repo "$repo" --json status,url --jq '"\(.status) \(.url)"'; then
    exit 0
  fi
  sleep 3
done
echo "dispatched run $rid never became visible"
exit 1
