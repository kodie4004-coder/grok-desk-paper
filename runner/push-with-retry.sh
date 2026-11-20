#!/usr/bin/env bash
# Commit the named files and push them to main.
# The Kalshi chain moves main every few minutes. A plain git push is rejected
# and, on the filings job, that rejection was the whole failure
# (runs 44621143712 and 44819049391). Fetch, rebase, and retry. On a conflict,
# keep this commit's copy of the files it owns and keep main's copy of the rest.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: push-with-retry.sh \"commit message\" file [file...]" >&2
  exit 2
fi

message="$1"
shift
owned=("$@")

git config user.name "${SNAP_GIT_NAME:-paper-snapshot}"
git config user.email "${SNAP_GIT_EMAIL:-paper-snapshot@users.noreply.github.com}"

any=0
for f in "${owned[@]}"; do
  if [ -e "$f" ]; then
    git add -- "$f"
    any=1
  fi
done
if [ "$any" != 1 ]; then
  echo "nothing to add"
  exit 0
fi
if git diff --cached --quiet; then
  echo "unchanged"
  exit 0
fi

git commit -m "$message"

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
  local f mine hit
  for f in "${conflicts[@]}"; do
    hit=0
    for mine in "${owned[@]}"; do
      if [ "$f" = "$mine" ]; then hit=1; fi
    done
    if [ "$hit" = 1 ]; then
      git checkout --theirs -- "$f" || true
    else
      git checkout --ours -- "$f" || true
    fi
    git add -- "$f" || true
  done
  if ! GIT_EDITOR=true git rebase --continue; then
    git rebase --skip || true
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
