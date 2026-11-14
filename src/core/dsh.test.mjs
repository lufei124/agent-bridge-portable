import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodeDshBuffer, dshTurnReason, parseDshLog } from './dsh.mjs';

function line(record) {
  return JSON.stringify(record);
}

const sample = [
  line({
    type: 'session',
    id: 'session-abc',
    createdAt: 1_700_000_000_000,
    cwd: 'E:/work/demo',
  }),
  line({
    type: 'user/message',
    time: 1_700_000_000_100,
    data: { content: [{ type: 'text', text: '帮我改登录页\n第二行不要当标题' }], role: 'user' },
  }),
  line({ type: 'turn/start', time: 1_700_000_000_200, data: { turn: 1 } }),
  line({
    type: 'assistant/message',
    time: 1_700_000_000_300,
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '不要显示' },
          { type: 'text', text: '改好了' },
        ],
      },
    },
  }),
  line({ type: 'session/title', time: 1_700_000_000_400, data: { title: '改登录页' } }),
  line({ type: 'turn/end', time: 1_700_000_000_500, data: { turn: 1 } }),
].join('\n');

test('reads id, folder, title and the dialogue', () => {
  const parsed = parseDshLog(sample);
  assert.equal(parsed.id, 'session-abc');
  assert.equal(parsed.cwd, 'E:/work/demo');
  assert.equal(parsed.title, '改登录页');
  assert.equal(parsed.running, false);
  assert.deepEqual(
    parsed.messages.map((m) => [m.kind, m.text]),
    [
      ['user', '帮我改登录页\n第二行不要当标题'],
      ['assistant', '改好了'],
    ]
  );
});

test('an open turn is running, and the first user line titles a session without a title event', () => {
  const text = [
    line({ type: 'session', id: 'session-xyz', cwd: 'E:/work/demo' }),
    line({
      type: 'user/message',
      time: 10,
      data: { content: [{ type: 'text', text: '第一句' }] },
    }),
    line({ type: 'turn/start', time: 11, data: { turn: 1 } }),
  ].join('\n');
  const parsed = parseDshLog(text);
  assert.equal(parsed.running, true);
  assert.equal(parsed.title, '第一句');
});

test('decodes concatenated zstd frames', () => {
  const frames = sample
    .split('\n')
    .map((row) => zlib.zstdCompressSync(Buffer.from(`${row}\n`)));
  const parsed = parseDshLog(decodeDshBuffer(Buffer.concat(frames)));
  assert.equal(parsed.id, 'session-abc');
  assert.equal(parsed.messages.at(-1).text, '改好了');
});

test('uses the most recent preset selection and supports logs without a preset', () => {
  const text = [
    line({ type: 'session', id: 'session-xyz', agentPreset: 'standard' }),
    line({ type: 'agent-preset/selected', data: { agentPreset: 'custom' } }),
  ].join('\n');
  assert.equal(parseDshLog(text).agentPreset, 'custom');
  assert.equal(parseDshLog(sample).agentPreset, '');
});

test('confirms only a turn after the matching DeepSeek prompt receipt', () => {
  const text = [
    line({ type: 'turn/end', data: { reason: { kind: 'completed' } } }),
    line({ type: 'user/message', data: { source: { rpcId: 'current-request' } } }),
    line({ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'QUOTA' } } } }),
  ].join('\n');
  assert.equal(dshTurnReason(text, 'old-request'), undefined);
  assert.equal(dshTurnReason(text, 'current-request').error.code, 'QUOTA');
});
