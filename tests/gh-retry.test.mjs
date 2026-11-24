import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const helper = resolve('runner/gh-retry.sh');

function fakeGh(failures) {
  const dir = mkdtempSync(join(tmpdir(), 'ghretry-'));
  const count = join(dir, 'count');
  writeFileSync(count, '0');
  const bin = join(dir, 'gh');
  writeFileSync(bin, `#!/usr/bin/env bash
n=$(( $(cat "${count}") + 1 ))
echo "$n" > "${count}"
if [ "$n" -le ${failures} ]; then echo "failed to get runs: HTTP 500" >&2; exit 1; fi
echo '[{"databaseId":1,"status":"completed"}]'
`);
  chmodSync(bin, 0o755);
  return { dir, count };
}

function run(failures) {
  const { dir, count } = fakeGh(failures);
  const r = spawnSync('bash', ['-c', `set -euo pipefail; source "${helper}"; if out="$(gh_retry gh run list)"; then echo "OK $out"; else echo FAILED; fi`], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_RETRY_SLEEPS: '0 0 0' },
    encoding: 'utf8',
  });
  return { stdout: r.stdout, calls: Number(readFileSync(count, 'utf8')) };
}

test('gh_retry survives a transient HTTP 500 (2026-11-24 chain stall)', () => {
  const r = run(2);
  assert.match(r.stdout, /^OK \[/);
  assert.equal(r.calls, 3);
});

test('gh_retry gives up after four attempts instead of looping', () => {
  const r = run(99);
  assert.match(r.stdout, /FAILED/);
  assert.equal(r.calls, 4);
});

test('queue scripts dispatch anyway when the run list keeps failing', () => {
  for (const name of ['queue-snapshot.sh', 'queue-fast-scan.sh', 'queue-watch.sh']) {
    const src = readFileSync(resolve('runner', name), 'utf8');
    assert.match(src, /gh_retry gh run list/, name);
    assert.match(src, /choice="dispatch"/, name);
  }
});
