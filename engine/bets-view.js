// Bets tab and the buy-in controls sheet. Display only: every amount here is
// paper money, after fees, from data/bets.json or a re-scale of it.
import { FAMILY, familyOf } from './home-view.js';
import { buyInFor, coinBuyInFor, isPaused, rescale, markOpen, filterBets, sortBets, timeToSettle, betStatus, simulate, fromHist, BUYIN_MIN, BUYIN_MAX, RECORDED_STAKE, settingsDiff } from './bets.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export const money = (x, sign) => (x == null || !Number.isFinite(Number(x)) ? '–' : (sign && x > 0.004 ? '+' : x < -0.004 ? '−' : '') + '$' + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const tone = (x) => (x > 0.004 ? 'up' : x < -0.004 ? 'dn' : 'flat');
export const bigMoney = (x, sign) => (Number.isFinite(Number(x)) && Math.abs(x) >= 1000 ? (sign && x > 0 ? '+' : x < 0 ? '−' : '') + '$' + Math.round(Math.abs(x)).toLocaleString('en-US') : money(x, sign));
export const PAPER = '<i class="pm" title="Paper money. Not real dollars.">PAPER $</i>';

export function famFor(bot, book) {
  if (book === 'coin') return FAMILY.meme;
  const f = familyOf({ id: bot });
  return FAMILY[f] || FAMILY[String(bot).split('-')[0]] || FAMILY.flip;
}
const cents = (p) => (!Number.isFinite(p) ? '–' : p <= 0 ? '0¢' : p >= 1 ? '100¢' : ((p >= 0.995 || p < 0.01) ? (p * 100).toFixed(1) : Math.round(p * 100)) + '¢');
const coinPx = (p) => (Number.isFinite(p) ? '$' + (p >= 1 ? p.toFixed(2) : p.toPrecision(3)) : '–');
export const priceText = (b, p) => (b.book === 'kalshi' ? cents(p) : coinPx(p));

// Rows as shown: each recorded line re-scaled to the owner's buy-in.
export function viewRows(doc, settings, live = {}, now = Date.now()) {
  const rows = [...(doc?.open || []), ...(doc?.recent || [])];
  return rows.map((b) => {
    const stake = b.book === 'coin' && b.ca ? coinBuyInFor(settings, b.ca) : buyInFor(settings, b.bot);
    const sc = rescale(b, stake);
    const m = b.pnl == null ? markOpen(b, live, stake) : null;
    return { ...b, view: { stake, fees: m ? m.fees : sc?.fees ?? b.fees, pnl: b.pnl == null ? (m ? m.pnl : null) : sc?.pnl ?? b.pnl, mark: m?.mark ?? null, tooSmall: !!sc?.tooSmall, paused: isPaused(settings, b.bot) }, left: b.pnl == null ? timeToSettle(b.closeAt, now) : null };
  });
}

export function scaled(settings) {
  return settingsDiff(settings, null).some((k) => k === 'defaultBuyIn' || k === 'buyIn' || k === 'coinBuyIn');
}

export function betTotals(rows, doc) {
  const open = rows.filter((r) => r.pnl == null);
  const exposure = open.reduce((a, r) => a + (r.book === 'kalshi' ? (rescale(r, r.view.stake)?.cost || 0) + (r.view.fees || 0) : r.view.stake), 0);
  const openPnl = open.reduce((a, r) => a + (Number.isFinite(r.view.pnl) ? r.view.pnl : 0), 0);
  return { open: open.length, exposure, openPnl, todayNet: doc?.totals?.todayNet ?? null, todayN: doc?.totals?.todayN ?? 0, net: doc?.totals?.net ?? null, n: doc?.totals?.n ?? 0 };
}

// What-if: the newest recorded lines per bot (the file keeps ~150 a bot)
// replayed at the owner's buy-ins and limits.
export function whatIf(doc, settings, { counted = 'all' } = {}) {
  const bets = [];
  for (const [bot, h] of Object.entries(doc?.hist || {})) {
    for (const arr of h.rows || []) {
      const b = fromHist(h.book, bot, arr);
      if (counted === 'counted' && !b.counted) continue;
      if (counted === 'practice' && b.counted) continue;
      bets.push(b);
    }
  }
  return simulate(bets, settings);
}

