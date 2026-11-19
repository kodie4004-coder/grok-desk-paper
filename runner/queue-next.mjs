// Decide whether the snapshot chain should start another run.
// The Actions list sometimes omits the run that is asking. On
// 2026-11-19T02:09:20Z run 44441797302 logged queued=0 in_progress=0 while
// that step was still executing, the guard required in_progress==1, and the
// chain stopped on a green job.

export const ACTIVE_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

/** @param {unknown} runs @param {unknown} selfId */
export function otherActive(runs, selfId) {
  const self = Number(selfId);
  if (!Array.isArray(runs) || !Number.isFinite(self)) throw new Error('run list is missing');
  return runs.filter((run) => Number(run.databaseId) !== self && ACTIVE_STATUSES.has(run.status));
}

/** @param {unknown} runs @param {unknown} selfId */
export function decision(runs, selfId) {
  return otherActive(runs, selfId).length === 0 ? 'dispatch' : 'skip';
}

const invoked = process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href;
if (invoked) {
  const raw = await new Response(process.stdin).text();
  const runs = JSON.parse(raw);
  const others = otherActive(runs, process.argv[2]);
  for (const run of others) console.error(`${run.databaseId} ${run.status}`);
  console.log(decision(runs, process.argv[2]));
}
