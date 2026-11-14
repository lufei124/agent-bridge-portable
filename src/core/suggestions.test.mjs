import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { conversationTurns } from './conversation.mjs';
import { parseSuggestions, SessionSuggestions, suggestionContext } from './suggestions.mjs';

function context(...pairs) {
  return suggestionContext(conversationTurns(pairs.flatMap(([text, reply]) => [
    { kind: 'user', text },
    { kind: 'assistant', text: reply },
  ])));
}

test('only includes the latest three turns with a completed assistant reply', () => {
  const result = context(
    ['旧功能', '旧回复'],
    ['表格', '确认了表格上限'],
    ['样式', '更换了按钮尺寸'],
    ['分页', 'iOS 上还需要验证'],
  );
  assert.equal(result.length, 6);
  assert.equal(result[0].content, '表格');
  assert.equal(result.at(-1).content, 'iOS 上还需要验证');
  assert.deepEqual(suggestionContext(conversationTurns([{ kind: 'user', text: '继续' }])), []);
});

test('accepts at most three short, distinct suggestions', () => {
  const items = parseSuggestions(JSON.stringify({ suggestions: [
    { label: '按钮标题超出十个字的这个示例', text: '应跳过' },
    { label: 'iOS验证', text: '如何验证 iPhone 上的分页？' },
    { label: 'iOS验证', text: '重复标题应跳过' },
    { label: '跳到旧页', text: '跳到第 2 页后显示哪些消息？' },
    { label: '飞书版本', text: '最低支持哪个飞书版本？' },
    { label: '第四个', text: '超过数量限制' },
  ] }));
  assert.deepEqual(items.map((item) => item.label), ['iOS验证', '跳到旧页', '飞书版本']);
});

test('coalesces repeated generation and keeps separate sessions and turns isolated', async () => {
  const requests = [];
  const service = new SessionSuggestions((prompt) => new Promise((resolve) => requests.push({ prompt, resolve })));
  const pages = context(['页码怎么跳？', 'iOS 尚未验证。']);
  const tables = context(['表格能放几个？', '最多四个。']);
  service.request('pages', pages);
  service.request('pages', pages);
  service.request('tables', tables);
  assert.equal(requests.length, 2);
  assert.match(requests[0].prompt, /iOS 尚未验证/);
  assert.doesNotMatch(requests[0].prompt, /表格能放几个/);
  requests[0].resolve('{"suggestions":[{"label":"核验iOS","text":"怎样确认 iOS 跳页正常？"}]}');
  requests[1].resolve('{"suggestions":[]}');
  await setImmediate();
  assert.equal(service.read('pages', pages)[0].label, '核验iOS');
  assert.deepEqual(service.read('tables', pages), []);
  assert.deepEqual(service.read('pages', tables), []);
  service.request('pages', pages);
  service.request('tables', tables);
  assert.equal(requests.length, 2);
  service.request('pages', tables);
  assert.equal(requests.length, 3);
  assert.deepEqual(service.read('pages', pages), []);
  requests[2].resolve('{"suggestions":[]}');
});