export function skelHtml(kind = 'cards', n = 3) {
  if (kind === 'table') return `<div class="skel-wrap" aria-busy="true" aria-label="Loading">${'<div class="skel-line"></div>'.repeat(n)}</div>`;
  return `<div class="skel-wrap" aria-busy="true" aria-label="Loading"><div class="skel-hero"></div><div class="skel-tiles">${'<i></i>'.repeat(3)}</div>${'<div class="skel-box"></div>'.repeat(n)}</div>`;
}

function seg(name, value, opts) {
  return `<div class="seg bseg" role="group" aria-label="${esc(name)}">${opts.map(([k, l]) => `<button type="button" data-bf="${esc(name)}" data-v="${esc(k)}" class="${value === k ? 'on' : ''}" aria-pressed="${value === k}">${esc(l)}</button>`).join('')}</div>`;
}

const COLS = [['bot', 'Bot'], ['market', 'Market'], ['side', 'Side'], ['entry', 'Entry'], ['stake', 'Buy-in'], ['fees', 'Fees'], ['mark', 'Mark'], ['pnl', 'P&L after fees'], ['settle', 'Settles']];

function rowCells(r) {
  const f = famFor(r.bot, r.book);
  const pnl = r.view.pnl;
  const st = betStatus(r);
  const when = st === 'open' ? (r.closeAt ? `<span class="b-left live-clock" data-close="${esc(r.closeAt)}">${esc(r.left || '—')}</span>` : '<span class="b-left">stop / target</span>') : `<time>${esc(String(r.settledAt || '').slice(11, 16))} UTC</time>`;
  return { f, pnl, st, when };
}

export function betRowHtml(r, i) {
  const { f, pnl, st, when } = rowCells(r);
  return `<li class="brow is-${st}${r.view.paused ? ' is-paused' : ''}" style="--ac:${f.color};--i:${Math.min(i, 12)}" data-bet="${esc(r.id)}" tabindex="0" role="button" aria-label="${esc(r.bot)} ${esc(r.market)} ${st}">
    <span class="brow-ic" aria-hidden="true">${f.icon}</span>
    <span class="brow-main"><b>${esc(r.market)} <em class="side-${esc(r.side)}">${esc(r.side.toUpperCase())}</em></b><small>${esc(r.bot)} · ${priceText(r, r.entry)} · ${money(r.view.stake)}${r.counted ? '' : ' · practice'}</small></span>
    <span class="brow-r"><b class="is-${pnl == null ? 'flat' : tone(pnl)}">${pnl == null ? (st === 'open' ? 'open' : '–') : money(pnl, true)}</b>${when}</span>
  </li>`;
}

