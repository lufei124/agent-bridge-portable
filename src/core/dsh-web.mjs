import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const START_TIMEOUT_MS = 25_000;
const TURN_TIMEOUT_MS = 15 * 60_000;

export function localLaunchUrl(line) {
  if (!line.startsWith('dsh web: ')) return null;
  try {
    const url = new URL(line.slice('dsh web: '.length).trim());
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port &&
        url.pathname === '/' && !url.username && !url.password && url.searchParams.has('token')) return url;
  } catch {
    // Ignore startup lines other than the local authenticated URL.
  }
  return null;
}

export async function openDshWeb(launch, { cwd, onSpawn } = {}) {
  const child = spawn(launch.command, [
    ...launch.prefix, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open',
  ], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => {
    child.once('close', resolve);
  });
  const output = createInterface({ input: child.stdout });
  let startupError = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    startupError = (startupError + chunk).slice(-6000);
  });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    output.close();
  };
  try {
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DSH_WEB_START_TIMEOUT')), START_TIMEOUT_MS);
      const done = (callback) => (value) => {
        clearTimeout(timer);
        callback(value);
      };
      child.once('error', done(reject));
      void exited.then(done(() => reject(new Error(`DSH_WEB_START_FAILED ${startupError}`))));
      output.on('line', (line) => {
        const url = localLaunchUrl(line);
        if (url) done(resolve)(url);
      });
    });
    onSpawn?.(child.pid);
    const launchUrl = await ready;
    const auth = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    const cookie = auth.headers.getSetCookie()[0]?.split(';', 1)[0];
    await auth.body?.cancel();
    if (auth.status !== 303 || !cookie) throw new Error('DSH_WEB_AUTH_FAILED');
    const origin = launchUrl.origin;
    return {
      close,
      async call(method, request, timeoutMs = 15_000) {
        const rpcId = randomUUID();
        const response = await fetch(`${origin}/api/session/${method}`, {
          method: 'POST',
          redirect: 'error',
          headers: { cookie, origin, 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request', rpcId, method: `session/${method}`, payload: { args: { request } },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`DSH_WEB_RPC_HTTP ${response.status}`);
        }
        const envelope = await response.json();
        if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) throw new Error('DSH_WEB_RPC_INVALID');
        if (!envelope.result?.ok) {
          const error = new Error(envelope.result?.error?.message || 'DSH_WEB_RPC_REJECTED');
          error.code = envelope.result?.error?.code;
          throw error;
        }
        return envelope.result.value;
      },
    };
  } catch (error) {
    await close();
    if (error.message.includes('DSH_WEB_START') || error.message === 'DSH_WEB_AUTH_FAILED') throw error;
    throw new Error('DSH_WEB_START_FAILED', { cause: error });
  }
}

export async function runPresetSession(launch, { cwd, sessionId, prompt, onSpawn, confirmTurn }) {
  let host;
  let status = 'before-send';
  const failure = (stderr) => ({ code: 1, stderr, trustExit: true, noResend: status !== 'before-send' });
  try {
    host = await openDshWeb(launch, { cwd, onSpawn });
    const before = await host.call('state', { sessionId });
    if (before.running || before.queue?.length) return failure('session/writer-held');
    const requestId = randomUUID();
    status = 'sending';
    const sent = await host.call('prompt', {
      sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: String(prompt).slice(0, 8000) }],
    });
    if (!sent?.accepted) return failure('DSH_WEB_PROMPT_UNCONFIRMED');
    status = 'accepted';
    const result = await host.call('wait', {
      sessionId, afterSeq: before.cursor, maxMessages: 1, timeoutMs: TURN_TIMEOUT_MS,
    }, TURN_TIMEOUT_MS + 5000);
    if (result.reason !== 'idle') {
      await host.call('cancel', { sessionId }).catch(() => {});
      return failure(result.reason === 'input-required' ? 'DSH_WEB_INPUT_REQUIRED' : 'DSH_WEB_TURN_TIMEOUT');
    }
    const turn = await confirmTurn(requestId);
    if (turn?.kind !== 'completed') return failure(turn?.error?.code || 'DSH_WEB_REPLY_UNCONFIRMED');
    return { code: 0, stderr: '', trustExit: true };
  } catch (error) {
    if (status === 'sending' && ['session/writer-held', 'session/not-found'].includes(error.code)) {
      status = 'before-send';
    }
    return failure([error.code, error.message].filter(Boolean).join(' '));
  } finally {
    await host?.close();
  }
}
