import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationTurns } from './conversation.mjs';
import { replySuggestions } from './suggestions.mjs';

function turns(...pairs) {
  return conversationTurns(pairs.flatMap(([text, reply]) => [
    { kind: 'user', text },
    { kind: 'assistant', text: reply },
  ]));
}

test('the same generic completion yields different follow-ups from each session', () => {
  const sharing = turns(['「分享链接」能用了吗？', '已经修复，测试通过。']);
  const paging = turns(['「历史页码」能用了吗？', '已经修复，测试通过。']);
  const first = replySuggestions(sharing);
  const second = replySuggestions(paging);
  assert.match(first[0].label, /分享链接/);
  assert.match(second[0].label, /历史页码/);
  assert.notEqual(first[0].token, second[0].token);
  assert.deepEqual(replySuggestions(sharing), first);
});

test('uses the latest reply and two previous rounds, with at most three distinct subjects', () => {
  const suggestions = replySuggestions(turns(
    ['旧改动', '建议检查「旧入口」。'],
    ['错误', '飞书报错 200673，已找到原因。'],
    ['表格', '「表格上限」已经验证。'],
    ['下一步', '「窄屏布局」仍需确认。'],
  ));
  assert.equal(suggestions.length, 3);
  assert.match(suggestions[0].text, /窄屏布局/);
  assert.ok(suggestions.some(({ text }) => /200673/.test(text)));
  assert.ok(suggestions.some(({ text }) => /表格上限/.test(text)));
  assert.ok(suggestions.every(({ text }) => !/旧入口/.test(text)));
});

test('skips replies with no grounded subject or only a code example', () => {
  assert.deepEqual(replySuggestions(turns(['现在几点？', '现在是凌晨三点。'])), []);
  const fence = '`'.repeat(3);
  assert.deepEqual(replySuggestions(turns(['好的', `${fence}txt\n「旧入口」测试失败\n${fence}`])), []);
  assert.deepEqual(replySuggestions(conversationTurns([{ kind: 'user', text: '检查历史页码' }])), []);
});
