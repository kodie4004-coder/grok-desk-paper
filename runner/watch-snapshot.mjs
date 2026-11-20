// Decide whether the kick workflow should start the snapshot chain.
// A run that is queued or in progress is enough. Otherwise the newest
// snapshot is stale once it is 10 minutes old, which is the gap that
// opened when the 2026-11-20T04:48Z push was rejected and nothing
// dispatched the next pass.

import { ACTIVE_STATUSES } from './queue-next.mjs';

export const STALE_MS = 10 * 60 * 1000;

function stamp(run) {
  const raw = run?.updatedAt || run?.updated_at || run?.createdAt || run?.created_at || '';
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/** @param {unknown} runs @param {number} now @param {number} [staleMs] */
export function watchdogDecision(runs, now, staleMs = STALE_MS) {
  if (!Array.isArray(runs) || !Number.isFinite(now)) throw new Error('run list is missing');
  if (runs.some((run) => ACTIVE_STATUSES.has(run?.status))) return 'skip';
  const times = runs.map(stamp).filter((t) => t != null);
  if (!times.length) return 'dispatch';
  const latest = Math.max(...times);
  return now - latest >= staleMs ? 'dispatch' : 'skip';
}

const invoked = process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href;
if (invoked) {
  const raw = await new Response(process.stdin).text();
  const runs = JSON.parse(raw);
  const now = Number(process.env.WATCH_NOW || Date.now());
  console.log(watchdogDecision(runs, now));
}
