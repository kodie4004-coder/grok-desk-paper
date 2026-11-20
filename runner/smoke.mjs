// Mobile smoke: home cockpit, arena, pick, scoreboard, settings. Paper labels only.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.webm': 'video/webm', '.mp4': 'video/mp4', '.ico': 'image/vnd.microsoft.icon' };
const root = fileURLToPath(new URL('..', import.meta.url));
const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  const file = join(root, rel);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('missing');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const fails = [];
const logs = [];
page.on('pageerror', (e) => logs.push('pageerror ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') logs.push('console ' + m.text()); });
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  const intro = page.locator('#introSkip');
  if (await intro.count()) await intro.click();
  await page.waitForSelector('text=Cockpit', { timeout: 4000 }).catch((e) => logs.push(e.message));
  const home = await page.locator('body').innerText();
  if (!/paper/i.test(home) || !/cockpit/i.test(home)) fails.push('home cockpit missing\n' + home.slice(0, 400) + '\n' + logs.join('\n'));
  await page.locator('nav.tabs button[data-tab="arena"]').click();
  const arena = await page.locator('#view').innerText();
  if (!/arena feed/i.test(arena)) fails.push('arena\n' + arena.slice(0, 240));
  await page.locator('button[data-arena="pick"]').click();
  const pick = await page.locator('#view').innerText();
  if (!/pick a side/i.test(pick)) fails.push('pick\n' + pick.slice(0, 240));
  await page.locator('nav.tabs button[data-tab="coins"]').click();
  const coins = await page.locator('#view').innerText();
  if (!/not advice/i.test(coins)) fails.push('coins\n' + coins.slice(0, 240));
  await page.locator('nav.tabs button[data-tab="brain"]').click();
  await page.waitForSelector('text=/after fees/i', { timeout: 8000 }).catch((e) => logs.push(e.message));
  const brain = await page.locator('#view').innerText();
  if (!/bot brain/i.test(brain) || !/after fees/i.test(brain) || !/nonstop/i.test(brain)) fails.push('brain\n' + brain.slice(0, 400) + '\n' + logs.join('\n'));
  await page.locator('nav.tabs button[data-tab="score"]').click();
  const score = await page.locator('#view').innerText();
  if (!/ready for real money/i.test(score) || !/hype check/i.test(score)) fails.push('score\n' + score.slice(0, 240));
  await page.locator('nav.tabs button[data-tab="settings"]').click();
  if (await page.locator('input[type="checkbox"][disabled]').count() < 1) fails.push('live execution toggle');
  await page.setViewportSize({ width: 430, height: 932 });
  await page.locator('nav.tabs button[data-tab="home"]').click();
  const tab = await page.locator('nav.tabs button').first().evaluate((el) => el.getBoundingClientRect().height);
  if (tab < 44) fails.push('tab target ' + tab);
} finally {
  await browser.close();
  server.close();
}
if (fails.length) {
  console.error(fails.join('\n'));
  process.exit(1);
}
console.log('smoke ok');
