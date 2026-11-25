// Trading mode. Paper is the only mode that runs.
//
// "live" is a named mode so the rest of the code can be written against one
// switch, but it is hard-disabled: LIVE_ENABLED is a constant (not a setting,
// not read from storage, a file, or the network), there are no keys anywhere
// in this repo, and there is no order-placing function to call. Every caller
// gets "paper" back, whatever it asks for. Turning live on needs the
// checklist in docs/LIVE_READINESS.md, done in a separate, reviewed change.
export const MODES = Object.freeze({ PAPER: 'paper', LIVE: 'live' });
export const LIVE_ENABLED = false;

export function tradingMode() {
  return MODES.PAPER;
}

// What a caller gets when it asks for a mode. Live is refused with the reason.
export function resolveMode(requested = MODES.PAPER) {
  const wantsLive = requested === MODES.LIVE;
  return Object.freeze({
    mode: MODES.PAPER,
    requested: wantsLive ? MODES.LIVE : MODES.PAPER,
    live: false,
    reason: wantsLive ? 'Live trading is disabled in this build. Paper only. See docs/LIVE_READINESS.md.' : null,
  });
}

// Guard for any code that would only make sense on paper fills.
export function assertPaper(where = 'this step') {
  if (tradingMode() !== MODES.PAPER || LIVE_ENABLED) throw new Error(`${where} runs on paper only`);
  return true;
}

// The readiness checklist from docs/LIVE_READINESS.md, as data the app can
// show. Proof items are measured from forward paper results; the rest are
// facts about this build that stay false until a separate change. Even with
// every item met, LIVE_ENABLED stays false here: this function only reports.
export const LIVE_PROOF = Object.freeze({ minLines: 300, minWindows: 3, minDays: 14 });

export function liveReadiness({ forward = null } = {}) {
  const f = forward || {};
  const n = Number(f.n) || 0;
  const items = [
    { id: 'sample', label: `At least ${LIVE_PROOF.minLines} forward paper lines after fees`, met: n >= LIVE_PROOF.minLines, detail: `${n} so far` },
    { id: 'days', label: `At least ${LIVE_PROOF.minDays} days of forward paper`, met: (Number(f.days) || 0) >= LIVE_PROOF.minDays, detail: `${Number(f.days) || 0} days` },
    { id: 'edge', label: 'After-fee mean above $0 with the 90% lower bound above $0', met: Number(f.mean) > 0 && Number(f.lo) > 0, detail: Number.isFinite(Number(f.lo)) ? `lower bound ${Number(f.lo).toFixed(3)}` : 'no bound yet' },
    { id: 'gate', label: `Every holdout window profitable (${LIVE_PROOF.minWindows}+ windows, the edge gate)`, met: !!f.graduated, detail: f.graduated ? 'gate cleared' : 'not cleared' },
    { id: 'yes', label: "Kodie's explicit yes in chat for a named bot and size", met: false, detail: 'not given' },
    { id: 'keys', label: 'Exchange keys held server-side only (never in this app or repo)', met: false, detail: 'no server, no keys' },
    { id: 'small', label: 'A small first size and a hard daily loss cap, set server-side', met: false, detail: 'not set up' },
    { id: 'code', label: 'Order code written, reviewed and tested in a separate change', met: false, detail: 'none exists' },
  ];
  return { mode: tradingMode(), liveEnabled: LIVE_ENABLED, ready: false, met: items.filter((i) => i.met).length, total: items.length, items };
}
