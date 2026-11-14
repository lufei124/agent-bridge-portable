import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexFreshArgs, codexResumeArgs, dshLaunchArgs, exeBesideNpmCmd, newestCodexExe, resolveDshLaunch } from './runner.mjs';

test('codex resume keeps the prompt as one argument', () => {
  const args = codexResumeArgs({
    sessionId: 'abc-123',
    cwd: 'E:/work/demo',
    prompt: '继续改登录页',
  });
  assert.deepEqual(args.slice(0, 4), ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox']);
  assert.deepEqual(args.slice(-5), ['-C', 'E:/work/demo', 'resume', 'abc-123', '继续改登录页']);
});

test('codex creates a saved session with the chosen directory and a literal first prompt', () => {
  assert.deepEqual(codexFreshArgs({ cwd: 'E:/My Project', prompt: '--help' }), [
    'exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', 'E:/My Project', '--', '--help',
  ]);
});

test('deepseek resume targets the saved session id', () => {
  const args = dshLaunchArgs({ sessionId: 'session-abc', prompt: '看下报错' });
  assert.deepEqual(args, [
    '--profile',
    'headless',
    '--patch',
    args[3],
    '--session-id',
    'session-abc',
    '--json',
    '--approval-policy',
    'never',
    '--permission-mode',
    'workspace-write',
    '--',
    '看下报错',
  ]);
  assert.equal(path.basename(args[3]), 'dsh-credentials.patch.yml');
  assert.match(fs.readFileSync(args[3], 'utf8'), /id: credentials\s+disabled: false/);
});

test('deepseek fresh runs let the CLI allocate a new id', () => {
  const args = dshLaunchArgs({ prompt: '--help' });
  assert.ok(!args.includes('--session-id'));
  assert.deepEqual(args.slice(-2), ['--', '--help']);
});

test('deepseek runs a configured JS entry with the bridge Node even outside PATH', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-dsh-bin-'));
  const script = path.join(dir, 'bin.js');
  fs.writeFileSync(script, '');
  const previous = process.env.BRIDGE_DSH_BIN;
  const previousNode = process.env.BRIDGE_DSH_NODE;
  t.after(() => {
    if (previous === undefined) delete process.env.BRIDGE_DSH_BIN;
    else process.env.BRIDGE_DSH_BIN = previous;
    if (previousNode === undefined) delete process.env.BRIDGE_DSH_NODE;
    else process.env.BRIDGE_DSH_NODE = previousNode;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env.BRIDGE_DSH_BIN = script;
  delete process.env.BRIDGE_DSH_NODE;
  assert.deepEqual(resolveDshLaunch(), { command: process.execPath, prefix: [script] });
  const node = path.join(dir, 'node.exe');
  fs.writeFileSync(node, '');
  process.env.BRIDGE_DSH_NODE = node;
  assert.deepEqual(resolveDshLaunch(), { command: node, prefix: [script] });
});

test('npm cmd shim resolves to the neighboring exe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-shim-'));
  const exe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  const cmd = path.join(dir, 'claude.cmd');
  fs.writeFileSync(cmd, '');
  assert.equal(
    exeBesideNpmCmd(cmd, ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe']),
    exe
  );
});

test('picks the newest codex.exe under the install directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-codex-'));
  const older = path.join(root, 'old', 'codex.exe');
  const newer = path.join(root, 'new', 'codex.exe');
  fs.mkdirSync(path.dirname(older), { recursive: true });
  fs.mkdirSync(path.dirname(newer), { recursive: true });
  fs.writeFileSync(older, '');
  fs.writeFileSync(newer, '');
  const past = new Date('2020-01-01T00:00:00Z');
  const now = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(older, past, past);
  fs.utimesSync(newer, now, now);
  assert.equal(newestCodexExe(root), newer);
});
