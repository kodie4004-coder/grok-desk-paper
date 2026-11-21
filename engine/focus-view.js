// Focus card markup for the page. No imports so it loads in the browser and in tests.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function money(x) {
  if (x == null || !Number.isFinite(x)) return '—';
  const sign = x > 0 ? '+' : x < 0 ? '−' : '';
  return `${sign}$${Math.abs(x).toFixed(2)}`;
}

const tone = (x) => (x > 0 ? 'g' : x < 0 ? 'r' : '');

function btLine(bt) {
  if (!bt) return '';
  const cell = (s, name) => (s ? `${name} n ${s.n} · ${money(s.mean)}` : `${name} —`);
  const mode = bt.mode === 'recorded' ? 'recorded rows' : 'replay';
  return `<p class="focus-bt">Backtest (${esc(mode)}): ${esc(cell(bt.inSample, 'in-sample'))} · ${esc(cell(bt.outSample, 'out-of-sample'))}</p>`;
}

export function focusCardHtml(doc, { state = 'ready' } = {}) {
  if (state === 'loading') return '<section class="card focus" aria-label="Focus" aria-busy="true"><h2>Focus</h2><p class="note">Loading the focus board.</p></section>';
  if (!doc || state === 'error') return '<section class="card focus" aria-label="Focus"><h2>Focus</h2><p class="note">The focus board did not load. The paper desk keeps running.</p></section>';
  const rows = (doc.near || []).map((row) => {
    const g = row.gate || { cleared: 0, need: 3, forwardN: 0 };
    const pct = Math.round((100 * Math.min(g.cleared, g.need)) / g.need);
    return `<li class="focus-row">
      <div class="row"><b>${esc(row.label)}</b><span class="tag ${row.gate?.graduated ? 'normal' : 'explore'}">${row.gate?.graduated ? 'gate cleared' : `paper · weight ${row.weight == null ? '—' : esc(+row.weight.toFixed(2))}`}</span></div>
      ${row.n ? `<dl class="focus-metrics">
        <div><dt>Trades</dt><dd>${row.n}</dd></div>
        <div><dt>Mean after fees</dt><dd class="${tone(row.mean)}">${money(row.mean)}</dd></div>
        <div><dt>90% range</dt><dd>${money(row.lo)} to ${money(row.hi)}</dd></div>
      </dl>` : `<p class="note focus-empty">No forward paper trades yet${row.addedAt ? ` · added ${esc(String(row.addedAt).slice(0, 10))}` : ''}.</p>`}
      <div class="focus-gate"><span>Gate ${g.cleared}/${g.need} days</span><span class="focus-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${g.need}" aria-valuenow="${g.cleared}" aria-label="${esc(row.label)} gate progress"><i data-w="${pct}%"></i></span><span>${g.forwardN} forward</span></div>
      ${btLine(row.backtest)}
    </li>`;
  }).join('');
  const benched = (doc.benched || []).map((row) => `<li><span><b>${esc(row.label)}</b><br><span class="note">n ${row.nowN ?? row.n} · mean ${money(row.nowMean ?? row.mean)} after fees · 90% high ${money(row.nowHi ?? row.hi)}</span></span><span class="tag off">benched</span></li>`).join('');
  const rolledRows = doc.rolled || [];
  const rolled = rolledRows.map((row) => `<li class="focus-rolled"><span><b>${esc(row.label)}</b><br><span class="note">Rolled onto the bench ${esc(String(row.benchedAt || '').slice(0, 10))} · at that time n ${row.n} · mean ${money(row.mean)} after fees · 90% high ${money(row.hi)}${row.nowN != null ? ` · now n ${row.nowN} · mean ${money(row.nowMean)}` : ''}</span></span><span class="tag off">rolled</span></li>`).join('');
  const benchCount = (doc.benched || []).length + rolledRows.length;
  return `<section class="card focus" aria-label="Focus">
    <div class="row"><h2 style="margin:0">Focus</h2><span class="tag explore">PAPER · $2 · after fees</span></div>
    <p class="note">Only the near-winners. None is ready for real money until it has 3 days of 20+ forward trades and every such day has a 90% low above zero after fees. scalp-95 stays at weight 0 until then. A backtest never counts toward that.</p>
    <ul class="focus-list">${rows || '<li><span class="empty">No near-winners in this file.</span></li>'}</ul>
    <details class="focus-bench"><summary>Benched (${benchCount})</summary>
      <p class="note">At least ${doc.rule?.minN ?? 40} trades with the 90% high of the mean below zero after fees. No new paper lines. History is kept.</p>
      <ul class="feed">${benched}</ul>
      ${rolled ? `<p class="note focus-rolled-note">Rolling bench: the same rule, checked again each snapshot on forward paper rows. A book that meets it is added with the date and the numbers that put it there. Nothing comes off on its own.</p>
      <ul class="feed">${rolled}</ul>` : ''}
    </details>
    <p class="note">live_execution stays off. Updated ${esc(doc.generatedAt || '')}.</p>
  </section>`;
}
