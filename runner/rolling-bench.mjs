// Rolling bench file for the Node runners. Paper only. Reading it makes
// isFocusBenched() honor books the frozen focus rule benched after 2026-11-21;
// writing it only ever adds books. No wallet, no key, no order.
import fs from 'node:fs';
import { applyRollingBench, rollingBenchDoc } from '../engine/focus.js';

export const ROLLING_FILE = 'data/rolling-bench.json';

export function readRollingBench(file = ROLLING_FILE) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(doc?.books) ? doc : { books: [] };
  } catch {
    return { books: [] };
  }
}

export function loadRollingBench(file = ROLLING_FILE) {
  const doc = readRollingBench(file);
  applyRollingBench(doc.books);
  return doc;
}

// Re-applies the rule, saves the list, and loads it. Returns the new doc.
export function updateRollingBench({ rows, memeRows, now, file = ROLLING_FILE }) {
  const prev = readRollingBench(file).books;
  const doc = rollingBenchDoc({ rows, memeRows, prev, now });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  applyRollingBench(doc.books);
  return doc;
}
