import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexStore, mergeCodexParts, parseCodexLog } from './codex.mjs';

function line(record) {
  return JSON.stringify(record);
}

const sample = [
  line({
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'session_meta',
    payload: { session_id: 'abc-123', cwd: 'E:/work/demo' },
  }),
  line({
    timestamp: '2026-01-01T00:00:01.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: '系统提示，不要显示' }],
    },
  }),
  line({
    timestamp: '2026-01-01T00:00:02.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '帮我改登录页\n第二行不要当标题' }],
    },
  }),
  line({
    timestamp: '2026-01-01T00:00:03.000Z',
    type: 'event_msg',
    payload: { type: 'task_started' },
  }),
  line({
    timestamp: '2026-01-01T00:00:04.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '改好了' }],
    },
  }),
  line({
    timestamp: '2026-01-01T00:00:05.000Z',
    type: 'event_msg',
    payload: { type: 'task_complete' },
  }),
].join('\n');

test('reads id, folder, title and the dialogue', () => {
  const parsed = parseCodexLog(sample);
  assert.equal(parsed.id, 'abc-123');
  assert.equal(parsed.cwd, 'E:/work/demo');
  assert.equal(parsed.title, '帮我改登录页');
  assert.equal(parsed.running, false);
  assert.deepEqual(
    parsed.messages.map((m) => [m.kind, m.text]),
    [
      ['user', '帮我改登录页\n第二行不要当标题'],
      ['assistant', '改好了'],
    ]
  );
});

test('reads the id field written by current Codex CLI rollouts', () => {
  const metadata = line({ type: 'session_meta', payload: { id: 'current-id', cwd: 'E:/work/demo' } });
  assert.equal(parseCodexLog(metadata).id, 'current-id');
});

test('a turn still marked started is running', () => {
  const text = [
    line({
      timestamp: '2026-01-01T00:00:03.000Z',
      type: 'event_msg',
      payload: { type: 'task_started' },
    }),
  ].join('\n');
  assert.equal(parseCodexLog(text).running, true);
});

test('drops a cut-off first line and keeps the newest messages', () => {
  const text = `{"not":"complete"\n${sample}`;
  const parsed = parseCodexLog(text, { dropPartialStart: true, historyLimit: 1 });
  assert.equal(parsed.id, 'abc-123');
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].kind, 'assistant');
});

test('title stays the first user line when the tail is newer', () => {
  const head = parseCodexLog(sample);
  const tail = parseCodexLog(
    line({
      timestamp: '2026-01-02T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '后来的一句' }],
      },
    })
  );
  const merged = mergeCodexParts(head, tail);
  assert.equal(merged.id, 'abc-123');
  assert.equal(merged.title, '帮我改登录页');
  assert.equal(merged.messages[0].text, '后来的一句');
});

test('uses the desktop title even when a rollout has no user messages', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-codex-title-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const titleFile = path.join(dir, 'session_index.jsonl');
  await fs.writeFile(path.join(dir, 'rollout-demo.jsonl'), sample.split('\n')[0]);
  await fs.writeFile(titleFile, [
    line({ id: 'abc-123', thread_name: '原来的标题' }),
    line({ id: 'abc-123', thread_name: '飞书卡片排查' }),
    '{"id":',
  ].join('\n'));
  const store = new CodexStore({ dir, titleFile });
  await store.scan();
  assert.equal(store.list()[0].title, '飞书卡片排查');
});
