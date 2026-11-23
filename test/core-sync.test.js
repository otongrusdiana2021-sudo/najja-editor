// (v1.13.2, V19) The editor's revision check (public/js/core/sync.js). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revCheck } from '../public/js/core/sync.js';

const clean = { baseRev: 3, dirty: false, saving: false };

test('a project the server no longer has (404) is "gone"; other errors only wait', () => {
  assert.equal(revCheck({ error: Object.assign(new Error('Project not found'), { status: 404 }) }, clean), 'gone');
  for (const status of [500, 502, 503, 0, undefined]) assert.equal(revCheck({ error: Object.assign(new Error('x'), { status }) }, clean), 'wait', `status ${status}`);
  assert.equal(revCheck({}, clean), 'wait', 'no answer');
});

test('newer on the server: followed when nothing changed here, left for the 409 when something did', () => {
  assert.equal(revCheck({ rev: 3 }, clean), 'same');
  assert.equal(revCheck({ rev: 2 }, clean), 'same');
  assert.equal(revCheck({ rev: 4 }, clean), 'follow');
  assert.equal(revCheck({ rev: 4 }, { ...clean, dirty: true }), 'mine');
  assert.equal(revCheck({ rev: 4 }, { ...clean, saving: true }), 'mine');
});
