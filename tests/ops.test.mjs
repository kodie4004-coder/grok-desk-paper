import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

test('snapshot pushes retry, and Actions run on a current Node runtime', () => {
  const filings = readFileSync(new URL('../.github/workflows/filings.yml', import.meta.url), 'utf8');
  const lessons = readFileSync(new URL('../.github/workflows/lessons.yml', import.meta.url), 'utf8');
  const push = readFileSync(new URL('../runner/push-with-retry.sh', import.meta.url), 'utf8');
  assert.match(filings, /push-with-retry\.sh "Update the public filings snapshot" data\/filings\.json/);
  assert.match(lessons, /push-with-retry\.sh "Update the paper lessons"/);
  assert.doesNotMatch(filings, /\bgit push\b/);
  assert.doesNotMatch(lessons, /\bgit push\b/);
  assert.match(push, /git fetch --depth=50 origin main/);
  assert.match(push, /git rebase origin\/main/);
  assert.match(push, /git checkout --theirs/);
  for (const name of readdirSync(new URL('../.github/workflows/', import.meta.url))) {
    const text = readFileSync(new URL('../.github/workflows/' + name, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /actions\/checkout@v4/);
    assert.doesNotMatch(text, /actions\/setup-node@v4/);
    assert.match(text, /actions\/checkout@v5/);
  }
});
