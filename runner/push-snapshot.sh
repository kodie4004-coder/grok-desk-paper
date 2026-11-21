#!/usr/bin/env bash
# Commit the paper snapshot and push it to main.
# Run 44676854746 (2026-11-20T04:48:34Z) checked out main, committed, and
# was rejected: the remote had moved (a pull request landed) and a plain
# git push is not a fast-forward. The job then exited before it could
# dispatch the next pass, and the chain stopped.
# Fetch, rebase onto origin/main, and retry with backoff. A conflict keeps
# this run's snapshot files. The caller still dispatches the next run if
# this script exits non-zero.
set -euo pipefail

MODE="${SNAP_MODE:-snapshot}"
if [ "$MODE" = "fast" ]; then
  git config user.name "fast-scan"
  git config user.email "fast-scan@users.noreply.github.com"
  COMMIT_MSG="Update the early-entry fast scan"
else
  git config user.name "kalshi-snapshot"
  git config user.email "kalshi-snapshot@users.noreply.github.com"
  COMMIT_MSG="Update the Kalshi paper snapshot and journal"
fi

add_existing() {
  local f
  for f in "$@"; do
    if [ -e "$f" ]; then
      git add -- "$f"
    fi
  done
}

if [ "$MODE" = "fast" ]; then
  add_existing \
    data/early-board.json \
    data/early-log.jsonl \
    data/early-log-summary.json \
    data/jev-cache.json \
    data/jev-calls.json \
    data/phone-alerts.json \
    data/fast-scan.json
else
  add_existing \
    data/kalshi-15m.json \
    data/journal.jsonl \
    data/journal-open.json \
    data/journal-quotes.json \
    data/lessons.json \
    data/brain.json \
    data/filings.json \
    LESSONS.md \
    data/morning.json \
    data/heartbeat.json \
    data/alloc-curve.json \
    data/focus.json \
    data/meme-board.json \
    data/meme-open.json \
    data/meme-journal.jsonl \
    data/meme-stops.json \
    data/meme-watch.json \
    data/research-upgrades.json \
    data/jev-cache.json \
    data/jev-calls.json \
    data/phone-alerts.json \
    data/fast-scan.json \
    data/early-board.json \
    data/early-log.jsonl \
    data/early-log-summary.json
fi

if git diff --cached --quiet; then
  echo "snapshot unchanged"
  exit 0
fi

git commit -m "$COMMIT_MSG"

rebase_onto_main() {
  git fetch --depth=50 origin main
  if git rebase origin/main; then
    return 0
  fi
  local conflicts=()
  mapfile -t conflicts < <(git diff --name-only --diff-filter=U || true)
  if [ "${#conflicts[@]}" -eq 0 ]; then
    git rebase --abort || true
    return 1
  fi
  local f meme=0 scan=0
  for f in "${conflicts[@]}"; do
    if [ "$f" = "data/meme-journal.jsonl" ] || [ "$f" = "data/meme-open.json" ] || [ "$f" = "data/early-log.jsonl" ]; then
      meme=1
    fi
    case "$f" in
      data/early-board.json|data/early-log-summary.json|data/jev-cache.json|data/jev-calls.json|data/phone-alerts.json|data/fast-scan.json)
        scan=1
        ;;
    esac
  done
  if [ "$meme" = 1 ]; then
    node runner/merge-meme.mjs
    git add -- data/meme-journal.jsonl data/meme-open.json data/early-log.jsonl
  fi
  if [ "$scan" = 1 ]; then
    node runner/merge-scan.mjs
    for f in "${conflicts[@]}"; do
      case "$f" in
        data/early-board.json|data/early-log-summary.json|data/jev-cache.json|data/jev-calls.json|data/phone-alerts.json|data/fast-scan.json)
          git add -- "$f"
          ;;
      esac
    done
  fi
  for f in "${conflicts[@]}"; do
    if [ "$f" = "data/meme-journal.jsonl" ] || [ "$f" = "data/meme-open.json" ] || [ "$f" = "data/early-log.jsonl" ]; then
      continue
    fi
    case "$f" in
      data/early-board.json|data/early-log-summary.json|data/jev-cache.json|data/jev-calls.json|data/phone-alerts.json|data/fast-scan.json)
        continue
        ;;
    esac
    git checkout --theirs -- "$f"
    git add -- "$f"
  done
  if ! GIT_EDITOR=true git rebase --continue; then
    git rebase --skip
  fi
}

pause_for() {
  local attempt="$1"
  local wait="${SNAP_PUSH_SLEEP:-}"
  if [ -z "$wait" ]; then
    wait=$((attempt * 5))
  fi
  if [ "$wait" != "0" ]; then
    echo "waiting ${wait}s before retry"
    sleep "$wait"
  fi
}

for attempt in 1 2 3 4; do
  if git push origin HEAD:main; then
    echo "pushed on attempt $attempt"
    exit 0
  fi
  echo "push rejected on attempt $attempt"
  pause_for "$attempt"
  if ! rebase_onto_main; then
    echo "rebase failed on attempt $attempt"
  fi
done

echo "push failed after retries"
exit 1
