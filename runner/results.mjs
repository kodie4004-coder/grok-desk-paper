// Prints a markdown summary of a saved session state (real numbers only).
import fs from 'node:fs';
import { calibration } from '../engine/core.js';
const st = JSON.parse(fs.readFileSync(process.argv[2] || 'runner/session-state.json', 'utf8'));
const c = st.closed, wins = c.filter((t) => t.pnl > 0);
const sum = (a, f) => a.reduce((x, t) => x + f(t), 0);
const et = (t) => new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET';
const gaps = st.equity.slice(1).map((p, i) => p.t - st.equity[i].t).filter((g) => g > 150000);
console.log(`- Session ${st.sessionId}: ${et(st.startedAt)} → ${et(st.endedAt || st.lastTickAt)}, ${st.tick} market checks${gaps.length ? `, ${gaps.length} gap(s) totalling ${Math.round(gaps.reduce((a, b) => a + b, 0) / 60000)} min while the box was suspended` : ''}`);
console.log(`- Bank $${st.startBank} → equity $${st.equity.at(-1).v} · closed trades ${c.length} (${wins.length} green / ${c.length - wins.length} red) · open at end ${st.open.length}`);
console.log(`- Realized after fees $${sum(c, (t) => t.pnl).toFixed(2)} · before fees $${sum(c, (t) => t.pnl + t.fees).toFixed(2)} · fees/slippage $${sum(c, (t) => t.fees).toFixed(2)}`);
console.log(`- Funnel: ${st.counts.signals} signals → ${st.counts.filtered} filtered → ${st.counts.judged} judged → ${st.counts.judgeBuy} JUDGE buys → ${st.counts.copied} copied / ${st.counts.own} own → ${st.counts.riskBlocked} risk-blocked → ${st.counts.closed} closed`);
console.log(`- Wallets followed at end: ${st.followed.length} · fired: ${st.fired.length} · data errors: ${st.errors} · halted: ${st.halted}`);
const kills = {}; for (const v of st.verdicts) if (v.decision !== 'buy') { const k = (v.killedBy || '').replace(/[0-9.]+/g, '#').replace(/ \(re-ask.*/, ''); kills[k] = (kills[k] || 0) + 1; }
console.log(`- What killed leads: ${Object.entries(kills).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ×${n}`).join('; ')}`);
console.log('\n| Trade | Source | Entry→exit | Exit reason | P&L after fees |\n|---|---|---|---|---|');
for (const t of c) console.log(`| ${t.symbol} | ${t.source} | ${t.entryMid.toPrecision(4)} → ${t.exitMid.toPrecision(4)} | ${t.exitReason} | $${t.pnl} (${t.retPct}%) |`);
const cal = calibration(st.verdicts, [...c, ...st.open], st.passChecks);
console.log('\n| JUDGE buy p | Buys | Closed | Green |\n|---|---|---|---|');
for (const b of cal.buckets) console.log(`| ${b.label} | ${b.buys} | ${b.closed} | ${b.green} |`);
console.log(`\nPasses logged: ${cal.passes.total}; checked after 24h: ${cal.passes.checked} (needs the desk running 24h later).`);
