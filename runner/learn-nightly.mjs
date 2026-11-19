// Nightly paper post-mortem. Writes lessons. Does not edit strategy thresholds.
import fs from 'node:fs';
import { reviewBrain, lessonsDocument, lessonsMarkdown, defaultBrain } from '../engine/learn.js';
import { GATE_PRIOR } from '../engine/gate-prior.js';

const rows = fs.existsSync('data/journal.jsonl')
  ? fs.readFileSync('data/journal.jsonl', 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : [];
const brain = fs.existsSync('data/brain.json') ? JSON.parse(fs.readFileSync('data/brain.json', 'utf8')) : defaultBrain();
const now = Date.now();
const reviewed = reviewBrain(brain, rows, now);
const doc = lessonsDocument(rows, GATE_PRIOR, reviewed, now);
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/brain.json', JSON.stringify(reviewed, null, 2));
fs.writeFileSync('data/lessons.json', JSON.stringify(doc, null, 2));
fs.writeFileSync('LESSONS.md', lessonsMarkdown(doc));
console.log('lessons', doc.lessons.length, 'frozen', doc.frozen.length);
