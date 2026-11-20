import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ALERT_LINE, ALERTS_PER_HOUR, DESK_URL, formatAlert, mergeAlertDocs, ntfyTopic, planAlerts, sendPhoneAlerts,
} from '../engine/alerts.js';

const now = Date.parse('2026-11-20T22:00:00Z');
const topic = 'deskTopic1';

function row(extra = {}) {
  return {
    ca: 'MINT123',
    symbol: 'DOGE',
    action: 'enter',
    ageMin: 4,
    liq: 8000,
    jev: { verdict: 'pass', reason: 'pass' },
    ...extra,
  };
}

function capture() {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url, init });
      return { ok: true, status: 200 };
    },
  };
}

test('the push names the ticker, age, liquidity, Jev verdict, the unproven line, and the mint', async () => {
  const net = capture();
  const result = await sendPhoneAlerts([row()], { topic, now, fetchImpl: net.fetch, state: { sent: [] } });
  assert.equal(result.delivered, 1);
  assert.equal(result.sent[0], 'MINT123');
  const init = net.calls[0].init;
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Title, 'DOGE paper signal');
  assert.equal(init.headers.Tags, 'warning');
  assert.equal(init.headers.Click, 'https://pump.fun/coin/MINT123');
  assert.equal(init.headers.Actions, `view, Open FOMO, https://fomo.family/tokens/solana/MINT123; view, Open Pump.fun, https://pump.fun/coin/MINT123; view, Desk, ${DESK_URL}`);
  const lines = init.body.split('\n');
  assert.equal(lines[0], 'DOGE');
  assert.equal(lines[1], 'Age 4 min');
  assert.equal(lines[2], 'Liquidity $8000');
  assert.equal(lines[3], 'Jev pass');
  assert.equal(lines[4], ALERT_LINE);
  assert.equal(lines[5], 'MINT123');
  assert.equal(JSON.stringify(result).includes(topic), false);
  assert.equal(net.calls[0].url, `https://ntfy.sh/${topic}`);
  const formatted = formatAlert(row({ ageMin: 4.24, liq: 8000.6, jev: { verdict: 'unknown' } }));
  assert.match(formatted.body, /Age 4\.2 min/);
  assert.match(formatted.body, /Liquidity \$8001/);
  assert.match(formatted.body, /Jev unknown/);
});

test('a mint is pushed once, the eleventh alert in an hour waits, and a flag is not a signal', async () => {
  const net = capture();
  const first = await sendPhoneAlerts([row(), row()], { topic, now, fetchImpl: net.fetch });
  assert.equal(first.delivered, 1);
  assert.equal(net.calls.length, 1);
  const again = await sendPhoneAlerts([row({ symbol: 'DOGE2' })], { topic, now: now + 1000, fetchImpl: net.fetch, state: first.state });
  assert.equal(again.delivered, 0);
  assert.equal(again.skipped.some((item) => item.reason === 'dedupe'), true);
  assert.equal(net.calls.length, 1);
  const sent = Array.from({ length: ALERTS_PER_HOUR }, (_, i) => ({ ca: 'OLD' + i, at: new Date(now - 30 * 60 * 1000).toISOString(), symbol: 'O' }));
  const capped = planAlerts([row({ ca: 'NEW1' })], { sent }, now);
  assert.equal(capped.queued.length, 0);
  assert.equal(capped.skipped[0].reason, 'cap');
  const aged = sent.map((item, i) => (i === 0 ? { ...item, at: new Date(now - 60 * 60 * 1000).toISOString() } : item));
  const room = planAlerts([row({ ca: 'NEW1' })], { sent: aged }, now);
  assert.equal(room.queued.length, 1);
  const blocked = planAlerts([
    row({ ca: 'FLAG', jev: { verdict: 'flag' } }),
    row({ ca: 'WAIT', jevPending: true }),
    row({ ca: 'KILL', action: 'kill', jev: undefined }),
    row({ ca: 'SOFT', action: 'pass' }),
  ], { sent: [] }, now);
  assert.equal(blocked.queued.length, 0);
  assert.deepEqual(blocked.skipped.map((item) => item.reason), ['flag', 'pending', 'checks', 'checks']);
  const merged = mergeAlertDocs(
    { sent: [{ ca: 'A', at: '2026-11-20T21:00:00Z', symbol: 'A' }] },
    { sent: [{ ca: 'A', at: '2026-11-20T20:00:00Z', symbol: 'A' }, { ca: 'B', at: '2026-11-20T21:30:00Z', symbol: 'B' }] },
  );
  assert.equal(merged.sent.find((item) => item.ca === 'A').at, '2026-11-20T20:00:00Z');
  assert.equal(merged.sent.some((item) => item.ca === 'B'), true);
  assert.equal(merged.liveExecution, false);
});

test('a missing or unusable topic does not call ntfy', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, status: 200 }; };
  const missing = await sendPhoneAlerts([row()], { env: {}, now, fetchImpl });
  assert.equal(called, false);
  assert.equal(missing.delivered, 0);
  assert.equal(missing.skipped[0].reason, 'no topic');
  assert.equal(missing.state.sent.length, 0);
  const blank = await sendPhoneAlerts([row()], { topic: '   ', now, fetchImpl });
  assert.equal(called, false);
  assert.equal(blank.skipped[0].reason, 'no topic');
  const slash = await sendPhoneAlerts([row()], { env: { NTFY_TOPIC: 'bad/topic' }, now, fetchImpl });
  assert.equal(called, false);
  assert.equal(ntfyTopic({}), '');
  assert.equal(ntfyTopic({ NTFY_TOPIC: topic }), topic);
  const failed = await sendPhoneAlerts([row()], {
    topic,
    now,
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  assert.equal(failed.delivered, 0);
  assert.equal(failed.state.sent.length, 0);
  assert.equal(failed.skipped.some((item) => item.reason === 'http'), true);
});

test('the public desk tells you to subscribe without printing the topic', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const alerts = readFileSync(new URL('../engine/alerts.js', import.meta.url), 'utf8');
  assert.match(app, /Phone alerts/);
  assert.match(app, /Install the ntfy app and subscribe to the topic your assistant gave you/);
  assert.match(app, /has not passed the edge gate/);
  assert.doesNotMatch(app, /NTFY_TOPIC/);
  assert.doesNotMatch(app, /ntfy\.sh\/[A-Za-z0-9]/);
  assert.doesNotMatch(alerts, /console\./);
  assert.doesNotMatch(alerts, /privateKey|secretKey|signTransaction/);
});
