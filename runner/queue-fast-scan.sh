#!/usr/bin/env bash
# Start the early fast scan unless one is already queued or running.
# The Kalshi chain calls this. fast-scan.yml's concurrency group is the
# other lock: cancel-in-progress is false, so a second start waits.
set -euo pipefail

repo="${GITHUB_REPOSITORY:?}"
self="${GITHUB_RUN_ID:?}"
raw="$(gh run list --workflow fast-scan.yml --repo "$repo" --limit 30 --json databaseId,status,url)"
choice="$(printf '%s' "$raw" | node runner/queue-next.mjs "$self")"
echo "decision=$choice"
if [ "$choice" = "skip" ]; then
  echo "a fast scan is already queued or running"
  exit 0
fi
if [ "$choice" != "dispatch" ]; then
  echo "unexpected decision: $choice"
  exit 1
fi

url=""
for attempt in 1 2 3; do
  if out="$(gh workflow run fast-scan.yml --ref main --repo "$repo" 2>&1)"; then
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
