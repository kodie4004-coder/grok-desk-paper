// XP is for paper activity and for keeping the rules. It does not grow with profit.

export const XP = Object.freeze({ place: 5, settle: 5, pick: 8, pause: 20, daily: 10 });

export function addXp(game, kind) {
  const gain = XP[kind] || 0;
  game.xp = (game.xp || 0) + gain;
  return gain;
}

export function levelOf(xp) {
  return 1 + Math.floor((xp || 0) / 50);
}

export function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

export function noteDay(game, now) {
  game.days ||= {};
  game.days[dayKey(now)] = (game.days[dayKey(now)] || 0) + 1;
}

export function streak(game, now) {
  const days = game?.days || {};
  let n = 0;
  const d = new Date(Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  ));
  for (;;) {
    const key = d.toISOString().slice(0, 10);
    if (!days[key]) break;
    n += 1;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return n;
}

export function achievements(state) {
  const arena = (state.arenaClosed || []).length + (state.arenaOpen || []).length;
  const picks = (state.picksClosed || []).length + (state.picksOpen || []).length;
  const settled = (state.arenaClosed || []).length + (state.picksClosed || []).length;
  const sameSize = (state.arenaClosed || []).every((t) => t.sizeUsd === 2) && (state.picksClosed || []).every((t) => t.sizeUsd === 2);
  const today = (state.game?.days || {})[dayKey(Date.now())] || 0;
  return [
    { id: 'first', label: 'First paper bet', on: arena + picks >= 1 },
    { id: 'hundred', label: 'First 100 bets', on: arena + picks >= 100 },
    { id: 'pause', label: 'Survived a drawdown pause', on: !!state.arenaPausedDay },
    { id: 'size', label: 'Rule kept: no size-up', on: settled >= 2 && sameSize },
    { id: 'pick', label: 'Picked a side', on: picks >= 1 },
    { id: 'settled', label: 'Settled 10 paper bets', on: settled >= 10 },
    { id: 'daily', label: 'Daily challenge: 5 paper actions', on: today >= 5 },
  ];
}
