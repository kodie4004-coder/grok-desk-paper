// Risk and limits. One module for every size and stop rule, used by the
// paper sim on screen, the runner's guard on new paper lines, and the
// pre-trade ticket. Paper only: a check can skip a line, never open one,
// never raise a size, and never feed back into strategy logic or gates.
export const RECORDED_STAKE = 2;
export const RISK_LIMITS = Object.freeze({
  minStake: 0.5,     // smallest paper buy-in on screen
  maxStake: 50,      // largest paper buy-in on screen
  runnerStake: RECORDED_STAKE, // the runner records every line at this size
  maxOpenCap: 500,
  lossCapMax: 10000,
});

const round2 = (x) => Math.round(x * 100) / 100;
const num = (x) => (x === null || x === undefined || x === '' ? NaN : Number(x));

export function clampStake(x, fallback = RECORDED_STAKE) {
  const v = num(x);
  if (!Number.isFinite(v)) return fallback;
  return round2(Math.min(RISK_LIMITS.maxStake, Math.max(RISK_LIMITS.minStake, v)));
}
export function cleanLossCap(x) {
  const v = num(x);
  return Number.isFinite(v) && v > 0 ? round2(Math.min(RISK_LIMITS.lossCapMax, v)) : null;
}
export function cleanMaxOpen(x) {
  const v = num(x);
  return Number.isFinite(v) && v >= 1 ? Math.min(RISK_LIMITS.maxOpenCap, Math.floor(v)) : null;
}

// One new line against the limits. Order matters: the kill switch stops
// everything, a pause stops that bot, then size, then (counted lines only)
// the daily loss cap and max open.
//   settings     normalized bet settings
//   bot          the bot id
//   stake        the size the line would use
//   counted      true for counted (allocated) lines
//   dayPnl       today's settled counted P&L after fees
//   openCounted  counted lines open right now
export function riskCheck({ settings = null, bot = null, stake = RECORDED_STAKE, counted = true, dayPnl = 0, openCounted = 0 } = {}) {
  const s = settings || {};
  if (s.killSwitch === true) return { ok: false, why: 'kill switch' };
  if (bot && Array.isArray(s.paused) && s.paused.includes(bot)) return { ok: false, why: 'paused' };
  const st = Number(stake);
  if (!(st >= RISK_LIMITS.minStake && st <= RISK_LIMITS.maxStake)) return { ok: false, why: 'size' };
  if (counted && s.dailyLossCap != null && dayPnl <= -s.dailyLossCap) return { ok: false, why: 'daily loss cap' };
  if (counted && s.maxOpen != null && openCounted >= s.maxOpen) return { ok: false, why: 'max open' };
  return { ok: true, why: null };
}

export const RISK_WORDS = Object.freeze({
  'kill switch': 'Kill switch is on',
  paused: 'This bot is paused',
  size: `Size outside $${RISK_LIMITS.minStake}–$${RISK_LIMITS.maxStake}`,
  'daily loss cap': 'Daily loss cap reached',
  'max open': 'Max open bets reached',
});
