// Decide whether to start meme-watch.yml. One open paper coin is enough.
// The shell script does the gh workflow run. This file only counts.
import fs from 'node:fs';
import { openMemeCount } from '../engine/meme.js';

export function watchKickDecision(count) {
  return (Number(count) || 0) > 0 ? 'dispatch' : 'skip';
}

const invoked = process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href;
if (invoked) {
  let doc = { entries: [] };
  try { doc = JSON.parse(fs.readFileSync(process.argv[2] || 'data/meme-open.json', 'utf8')); } catch { doc = { entries: [] }; }
  const n = openMemeCount(doc);
  console.error(`open=${n}`);
  console.log(watchKickDecision(n));
}
