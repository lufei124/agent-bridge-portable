import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationPage, conversationTurns, markdownTableStarts, messageTextPages } from './conversation.mjs';

test('paginates whole rounds latest first, with assistant fragments grouped', () => {
  const messages = Array.from({ length: 23 }, (_, n) => [
    { kind: 'user', text: `question ${n}` },
    { kind: 'assistant', text: 'first paragraph' },
    { kind: 'tool', text: 'ignored' },
    { kind: 'assistant', text: 'second paragraph' },
  ]).flat();
  const turns = conversationTurns(messages);
  const pages = [0, 1, 2].map((page) => conversationPage(turns, page));
  assert.deepEqual(pages.map((page) => page.length), [20, 20, 6]);
  assert.deepEqual(pages.map((page) => page[0].text), ['question 13', 'question 3', 'question 0']);
  assert.deepEqual(pages[0][1].parts, ['first paragraph', 'second paragraph']);
  assert.equal(conversationPage(turns, 3).length, 0);
});

test('preserves all characters and keeps each expanded segment bounded', () => {
  const text = '一行🟢\n引用 "\\路径"\n'.repeat(1500);
  const segments = messageTextPages(text);
  assert.ok(segments.length > 1);
  assert.ok(segments.every((part) => Buffer.byteLength(JSON.stringify(JSON.stringify(part))) <= 5006));
  assert.equal(segments.join(''), text);
});

test('splits many Markdown tables at their headers without counting fenced code', () => {
  const table = '| 项目 | 数值 |\n| :--- | ---: |\n| 数据 | 1 |\n\n';
  const fenced = '\x60\x60\x60md\n' + table + '\x60\x60\x60\n\n';
  const text = fenced + table.repeat(6);
  const segments = messageTextPages(text);
  assert.equal(markdownTableStarts(fenced).length, 0);
  assert.deepEqual(segments.map((segment) => markdownTableStarts(segment).length), [4, 2]);
  assert.equal(segments[1], table.repeat(2));
  assert.equal(segments.join(''), text);
});
