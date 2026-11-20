#!/usr/bin/env bash
# Start one meme-stop pass when a paper coin is open.
# The Kalshi 15-minute chain and the meme snapshot runner both call this.
# A workflow_run listener does not see a run that GITHUB_TOKEN started, so
# this dispatches with gh workflow run (queue-watch.sh). The calling workflow
# needs permissions.actions: write. queue-watch.sh leaves a pass alone when
# one is already queued or running. meme-watch.yml's concurrency group keeps
# two passes from overlapping.
set -euo pipefail

choice="$(node runner/kick-watch.mjs)"
echo "decision=$choice"
if [ "$choice" = "skip" ]; then
  echo "no open meme position"
  exit 0
fi
if [ "$choice" != "dispatch" ]; then
  echo "unexpected decision: $choice"
  exit 1
fi
bash runner/queue-watch.sh
