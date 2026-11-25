// Layout and keyboard rules for phone, laptop and desktop. Pure, so the
// breakpoints and shortcuts are tested in node.
export const BREAKPOINTS = Object.freeze({ desktop: 900, wide: 1360 });
export const NAV_TABS = Object.freeze(['home', 'bets', 'brain', 'coins', 'more']);

export function layoutFor(width) {
  const w = Number(width) || 0;
  if (w >= BREAKPOINTS.wide) return 'wide';
  if (w >= BREAKPOINTS.desktop) return 'desktop';
  return 'phone';
}
export const isDesk = (width) => layoutFor(width) !== 'phone';

// How many dashboard columns the home grid uses.
export function gridColumns(width) {
  const l = layoutFor(width);
  return l === 'wide' ? 3 : l === 'desktop' ? 2 : 1;
}

// Sheet placement: bottom sheet on phones, side drawer on laptop/desktop.
export function sheetMode(width) {
  return isDesk(width) ? 'drawer' : 'sheet';
}

// Key -> action. Ignored while typing in a field, and with Ctrl/Meta/Alt.
export function shortcutFor(e = {}) {
  const tag = String(e.targetTag || '').toUpperCase();
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'Escape') return { type: 'close' };
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.editable) return null;
  if (/^[1-5]$/.test(e.key || '')) return { type: 'tab', tab: NAV_TABS[Number(e.key) - 1] };
  if (e.key === '/') return { type: 'search' };
  if (e.key === '?') return { type: 'help' };
  if (e.key === 'c' || e.key === 'C') return { type: 'controls' };
  if (e.key === 'r' || e.key === 'R') return { type: 'refresh' };
  return null;
}

export const SHORTCUTS = Object.freeze([
  ['1–5', 'Desk, Bets, Bots, Coins, More'],
  ['/', 'Search bets'],
  ['C', 'Bet controls'],
  ['R', 'Refresh data'],
  ['Esc', 'Close a panel'],
  ['?', 'This list'],
]);
