import test from 'node:test';
import assert from 'node:assert/strict';
import { DEEPSEEK_PRESET_REASON, explainFailure } from './failure.mjs';

test('explains the DeepSeek preset rejection without offering a retry', () => {
  const stderr = 'dsh: session "session-00000000-0000-4401-a000-000000000000" runs under agent preset "standard", which the one-shot runner does not compose';
  assert.deepEqual(explainFailure(stderr, 'deepseek'), { detail: DEEPSEEK_PRESET_REASON, retry: false });
});

test('matches real HTTP auth errors, without matching digits inside a session id', () => {
  assert.match(explainFailure('HTTP 401 Unauthorized', 'codex').detail, /Codex/);
  assert.doesNotMatch(explainFailure('failed to open session 00000000-0000-4401-a000-000000000000', 'deepseek').detail, /登录|身份验证/);
});

test('identifies Codex desktop ownership and missing DeepSeek credentials separately', () => {
  const busy = explainFailure('thread has already changed: thread 123 already has an active writer', 'codex');
  assert.match(busy.detail, /关闭这个 Codex 会话/);
  assert.equal(busy.retry, true);
  const missing = explainFailure('dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route', 'deepseek');
  assert.match(missing.detail, /保存 API Key/);
  assert.equal(missing.retry, true);
});

test('identifies a DeepSeek startup write permission failure', () => {
  const failure = explainFailure('DSH_WEB_START_FAILED Error: EPERM: operation not permitted', 'deepseek');
  assert.equal(failure.title, 'Windows 拒绝写入 DeepSeek 配置');
  assert.equal(failure.retry, true);
});