export function betTableHtml(rows, sort = { key: 'time', dir: 'desc' }) {
  const head = COLS.map(([k, l]) => {
    const on = sort.key === k;
    const aria = on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th scope="col" aria-sort="${aria}"><button type="button" data-sort="${k}" class="${on ? 'on' : ''}">${esc(l)}${on ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`;
  }).join('');
  const body = rows.map((r) => {
    const { f, pnl, st, when } = rowCells(r);
    return `<tr class="is-${st}${r.view.paused ? ' is-paused' : ''}" style="--ac:${f.color}" data-bet="${esc(r.id)}" tabindex="0">
      <td><span class="bt-bot"><i aria-hidden="true"></i>${esc(r.bot)}</span>${r.counted ? '' : '<small class="bt-prac">practice</small>'}</td>
      <td title="${esc(r.title)}">${esc(r.market)}</td>
      <td><em class="side-${esc(r.side)}">${esc(r.side.toUpperCase())}</em></td>
      <td class="num">${priceText(r, r.entry)}</td>
      <td class="num">${money(r.view.stake)}</td>
      <td class="num">${money(r.view.fees)}</td>
      <td class="num">${r.view.mark != null ? priceText(r, r.view.mark) : st === 'open' ? '—' : priceText(r, r.exitPx ?? (r.book === 'kalshi' ? (r.won ? 1 : 0) : null))}</td>
      <td class="num pnl is-${pnl == null ? 'flat' : tone(pnl)}">${pnl == null ? '—' : money(pnl, true)}</td>
      <td class="num">${when}</td>
    </tr>`;
  }).join('');
  return `<div class="btable-wrap" role="region" aria-label="Bets table" tabindex="0"><table class="btable"><caption>Paper money. P&amp;L is after fees${rows.some((r) => r.view.stake !== RECORDED_STAKE) ? ', re-scaled from the recorded $2 lines' : ''}.</caption><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${COLS.length}" class="empty">No bets match these filters.</td></tr>`}</tbody></table></div>`;
}

export function betsViewHtml({ chart = '', fresh = '', doc, state = 'ready', settings, runner = null, live = {}, filt = {}, sort = { key: 'time', dir: 'desc' }, now = Date.now(), desk = false, demo = false } = {}) {
  if (state === 'loading' && !doc) return skelHtml('cards', 4);
  if (!doc) return `<section class="card"><h2>Bets</h2><p class="note">The bets list did not load. It is written by the runner after each snapshot.</p><button type="button" class="btn wide" id="betsRetry">Try again</button></section>`;
  const all = viewRows(doc, settings, live, now);
  const f = { bot: 'all', market: 'all', status: 'all', counted: 'all', q: '', ...filt };
  const rows = sortBets(filterBets(all, f), sort.key === 'side' || sort.key === 'mark' ? 'time' : sort.key, sort.dir);
  const t = betTotals(all, doc);
  const isScaled = scaled(settings);
  const sim = isScaled || settings?.paused?.length || settings?.dailyLossCap || settings?.maxOpen ? whatIf(doc, settings, { counted: f.counted }) : null;
  const heroVal = sim ? sim.net : t.todayNet;
  const heroTone = tone(heroVal ?? 0);
  const bots = Object.keys(doc.bots || {});
  const markets = [...new Set(all.map((r) => r.market))].sort();
  const diff = runner ? settingsDiff(settings, runner) : null;
  const sync = !runner ? 'Runner file not loaded' : diff.length ? 'Not sent to the runner yet' : 'Runner has these limits';
  const hero = `<section class="bhero is-${heroTone}">
    <div class="bhero-fresh">${fresh}</div><div class="bhero-top"><p class="hero2-k">${sim ? 'What-if at your buy-ins' : 'Today, after fees'} <span>${sim ? `last ${sim.n.toLocaleString('en-US')} recorded lines` : `${t.todayN.toLocaleString('en-US')} lines, counted + practice`}</span></p>${PAPER}</div>
    <b class="bhero-num is-${heroTone}">${money(heroVal, true)}</b>
    ${sim ? `<p class="hero2-sub">Recorded at $2: ${money(sim.recorded, true)} · simulation, not a result</p>` : ''}
    <div class="btiles">
      <div class="btile"><small>Open now</small><b>${t.open}</b></div>
      <div class="btile"><small>Exposure</small><b>${bigMoney(t.exposure)}</b></div>
      <div class="btile is-${tone(t.net ?? 0)}"><small>All-time</small><b>${bigMoney(t.net, true)}</b></div>
    </div>
    <button type="button" class="bctl" id="openControls" aria-haspopup="dialog"><span aria-hidden="true">⚙</span><span><b>Buy-ins &amp; limits</b><small>Default ${money(settings?.defaultBuyIn ?? 2)} · ${settings?.paused?.length ? `${settings.paused.length} paused · ` : ''}${esc(sync)}</small></span><span class="bctl-go" aria-hidden="true">›</span></button>
  </section>`;
  const filters = `<div class="bfilters">
    <div class="bsegs">${seg('status', f.status, [['all', 'All'], ['open', 'Open'], ['settled', 'Settled']])}${seg('counted', f.counted, [['all', 'Both'], ['counted', 'Counted'], ['practice', 'Practice']])}</div>
    <div class="bsel">
      <label><span class="sr">Bot</span><select id="bfBot"><option value="all">All bots</option>${bots.map((b) => `<option value="${esc(b)}"${f.bot === b ? ' selected' : ''}>${esc(b)}</option>`).join('')}</select></label>
      <label><span class="sr">Market</span><select id="bfMarket"><option value="all">All markets</option>${markets.map((m) => `<option value="${esc(m)}"${f.market === m ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select></label>
      <label class="bsearch"><span class="sr">Search bets</span><input id="bfSearch" type="search" placeholder="Search  /" value="${esc(f.q)}" autocomplete="off"></label>
    </div>
  </div>`;
  const list = desk ? betTableHtml(rows.slice(0, 300), sort) : `<ul class="blist">${rows.slice(0, 80).map(betRowHtml).join('') || '<li class="empty">No bets match these filters.</li>'}</ul>`;
  const skipLine = sim ? Object.entries(sim.skipped).filter(([, v]) => v).map(([k, v]) => `${v} ${({ paused: 'paused', cap: 'over the loss cap', maxOpen: 'over max open', tooSmall: 'below one contract' })[k]}`).join(' · ') : '';
  const simCard = sim ? `<section class="bsim"><div class="row"><b>What-if</b>${PAPER}</div><p class="note">Recorded lines replayed at your buy-ins and limits. The stake per bot is fixed, so a loss never raises the next bet. Coins scale linearly; real size would slip more. ${skipLine ? 'Skipped: ' + esc(skipLine) + '.' : ''}</p><dl class="bsim-dl"><div><dt>Lines</dt><dd>${sim.n}</dd></div><div><dt>Won</dt><dd>${sim.n ? Math.round((100 * sim.wins) / sim.n) : 0}%</dd></div><div><dt>Fees</dt><dd>${money(sim.fees)}</dd></div><div><dt>Staked</dt><dd>${money(sim.staked)}</dd></div></dl></section>` : '';
  const foot = `<p class="note bfoot">${doc.generatedAt ? `Updated ${esc(doc.generatedAt.slice(11, 16))} UTC · ` : ''}${(doc.recent || []).length} newest settled lines kept · totals use all ${Number(doc.totals?.n || 0).toLocaleString('en-US')}${doc.quoteErrorsSetAside ? ` · ${doc.quoteErrorsSetAside} bad coin quotes set aside` : ''}. Paper only. live_execution off.${demo ? ' Demo view.' : ''}</p>`;
  return `<div class="bets">${desk ? `<div class="bets-top">${hero}${simCard || botBoardHtml(doc, settings)}</div>` : hero + simCard}${chart}${filters}<div class="bcount"><b>${rows.length.toLocaleString('en-US')}</b> bets${rows.length > (desk ? 300 : 80) ? ` · showing ${desk ? 300 : 80}` : ''}</div>${list}${desk && simCard ? botBoardHtml(doc, settings) : ''}${!desk ? botBoardHtml(doc, settings) : ''}${foot}</div>`;
}

export function botBoardHtml(doc, settings) {
  const bots = Object.values(doc?.bots || {}).sort((a, b) => (b.todayN - a.todayN) || (b.n - a.n));
  if (!bots.length) return '';
  return `<section class="bboard"><div class="sec-row"><h2 class="sec">By bot</h2><span class="sec-note">recorded $2 lines</span></div><ul class="bboard-grid">${bots.map((b, i) => {
    const f = famFor(b.id, b.book);
    const paused = isPaused(settings, b.id);
    return `<li><button type="button" class="bbot${paused ? ' is-paused' : ''}" data-bot-filter="${esc(b.id)}" style="--ac:${f.color};--i:${Math.min(i, 12)}"><span class="agent-ic" aria-hidden="true">${f.icon}</span><span class="bbot-name">${esc(b.id)}</span><b class="is-${tone(b.net)}">${money(b.net, true)}</b><small>${b.n.toLocaleString('en-US')} lines · today ${money(b.todayNet, true)}${b.open ? ` · ${b.open} open` : ''}</small><em>${paused ? 'Paused' : money(buyInFor(settings, b.id))}</em></button></li>`;
  }).join('')}</ul></section>`;
}

export function betSheetHtml(r) {
  if (!r) return '';
  const f = famFor(r.bot, r.book);
  const st = betStatus(r);
  const pnl = r.view.pnl;
  const rec = r.pnl;
  const rows = [
    ['Bot', esc(r.bot) + (r.counted ? '' : ' · practice line')],
    ['Market', esc(r.title || r.market)],
    ['Side', esc(r.side.toUpperCase())],
    ['Entry', priceText(r, r.entry)],
    r.book === 'kalshi' ? ['Contracts at your buy-in', String(rescale(r, r.view.stake)?.contracts ?? '–')] : null,
    ['Your buy-in', money(r.view.stake)],
    ['Fees', money(r.view.fees)],
    st === 'open' ? ['Mark now', r.view.mark != null ? priceText(r, r.view.mark) : 'no quote yet'] : ['Exit', r.exitPx != null ? priceText(r, r.exitPx) : esc(r.result || '')],
    st === 'open' ? ['Settles', r.closeAt ? esc(r.left || '—') : 'at its stop, target or time limit'] : ['Settled', esc(String(r.settledAt || '').slice(0, 16).replace('T', ' ')) + ' UTC'],
    r.view.stake !== r.stake && rec != null ? ['Recorded at $2', money(rec, true)] : null,
  ].filter(Boolean);
  return `<div class="bsh" style="--ac:${f.color}"><div class="bsh-head"><span class="agent-ic" aria-hidden="true">${f.icon}</span><div><h2 id="sheetTitle">${esc(r.market)} <em class="side-${esc(r.side)}">${esc(r.side.toUpperCase())}</em></h2><p class="note">${esc(r.bot)} · ${st}</p></div></div>
  <div class="bsh-big is-${pnl == null ? 'flat' : tone(pnl)}"><small>${st === 'open' ? 'If closed now, after fees' : 'P&amp;L after fees'}</small><b>${pnl == null ? '—' : money(pnl, true)}</b>${PAPER}</div>
  <dl class="bsh-dl">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
  <p class="note">${r.book === 'kalshi' ? 'Kalshi fee: round up(0.07 × contracts × price × (1 − price)) on each taker leg.' : 'Coin fees: 1.25% each way plus modeled slippage.'} Paper only. No order was sent.</p>
  <div class="bsh-act"><button type="button" class="btn" data-bot-filter="${esc(r.bot)}">All ${esc(r.bot)} bets</button><button type="button" class="btn" data-ctl-bot="${esc(r.bot)}">Set this bot's buy-in</button></div></div>`;
}

function stepper(id, value, label, { min = BUYIN_MIN, max = BUYIN_MAX, step = 0.5, placeholder = '' } = {}) {
  return `<div class="stepper" data-stepper="${esc(id)}"><button type="button" data-step="-1" aria-label="Lower ${esc(label)}">−</button><label><span class="sr">${esc(label)}</span><span class="stepper-cur" aria-hidden="true">$</span><input id="${esc(id)}" inputmode="decimal" type="number" min="${min}" max="${max}" step="${step}" value="${value ?? ''}" placeholder="${esc(placeholder)}"></label><button type="button" data-step="1" aria-label="Raise ${esc(label)}">+</button></div>`;
}

export function controlsSheetHtml({ settings, doc, picks = [], runner = null, focusBot = null, demo = false } = {}) {
  const s = settings;
  const bots = Object.values(doc?.bots || {}).sort((a, b) => a.id.localeCompare(b.id));
  const diff = runner ? settingsDiff(s, runner) : null;
  const ro = demo ? ' disabled' : '';
  const presets = [1, 2, 5, 10, 25];
  return `<div class="ctl"${demo ? ' data-demo="1"' : ''}>
  <h2 id="sheetTitle" class="ctl-h">Buy-ins &amp; limits ${PAPER}</h2>
  <p class="note">Every amount is paper money. The runner keeps recording each line at $2, so the edge test stays the same. Your buy-in re-scales those lines on screen, with the real fee for that size.</p>
  ${demo ? '<p class="ctl-demo">Demo view. Changes are turned off.</p>' : ''}
  <section class="ctl-sec"><h3>Default buy-in</h3>
    <div class="ctl-big"><b id="ctlDefaultShow">${money(s.defaultBuyIn)}</b><small>per bet, every bot without its own amount</small></div>
    ${stepper('ctlDefault', s.defaultBuyIn, 'default buy-in')}
    <div class="ctl-presets">${presets.map((p) => `<button type="button" data-preset="${p}" class="${s.defaultBuyIn === p ? 'on' : ''}"${ro}>$${p}</button>`).join('')}</div>
  </section>
  <section class="ctl-sec ctl-two">
    <div><h3>Daily loss cap</h3><p class="note">Stop new counted bets once today is down this much.</p>${stepper('ctlCap', s.dailyLossCap ?? '', 'daily loss cap', { min: 1, max: 10000, step: 1, placeholder: 'off' })}</div>
    <div><h3>Max open bets</h3><p class="note">Skip new counted bets past this many open.</p><div class="stepper" data-stepper="ctlMaxOpen"><button type="button" data-step="-1" aria-label="Fewer open bets">−</button><label><span class="sr">Max open bets</span><input id="ctlMaxOpen" inputmode="numeric" type="number" min="1" max="500" step="1" value="${s.maxOpen ?? ''}" placeholder="off"></label><button type="button" data-step="1" aria-label="More open bets">+</button></div></div>
  </section>
  <section class="ctl-sec"><h3>Bots</h3><p class="note">Switch a bot off to pause it. Leave its amount blank to use the default.</p>
    <ul class="ctl-bots">${bots.map((b) => {
      const f = famFor(b.id, b.book);
      const on = !isPaused(s, b.id);
      return `<li class="${focusBot === b.id ? 'is-focus' : ''}" style="--ac:${f.color}"><span class="agent-ic" aria-hidden="true">${f.icon}</span><span class="ctl-bot-name"><b>${esc(b.id)}</b><small>${b.book === 'coin' ? 'coins' : 'Kalshi'} · ${money(b.net, true)} recorded</small></span><label class="ctl-amt"><span class="sr">${esc(b.id)} buy-in</span><span aria-hidden="true">$</span><input type="number" inputmode="decimal" min="${BUYIN_MIN}" max="${BUYIN_MAX}" step="0.5" data-bot-buyin="${esc(b.id)}" value="${s.buyIn[b.id] ?? ''}" placeholder="${s.defaultBuyIn}"${ro}></label><label class="sw"><input type="checkbox" role="switch" data-bot-on="${esc(b.id)}" ${on ? 'checked' : ''}${ro}><span class="sr">${esc(b.id)} on</span><i aria-hidden="true"></i></label></li>`;
    }).join('')}</ul>
  </section>
  ${picks.length ? `<section class="ctl-sec"><h3>Coins to watch, practice buy-in</h3><p class="note">What a pick would have made at your practice amount, after 1.25% each way and slippage. You still buy coins yourself, in Pump.fun or FOMO.</p><ul class="ctl-bots">${picks.map((p) => `<li style="--ac:#ffe066"><span class="agent-ic" aria-hidden="true">◎</span><span class="ctl-bot-name"><b>$${esc(p.symbol)}</b><small>score ${esc(p.score)}</small></span><label class="ctl-amt"><span class="sr">${esc(p.symbol)} practice buy-in</span><span aria-hidden="true">$</span><input type="number" inputmode="decimal" min="${BUYIN_MIN}" max="${BUYIN_MAX}" step="0.5" data-coin-buyin="${esc(p.ca)}" value="${s.coinBuyIn[p.ca] ?? ''}" placeholder="${s.defaultBuyIn}"${ro}></label></li>`).join('')}</ul></section>` : ''}
  <section class="ctl-sec ctl-sync"><h3>Where these go</h3>
    <ul class="ctl-where"><li><b>On this device</b><span>Saved now. Drives the re-scaled numbers and the what-if.</span></li><li><b>The runner</b><span>${!runner ? 'data/settings.json did not load.' : diff.length ? `Differs on ${esc(diff.join(', '))}. Download the file and commit it as <code>data/settings.json</code>.` : 'Matches data/settings.json.'} The runner uses paused bots, max open and the loss cap to skip new lines. It never raises the $2 recorded size.</span></li></ul>
    <div class="ctl-act"><button type="button" class="btn pri" id="ctlExport">Download settings.json</button><button type="button" class="btn" id="ctlCopy">Copy JSON</button>${runner ? `<button type="button" class="btn" id="ctlFromRunner"${ro}>Use the runner's</button>` : ''}<button type="button" class="btn dng" id="ctlReset"${ro}>Reset to $2</button></div>
  </section>
</div>`;
}
