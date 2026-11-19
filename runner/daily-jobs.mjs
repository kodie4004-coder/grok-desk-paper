// Run the once-a-day jobs from the snapshot chain when the UTC day is new.
// Cron remains a backup. A filings failure does not stop the Kalshi chain.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

function dayOf(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
}

const today = new Date().toISOString().slice(0, 10);
let lessonsDay = '';
if (fs.existsSync('data/lessons.json')) {
  try { lessonsDay = dayOf(JSON.parse(fs.readFileSync('data/lessons.json', 'utf8')).generatedAt); } catch { lessonsDay = ''; }
}
if (lessonsDay === today) console.log('lessons already ran', today);
else {
  console.log('running lessons for', today);
  const run = spawnSync(process.execPath, ['runner/learn-nightly.mjs'], { stdio: 'inherit' });
  if (run.status) process.exit(run.status || 1);
}

let filingsDay = '';
if (fs.existsSync('data/filings.json')) {
  try { filingsDay = dayOf(JSON.parse(fs.readFileSync('data/filings.json', 'utf8')).collectedAt); } catch { filingsDay = ''; }
}
if (filingsDay === today) console.log('filings already ran', today);
else {
  console.log('running filings snapshot');
  const run = spawnSync(process.execPath, ['runner/collect-filings.mjs'], { stdio: 'inherit' });
  if (run.status) console.log('filings failed and the Kalshi chain continues', run.status);
}
