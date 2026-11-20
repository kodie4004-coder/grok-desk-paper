import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchdogDecision, STALE_MS } from '../runner/watch-snapshot.mjs';

const root = new URL('..', import.meta.url);
const script = fileURLToPath(new URL('../runner/push-snapshot.sh', import.meta.url));
const now = Date.parse('2026-11-20T06:35:00Z');

test('a snapshot older than 10 minutes is dispatched, a live one is not', () => {
  assert.equal(STALE_MS, 10 * 60 * 1000);
  const stale = [{ status: 'completed', updatedAt: '2026-11-20T04:49:16Z' }];
  assert.equal(watchdogDecision(stale, now), 'dispatch');
  const fresh = [{ status: 'completed', updatedAt: '2026-11-20T06:30:00Z' }];
  assert.equal(watchdogDecision(fresh, now), 'skip');
  const running = [
    { status: 'completed', updatedAt: '2026-11-20T04:49:16Z' },
    { status: 'in_progress', updatedAt: '2026-11-20T06:34:00Z' },
  ];
  assert.equal(watchdogDecision(running, now), 'skip');
  assert.equal(watchdogDecision([], now), 'dispatch');
  assert.throws(() => watchdogDecision(null, now), /run list is missing/);
});

test('the workflows retry a rejected push and keep the chain alive', () => {
  const snap = readFileSync(new URL('.github/workflows/kalshi-15m.yml', root), 'utf8');
  const kick = readFileSync(new URL('.github/workflows/kalshi-15m-kick.yml', root), 'utf8');
  assert.match(snap, /bash runner\/push-snapshot\.sh/);
  assert.match(snap, /if: always\(\)/);
  assert.match(snap, /queue-snapshot\.sh/);
  assert.match(kick, /cron: '\*\/10 \* \* \* \*'/);
  assert.match(kick, /workflow_run:/);
  assert.match(kick, /group: kalshi-15m-kick/);
  assert.match(kick, /cancel-in-progress: false/);
  assert.match(kick, /watch-snapshot\.mjs/);
  assert.match(readFileSync(new URL('runner/push-snapshot.sh', root), 'utf8'), /git rebase origin\/main/);
});

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function repo(path) {
  mkdirSync(path, { recursive: true });
  git(path, ['init', '-b', 'main']);
  git(path, ['config', 'user.email', 'test@example.com']);
  git(path, ['config', 'user.name', 'test']);
  git(path, ['config', 'commit.gpgsign', 'false']);
}

function identity(path) {
  git(path, ['config', 'user.email', 'test@example.com']);
  git(path, ['config', 'user.name', 'test']);
  git(path, ['config', 'commit.gpgsign', 'false']);
}

function pushSnapshot(cwd) {
  execFileSync('bash', [script], {
    cwd,
    env: { ...process.env, SNAP_PUSH_SLEEP: '0', GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
  });
}

test('a rejected push is rebased onto the moved main and retried', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-push-'));
  try {
    const bare = join(dir, 'bare.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
    const seed = join(dir, 'seed');
    repo(seed);
    writeFileSync(join(seed, 'README.md'), 'base\n');
    mkdirSync(join(seed, 'data'));
    writeFileSync(join(seed, 'data', 'kalshi-15m.json'), '{"n":1}\n');
    git(seed, ['add', '.']);
    git(seed, ['commit', '-m', 'base']);
    git(seed, ['remote', 'add', 'origin', bare]);
    git(seed, ['push', 'origin', 'main']);

    const stale = join(dir, 'stale');
    execFileSync('git', ['clone', '--depth', '1', bare, stale]);
    identity(stale);
    const landed = join(dir, 'landed');
    execFileSync('git', ['clone', bare, landed]);
    identity(landed);
    writeFileSync(join(landed, 'README.md'), 'pull request landed\n');
    git(landed, ['add', 'README.md']);
    git(landed, ['commit', '-m', 'merge a pull request']);
    git(landed, ['push', 'origin', 'main']);

    writeFileSync(join(stale, 'data', 'kalshi-15m.json'), '{"n":2}\n');
    pushSnapshot(stale);

    const check = join(dir, 'check');
    execFileSync('git', ['clone', bare, check]);
    assert.equal(readFileSync(join(check, 'data', 'kalshi-15m.json'), 'utf8'), '{"n":2}\n');
    assert.match(readFileSync(join(check, 'README.md'), 'utf8'), /pull request landed/);
    const log = git(check, ['log', '--oneline']);
    assert.match(log, /Update the Kalshi paper snapshot/);
    assert.match(log, /merge a pull request/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rebase conflict keeps the snapshot that was just collected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-conflict-'));
  try {
    const bare = join(dir, 'bare.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
    const seed = join(dir, 'seed');
    repo(seed);
    mkdirSync(join(seed, 'data'));
    writeFileSync(join(seed, 'README.md'), 'base\n');
    writeFileSync(join(seed, 'data', 'kalshi-15m.json'), '{"n":1}\n');
    git(seed, ['add', '.']);
    git(seed, ['commit', '-m', 'base']);
    git(seed, ['remote', 'add', 'origin', bare]);
    git(seed, ['push', 'origin', 'main']);

    const stale = join(dir, 'stale');
    execFileSync('git', ['clone', '--depth', '1', bare, stale]);
    identity(stale);
    const landed = join(dir, 'landed');
    execFileSync('git', ['clone', bare, landed]);
    identity(landed);
    writeFileSync(join(landed, 'data', 'kalshi-15m.json'), '{"n":9,"from":"main"}\n');
    git(landed, ['commit', '-am', 'another snapshot already landed']);
    git(landed, ['push', 'origin', 'main']);

    writeFileSync(join(stale, 'data', 'kalshi-15m.json'), '{"n":2,"from":"this-run"}\n');
    pushSnapshot(stale);

    const check = join(dir, 'check');
    execFileSync('git', ['clone', bare, check]);
    assert.equal(readFileSync(join(check, 'data', 'kalshi-15m.json'), 'utf8'), '{"n":2,"from":"this-run"}\n');
    assert.match(git(check, ['log', '--oneline']), /another snapshot already landed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
