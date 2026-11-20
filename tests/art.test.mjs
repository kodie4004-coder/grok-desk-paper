import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const pages = 'https://kodie4004-coder.github.io/grok-desk-paper';

test('manifest icons are the maskable terminal-bars mark on the desk background', () => {
  assert.equal(manifest.background_color.toLowerCase(), '#07090c');
  assert.equal(manifest.theme_color.toLowerCase(), '#07090c');
  assert.deepEqual(manifest.icons.map((icon) => icon.src), ['icons/icon-192.png', 'icons/icon-512.png']);
  for (const icon of manifest.icons) {
    assert.equal(icon.type, 'image/png');
    assert.equal(icon.purpose, 'any maskable');
  }
  assert.equal(manifest.icons[0].sizes, '192x192');
  assert.equal(manifest.icons[1].sizes, '512x512');
});

test('the document points at the svg favicon, 32px icon, ico, 180px apple touch, and splash still', () => {
  assert.match(html, /id="app-icon-slot"[^>]*href="icons\/icon\.svg"/);
  assert.match(html, /href="icons\/favicon-32\.png"[^>]*sizes="32x32"/);
  assert.match(html, /href="icons\/favicon\.ico"/);
  assert.match(html, /rel="apple-touch-icon"[^>]*href="icons\/apple-touch-icon\.png"[^>]*sizes="180x180"/);
  assert.match(html, /id="splash-slot"[^>]*href="splash\/splash\.webp"/);
  assert.match(html, /name="theme-color" content="#07090C"/);
});

test('social cards use the webp preview and a png fallback on the pages origin', () => {
  assert.match(html, /property="og:title" content="Grok Desk · Paper"/);
  assert.match(html, /property="og:description" content="Paper-only market desk\. Signals are not advice\. No wallet and no orders\."/);
  assert.match(html, /property="og:image" content="https:\/\/kodie4004-coder\.github\.io\/grok-desk-paper\/social\/og-image\.webp"/);
  assert.match(html, /property="og:image" content="https:\/\/kodie4004-coder\.github\.io\/grok-desk-paper\/social\/og-image\.png"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.match(html, /name="twitter:image" content="https:\/\/kodie4004-coder\.github\.io\/grok-desk-paper\/social\/og-image\.webp"/);
  assert.match(html, /name="twitter:image" content="https:\/\/kodie4004-coder\.github\.io\/grok-desk-paper\/social\/og-image\.png"/);
  assert.ok(html.indexOf(`${pages}/social/og-image.webp`) < html.indexOf(`${pages}/social/og-image.png`));
});

test('splash and empty states use the delivered art and the cache version moved', () => {
  assert.match(sw, /grokdesk-v19/);
  assert.doesNotMatch(sw, /grokdesk-v18/);
  assert.match(app, /splash\/splash\.webm/);
  assert.match(app, /splash\/splash\.mp4/);
  assert.match(app, /splash\/splash\.webp/);
  assert.match(app, /prefers-reduced-motion/);
  assert.match(app, /saveData/);
  assert.match(app, /empty-trades\.webp/);
  assert.match(app, /empty-coins\.webp/);
  assert.match(app, /empty-bot\.webp/);
  assert.match(app, /loading="lazy"/);
  for (const file of ['icons/icon-192.png', 'icons/icon-512.png', 'icons/icon.svg', 'icons/apple-touch-icon.png', 'icons/favicon-32.png', 'icons/favicon.ico', 'splash/splash.webp', 'splash/splash.webm', 'splash/splash.mp4', 'social/og-image.webp', 'social/og-image.png', 'empty/empty-trades.webp', 'empty/empty-coins.webp', 'empty/empty-bot.webp']) {
    assert.ok(readFileSync(new URL('../' + file, import.meta.url)).byteLength > 100, file);
  }
});
