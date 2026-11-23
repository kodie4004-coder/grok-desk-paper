// Today header markup for the Home screen. Loads in the browser and in tests.
import { feedAge } from './today.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function money(x) {
  if (x == null || !Number.isFinite(x)) return '—';
  const sign = x > 0 ? '+' : x < 0 ? '−' : '';
  return `${sign}$${Math.abs(x).toFixed(2)}`;
}

const amtClass = (x) => (x > 0 ? 'up' : x < 0 ? 'dn' : '');

function tradesLabel(n) {
  if (n == null) return '—';
  const word = n === 1 ? 'trade' : 'trades';
  return `${n.toLocaleString('en-US')} ${word}`;
}

function feedRow(name, age) {
  const tone = age?.tone || 'old';
  const label = age?.label || 'no update time';
  return `<li class="today-feed is-${esc(tone)}">
    <span class="today-feed-name">${esc(name)}</span>
    <span class="today-feed-age">${esc(label)}</span>
  </li>`;
}

function repairCopy(repair) {
  if (!repair) return 'The coin repair log has not loaded yet.';
  const n = repair.n || 0;
  const need = repair.need || 20;
  const mean = repair.mean == null ? 'no shadow trades yet' : `${money(repair.mean)} per trade after fees`;
  const size = repair.sizeUsd ?? 2;
  const q = Number(repair.quarantined) || 0;
  const aside = q ? ` ${q} bad-quote ${q === 1 ? 'row' : 'rows'} set aside.` : '';
  if (repair.pass) return `${n} of ${need} shadow trades. Mean ${mean}. Ready to resume allocated paper entries at $${size}. Live execution stays off.${aside}`;
  if (n >= need) return `${n} of ${need} shadow trades. Mean ${mean}. Needs a positive mean to resume. Size stays $${size}.${aside}`;
  return `${n} of ${need} shadow trades. Mean ${mean}. Needs ${need} shadow trades with a positive mean to resume. Size stays $${size}.${aside}`;
}

export function todayHeaderHtml(doc, { state = 'ready', now = Date.now() } = {}) {
  if (state === 'loading') {
    return '<section class="card today" aria-label="Today" aria-busy="true"><h2>Today</h2><p class="note">Loading today\'s paper numbers.</p></section>';
  }
  if (!doc || state === 'error') {
    return '<section class="card today" aria-label="Today"><h2>Today</h2><p class="note">Today\'s numbers did not load. The paper desk keeps running. Nothing here is a promise.</p></section>';
  }
  const t = Number.isFinite(now) ? now : Date.now();
  const today = new Date(t).toISOString().slice(0, 10);
  const day = doc.day || today;
  const sameDay = day === today;
  const kalshi = feedAge(doc.kalshiFetchedAt, t);
  const meme = feedAge(doc.memeFetchedAt, t);
  const allocated = doc.allocated || { n: 0, pnl: 0 };
  const shadow = doc.shadow || { n: 0, pnl: 0 };
  const repair = doc.repair || { n: 0, need: 20, mean: null, pass: false };
  const need = repair.need || 20;
  const n = repair.n || 0;
  const pct = Math.round((100 * Math.min(n, need)) / need);
  const bookLabel = sameDay ? 'After fees, so far today' : `After fees on ${esc(day)} (UTC). Today's file has not landed yet.`;
  return `<section class="card today" aria-label="Today">
    <div class="row"><h2 style="margin:0">Today</h2><span class="tag explore">PAPER · after fees</span></div>
    <ul class="today-feeds">
      ${feedRow('Kalshi snapshot', kalshi)}
      ${feedRow('Coin feed', meme)}
    </ul>
    <p class="note today-book-label">${bookLabel}</p>
    <div class="today-books">
      <div>
        <small>Allocated</small>
        <b class="today-amt ${amtClass(allocated.pnl)}">${money(allocated.pnl)}</b>
        <span class="note">${esc(tradesLabel(allocated.n))}</span>
      </div>
      <div>
        <small>Shadow</small>
        <b class="today-amt ${amtClass(shadow.pnl)}">${money(shadow.pnl)}</b>
        <span class="note">${esc(tradesLabel(shadow.n))}</span>
      </div>
    </div>
    <div class="today-repair">
      <div class="row"><span>Coin repair</span><span class="note">${n} of ${need}</span></div>
      <div class="today-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${need}" aria-valuenow="${n}" aria-label="Coin repair shadow trades toward resuming"><i data-w="${pct}%"></i></div>
      <p class="note">${esc(repairCopy(repair))}</p>
    </div>
    <p class="note">Paper only. live_execution stays off. Not a promise.</p>
  </section>`;
}
