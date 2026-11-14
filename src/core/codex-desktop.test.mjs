import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { runDesktopCodex } from './codex-desktop.mjs';

async function desktopFixture(t, { ownerFound = true, dropAfterSend = false } = {}) {
  const requests = [];
  const target = 'test-thread';
  const owner = 'test-desktop';
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    function send(message) {
      const body = Buffer.from(JSON.stringify(message));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    }
    function broadcast(change) {
      send({
        type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: owner,
        params: { conversationId: target, hostId: 'local', change },
      });
    }
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const end = 4 + buffer.readUInt32LE();
        const request = JSON.parse(buffer.toString('utf8', 4, end));
        buffer = buffer.subarray(end);
        requests.push(request);
        const reply = { type: 'response', resultType: 'success', requestId: request.requestId };
        if (request.method === 'initialize') send({ ...reply, result: { clientId: 'bridge' } });
        if (request.method === 'thread-owner-discovery') {
          send(ownerFound
            ? { ...reply, handledByClientId: owner, result: { supportsUntrustedAppInput: true } }
            : { ...reply, resultType: 'error', error: 'no-client-found' });
        }
        if (request.method === 'thread-stream-following-changed') {
          broadcast({ type: 'snapshot', revision: 1, conversationState: { threadRuntimeStatus: { type: 'active' } } });
          setTimeout(() => broadcast({
            type: 'patches', baseRevision: 1, revision: 2,
            patches: [{ path: ['threadRuntimeStatus'], value: { type: 'idle' } }],
          }), 600);
        }
        if (request.method === 'thread-follower-start-turn') {
          if (dropAfterSend) socket.destroy();
          else send({ ...reply, result: { result: { turn: { id: 'desktop-turn' } } } });
        }
      }
    });
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\agent-bridge-test-${randomUUID()}`
    : path.join(os.tmpdir(), `agent-bridge-test-${randomUUID()}.sock`);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  return { requests, target, owner, endpoint };
}

test('routes a local turn to the exact owner after the desktop becomes idle', async (t) => {
  const { requests, target, owner, endpoint } = await desktopFixture(t);
  const result = await runDesktopCodex({
    sessionId: target, prompt: '验证同一会话',
    confirmTurn: (turnId, prompt) => turnId === 'desktop-turn' && prompt === '验证同一会话' ? 'completed' : '',
  }, endpoint);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.desktop, true);
  assert.equal(requests.filter(({ method }) => method === 'thread-follower-start-turn').length, 1);
  const request = requests.at(-1);
  assert.equal(request.targetClientId, owner);
  assert.equal(request.params.conversationId, target);
  assert.equal(request.params.turnStart.request.threadId, target);
  assert.equal(request.params.turnStart.context.inheritThreadSettings, true);
  assert.equal(request.params.turnStart.request.input[0].text, '验证同一会话');
  assert.equal(request.params.turnStart.context.restoreMessage.id, request.params.turnStart.request.clientUserMessageId);
});

test('allows CLI fallback only before sending when there is no desktop owner', async (t) => {
  const { requests, target, endpoint } = await desktopFixture(t, { ownerFound: false });
  assert.equal(await runDesktopCodex({ sessionId: target, prompt: '测试' }, endpoint), null);
  assert.deepEqual(requests.map(({ method }) => method), ['initialize', 'thread-owner-discovery']);
});

test('does not resend when the connection closes after dispatch', async (t) => {
  const { requests, target, endpoint } = await desktopFixture(t, { dropAfterSend: true });
  const result = await runDesktopCodex({ sessionId: target, prompt: '测试' }, endpoint);
  assert.equal(result.stderr, 'CODEX_DESKTOP_UNCONFIRMED');
  assert.equal(result.noResend, true);
  assert.equal(requests.filter(({ method }) => method === 'thread-follower-start-turn').length, 1);
});
