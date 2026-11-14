import test from 'node:test';
import assert from 'node:assert/strict';
import { filterFromMenuText, normalizeListFilter } from './platforms.mjs';

test('menu text opens one platform list', () => {
  assert.equal(filterFromMenuText('Claude'), 'claude-code');
  assert.equal(filterFromMenuText('codex'), 'codex');
  assert.equal(filterFromMenuText('DeepSeek'), 'deepseek');
  assert.equal(filterFromMenuText('Cursor'), '');
  assert.equal(filterFromMenuText('workbuddy'), '');
  assert.equal(filterFromMenuText('随便一句话'), '');
});

test('unknown filters fall back to all sessions', () => {
  assert.equal(normalizeListFilter('codex'), 'codex');
  assert.equal(normalizeListFilter('deepseek'), 'deepseek');
  assert.equal(normalizeListFilter('cursor'), 'all');
  assert.equal(normalizeListFilter('workbuddy'), 'all');
});
