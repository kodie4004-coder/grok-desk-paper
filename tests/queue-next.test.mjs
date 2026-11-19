import test from 'node:test';
import assert from 'node:assert/strict';
import { decision, otherActive } from '../runner/queue-next.mjs';

const self = 44441797302;

test('an empty in-progress list still dispatches', () => {
  // The 02:09Z run was alive and the API returned no in-progress rows.
  assert.equal(otherActive([], self).length, 0);
  assert.equal(decision([], self), 'dispatch');
});

test('this run being in progress does not count as someone else', () => {
  const runs = [{ databaseId: self, status: 'in_progress' }];
  assert.equal(decision(runs, self), 'dispatch');
});

test('a queued or running successor skips another dispatch', () => {
  const runs = [
    { databaseId: self, status: 'in_progress' },
    { databaseId: self + 1, status: 'queued' },
  ];
  assert.equal(decision(runs, self), 'skip');
  assert.equal(decision([{ databaseId: 9, status: 'waiting' }], self), 'skip');
  assert.equal(decision([{ databaseId: 9, status: 'completed' }], self), 'dispatch');
});

test('a missing list is an error, not a silent skip', () => {
  assert.throws(() => decision(null, self), /run list is missing/);
  assert.throws(() => decision([], 'nope'), /run list is missing/);
});
