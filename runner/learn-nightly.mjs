// Nightly paper post-mortem. Writes lessons. Does not edit strategy thresholds.
import fs from 'node:fs';
import { reviewBrain, riskShadow, lessonsDocument, lessonsMarkdown, morningReport, defaultBrain } from '../engine/learn.js';
import { GATE_PRIOR } from '../engine/gate-prior.js';
import { loadRollingBench } from './rolling-bench.mjs';

const rows = fs.existsSync('data/journal.jsonl')
  ? fs.readFileSync('data/journal.jsonl', 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : [];
const memeRows = fs.existsSync('data/meme-journal.jsonl')
  ? fs.readFileSync('data/meme-journal.jsonl', 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
  : [];
const brain = fs.existsSync('data/brain.json') ? JSON.parse(fs.readFileSync('data/brain.json', 'utf8')) : defaultBrain();
// Rolling-bench books keep weight 0, like the static focus bench.
loadRollingBench();
const now = Date.now();
const reviewed = reviewBrain(brain, rows, now);
const risk = riskShadow(reviewed, rows, now);
reviewed.shadow = risk.shadow;
reviewed.shadowSince = risk.shadowSince;
reviewed.shadowReturned = risk.shadowReturned || {};
if (!reviewed.experimentSince) {
  const opened = rows.map((row) => row.openedAt).filter(Boolean).sort();
  reviewed.experimentSince = opened[0] || new Date(now).toISOString();
}
for (const id of risk.shadow) reviewed.decisions.push(`${id} is in shadow after its own paper loss. Other bots keep the $2 bets. It can come back on a later train day.`);
const doc = lessonsDocument(rows, GATE_PRIOR, reviewed, now, memeRows);
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/brain.json', JSON.stringify(reviewed, null, 2));
fs.writeFileSync('data/lessons.json', JSON.stringify(doc, null, 2));
fs.writeFileSync('LESSONS.md', lessonsMarkdown(doc));
fs.writeFileSync('data/morning.json', JSON.stringify(morningReport(rows, reviewed, doc.summary, now, doc.decay), null, 2));
console.log('lessons', doc.lessons.length, 'frozen', doc.frozen.length);
