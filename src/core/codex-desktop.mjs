import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const PIPE = '\\\\.\\pipe\\codex-ipc';
const MAX_FRAME_BYTES = 256 * 1024 * 1024;
const REQUEST_TIMEOUT = 12_000;
const TURN_TIMEOUT = 15 * 60_000;

function connectDesktop(endpoint) {
  const socket = createConnection(endpoint);
  const pending = new Map();
  let buffer = Buffer.alloc(0);
  let clientId = 'initializing-client';
  let closed = false;
  let onBroadcast;

  function close(error = new Error('connection-closed')) {
    closed = true;
    socket.destroy();
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  function send(message) {
    const body = Buffer.from(JSON.stringify(message));
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32LE(body.length);
    body.copy(frame, 4);
    socket.write(frame);
  }

  function receive(message) {
    if (message.type === 'client-discovery-request') {
      send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
    } else if (message.type === 'response') {
      const request = pending.get(message.requestId);
      if (message.resultType === 'success') request?.resolve(message);
      else request?.reject(Object.assign(new Error(String(message.error || 'request-rejected')), { rejected: true }));
    } else if (message.type === 'broadcast') {
      onBroadcast?.(message);
    }
  }

  socket.on('error', close);
  socket.on('close', () => close());
  socket.on('data', (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    try {
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE();
        if (!length || length > MAX_FRAME_BYTES) throw new Error('invalid-frame');
        if (buffer.length < length + 4) return;
        const message = JSON.parse(buffer.toString('utf8', 4, length + 4));
        buffer = buffer.subarray(length + 4);
        receive(message);
      }
    } catch (error) {
      close(error);
    }
  });

  function request(method, version, params, targetClientId) {
    if (closed) return Promise.reject(new Error('connection-closed'));
    const requestId = randomUUID();
    let timer;
    return new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('request-timeout')), REQUEST_TIMEOUT);
      pending.set(requestId, { resolve, reject });
      send({ type: 'request', requestId, sourceClientId: clientId, method, version, params, targetClientId });
    }).finally(() => {
      clearTimeout(timer);
      pending.delete(requestId);
    });
  }

  return {
    close,
    isClosed: () => closed,
    request,
    async discover(sessionId) {
      const hello = await request('initialize', 0, { clientType: 'agent-bridge' });
      clientId = hello.result?.clientId;
      if (!clientId) throw new Error('invalid-client');
      return request('thread-owner-discovery', 1, { hostId: 'local', conversationId: sessionId });
    },
    follow(sessionId, owner, receiveState) {
      onBroadcast = (message) => {
        const { sourceClientId, method, params } = message;
        if (sourceClientId !== owner || method !== 'thread-stream-state-changed' ||
            params?.conversationId !== sessionId || (params.hostId && params.hostId !== 'local')) return;
        receiveState(params.change);
      };
      send({
        type: 'broadcast', sourceClientId: clientId, version: 1,
        method: 'thread-stream-following-changed', targetClientIds: [owner],
        params: { hostId: 'local', conversationId: sessionId, following: true },
      });
    },
  };
}

function followDesktopThread(connection, sessionId, owner) {
  let status;
  let revision;
  connection.follow(sessionId, owner, (change) => {
    if (change?.type === 'snapshot') {
      status = change.conversationState?.threadRuntimeStatus?.type;
      revision = change.revision;
    } else if (change?.type === 'patches') {
      if (revision === undefined || change.baseRevision !== revision) {
        status = undefined;
        return;
      }
      revision = change.revision;
      for (const patch of change.patches || []) {
        if (patch.path?.length === 1 && patch.path[0] === 'threadRuntimeStatus') status = patch.value?.type;
        if (patch.path?.length === 2 && patch.path[0] === 'threadRuntimeStatus' && patch.path[1] === 'type') status = patch.value;
      }
    }
  });
  return () => status;
}

async function waitFor(predicate, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await delay(500);
  }
  return false;
}

const failed = (stderr, extra = {}) => ({ code: 1, stderr, trustExit: true, ...extra });

export async function runDesktopCodex({ sessionId, prompt, confirmTurn, onDesktop }, endpoint) {
  if (!endpoint && process.platform !== 'win32') return null;
  const connection = connectDesktop(endpoint ?? PIPE);
  let dispatched = false;
  try {
    let discovery;
    try {
      discovery = await connection.discover(sessionId);
    } catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code) || error.message === 'no-client-found') return null;
      return failed('CODEX_DESKTOP_UNAVAILABLE');
    }
    if (!discovery.handledByClientId || discovery.result?.supportsUntrustedAppInput !== true) {
      return failed('CODEX_DESKTOP_UNAVAILABLE');
    }
    onDesktop?.();
    const owner = discovery.handledByClientId;
    const status = followDesktopThread(connection, sessionId, owner);
    if (!await waitFor(() => status() || connection.isClosed(), 5000) || connection.isClosed()) {
      return failed('CODEX_DESKTOP_UNAVAILABLE');
    }
    if (!await waitFor(() => status() === 'idle' || connection.isClosed(), TURN_TIMEOUT)) {
      return failed('CODEX_DESKTOP_BUSY');
    }
    if (connection.isClosed()) return failed('CODEX_DESKTOP_UNAVAILABLE');

    const text = String(prompt).slice(0, 8000);
    const id = randomUUID();
    dispatched = true;
    const accepted = await connection.request('thread-follower-start-turn', 2, {
      conversationId: sessionId,
      turnStart: {
        request: { threadId: sessionId, clientUserMessageId: id, input: [{ type: 'text', text, text_elements: [] }] },
        context: {
          inheritThreadSettings: true,
          restoreMessage: {
            id,
            text,
            context: {
              prompt: text, workspaceRoots: [], imageAttachments: [], fileAttachments: [],
              addedFiles: [], commentAttachments: [], responseTextAnnotations: [], attachmentOrder: [],
            },
          },
        },
      },
    }, owner);
    const turnId = accepted.result?.result?.turn?.id ?? accepted.result?.turn?.id;
    if (typeof turnId !== 'string' || !turnId) return failed('CODEX_DESKTOP_UNCONFIRMED', { noResend: true });
    const result = await waitFor(() => confirmTurn(turnId, text), TURN_TIMEOUT);
    if (!result) return failed('CODEX_DESKTOP_UNCONFIRMED', { noResend: true });
    if (result !== 'completed') return failed('CODEX_DESKTOP_TURN_FAILED', { noResend: true });
    return { code: 0, stderr: '', trustExit: true, desktop: true };
  } catch (error) {
    if (dispatched && error.rejected &&
        /^(?:no-client-found|client-not-found|no-handler-for-request|request-version-mismatch)$/.test(error.message)) {
      return failed('CODEX_DESKTOP_UNAVAILABLE');
    }
    return dispatched ? failed('CODEX_DESKTOP_UNCONFIRMED', { noResend: true }) : failed('CODEX_DESKTOP_UNAVAILABLE');
  } finally {
    connection.close();
  }
}
