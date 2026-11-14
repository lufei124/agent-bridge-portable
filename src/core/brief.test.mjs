import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationBrief, usefulProject } from './brief.mjs';

test('uses the request and skips the reminder', () => {
  const text = '<system-reminder>内部提示</system-reminder>\n帮我看下登录页为什么打不开';
  assert.equal(conversationBrief(text), '帮我看下登录页为什么打不开');
});

test('ignores an id, a timestamp, and an environment block', () => {
  assert.equal(conversationBrief('a271aa9b'), '');
  assert.equal(conversationBrief('<timestamp>Saturday, Nov 14, 2026, 10:18 PM (UTC)</timestamp>'), '');
  assert.equal(conversationBrief('<environment_context>cwd=/tmp</environment_context>'), '');
});

test('keeps a real project name and hides generated ones', () => {
  assert.equal(usefulProject('UGit'), 'UGit');
  assert.equal(usefulProject('restartlife-jiwei'), 'restartlife-jiwei');
  assert.equal(usefulProject('scratch-2026-10-28-9e1237'), '');
  assert.equal(usefulProject('unruffled-chatelet-28f225'), '');
});

test('skips fenced code and structured output when selecting a preview', () => {
  const text = ['```js', 'console.log("debug");', '```', '{"session_id":"abc"}', '登录页已修复'].join('\n');
  assert.equal(conversationBrief(text), '登录页已修复');
  assert.equal(conversationBrief('~~~js\nconst example = 1;\n~~~'), '');
});

test('uses the actual request below the attachment metadata', () => {
  const text = '# Files mentioned by the user:\n\n## image.png: C:/tmp/image.png\nImage attachment: true\n\n## My request:\n帮我看看为什么发不出去';
  assert.equal(conversationBrief(text), '帮我看看为什么发不出去');
});
