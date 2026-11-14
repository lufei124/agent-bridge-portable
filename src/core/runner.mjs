/**
 * 用 Claude Code CLI 把一条消息送进已有的会话。
 *
 * 已验证：`--resume <id> -p` 会追加到同一个 <id>.jsonl，
 * 所以输出会自动被 TranscriptStore 监听到，不需要解析 stdout 再转发。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { runPresetSession } from './dsh-web.mjs';
import { waitForDshTurn } from './dsh.mjs';

const WINDOWS_BIN = path.join(
  os.homedir(),
  'AppData',
  'Roaming',
  'npm',
  'node_modules',
  '@anthropic-ai',
  'claude-code',
  'bin',
  'claude.exe'
);

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DSH_CREDENTIALS_PATCH = fileURLToPath(new URL('./dsh-credentials.patch.yml', import.meta.url));

export function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  if (fs.existsSync(WINDOWS_BIN)) return WINDOWS_BIN;
  const beside = exeBesideNpmCmd(commandOnPath('claude.cmd'), [
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  ]);
  if (beside) return beside;
  return commandOnPath('claude.exe') || (process.platform === 'win32' ? 'claude.cmd' : 'claude');
}

export function exeBesideNpmCmd(cmdFile, relativeParts) {
  if (!cmdFile) return '';
  const candidate = path.join(path.dirname(cmdFile), ...relativeParts);
  try {
    return fs.existsSync(candidate) ? candidate : '';
  } catch {
    return '';
  }
}

export function newestCodexExe(binRoot) {
  if (!binRoot) return '';
  let entries;
  try {
    entries = fs.readdirSync(binRoot, { withFileTypes: true });
  } catch {
    return '';
  }
  let best = '';
  let bestTime = -1;
  for (const entry of entries) {
    const exe = entry.isDirectory() ? path.join(binRoot, entry.name, 'codex.exe') : '';
    if (!exe || !fs.existsSync(exe)) continue;
    const mtime = fs.statSync(exe).mtimeMs;
    if (mtime >= bestTime) {
      best = exe;
      bestTime = mtime;
    }
  }
  return best;
}

export function resolveCodexBin() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN;
  const local = process.env.LOCALAPPDATA
    ? newestCodexExe(path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin'))
    : '';
  return local || commandOnPath('codex.exe') || 'codex';
}

export function resolveDshLaunch() {
  if (process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN)) return { command: process.env.DSH_BIN, prefix: [] };
  const cmd = commandOnPath('dsh.cmd');
  if (!cmd) return { command: process.platform === 'win32' ? 'dsh.cmd' : 'dsh', prefix: [] };
  const dir = path.dirname(cmd);
  const script = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(script)) return { command: cmd, prefix: [] };
  const node = path.join(dir, 'node.exe');
  return { command: fs.existsSync(node) ? node : 'node', prefix: [script] };
}

export function codexResumeArgs({ sessionId, cwd, prompt }) {
  const args = ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
  if (cwd) args.push('-C', cwd);
  args.push('resume', sessionId, String(prompt).slice(0, 8000));
  return args;
}

export function dshLaunchArgs({ sessionId, prompt }) {
  return [
    '--profile',
    'headless',
    '--patch',
    DSH_CREDENTIALS_PATCH,
    ...(sessionId ? ['--session-id', sessionId] : []),
    '--json',
    '--approval-policy',
    'never',
    '--permission-mode',
    'workspace-write',
    '--',
    String(prompt).slice(0, 8000),
  ];
}

function pathDirs() {
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);
}

function commandOnPath(name) {
  for (const dir of pathDirs()) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

/**
 * Claude Code 把项目目录编码成 `g--Project` 这种形式（盘符小写，: 和 \ 换成 -）。
 * `--resume` 只在这个目录里找会话，cwd 对不上就报 "No conversation found"。
 */
export function encodeProjectDir(cwd) {
  return path
    .resolve(cwd)
    .replace(/[:\\/]/g, '-')
    .replace(/^([a-zA-Z])/, (c) => c.toLowerCase());
}

function sessionFile(cwd, sessionId) {
  return path.join(PROJECTS_DIR, encodeProjectDir(cwd), `${sessionId}.jsonl`);
}

/**
 * 反解编码目录名，试出真实路径。
 * `g--Project-agent-bridge` 里的 '-' 既可能是路径分隔符，也可能是文件夹名自带的连字符，
 * 所以枚举所有组合，取第一个真实存在的目录。
 */
function candidatesFromProjectDir(dirName) {
  const m = /^([a-zA-Z])--(.+)$/.exec(dirName);
  if (!m) return [];

  const drive = `${m[1].toUpperCase()}:\\`;
  const rest = m[2];
  const dashes = [];
  for (let i = 0; i < rest.length; i++) if (rest[i] === '-') dashes.push(i);

  const limit = Math.min(dashes.length, 8);
  const out = [];
  for (let mask = 0; mask < 1 << limit; mask++) {
    const chars = [...rest];
    for (let i = 0; i < limit; i++) if (mask & (1 << i)) chars[dashes[i]] = '\\';
    out.push(drive + chars.join(''));
  }
  return out;
}

/**
 * 找出能让 `--resume` 成功的工作目录。
 * 优先用记录里的 cwd，不行再从项目目录名反解。
 */
export function resolveResumeCwd({ sessionId, cwd, projectDir }) {
  if (cwd) {
    try {
      if (fs.existsSync(sessionFile(cwd, sessionId))) return { cwd, sure: true };
    } catch {
      /* 路径非法，走反解 */
    }
  }

  for (const candidate of candidatesFromProjectDir(projectDir || '')) {
    try {
      if (fs.existsSync(sessionFile(candidate, sessionId))) return { cwd: candidate, sure: true };
    } catch {
      /* 继续试下一个 */
    }
  }

  return { cwd: cwd || process.cwd(), sure: false };
}

/**
 * @returns {Promise<{code:number, stdout:string, stderr:string, timedOut:boolean}>}
 *
 * onEvent 会收到 stream-json 的每条事件，其中 --include-partial-messages
 * 会在模型生成过程中吐出 text_delta，手机端可以边写边看。
 */
export function runPrompt(options) {
  const target = resolveResumeCwd({
    sessionId: options.sessionId,
    cwd: options.cwd,
    projectDir: options.projectDir,
  });
  if (!target.sure) {
    console.warn(`[runner] 找不到 ${options.sessionId} 的会话文件，按 ${target.cwd} 试一次`);
  }
  return runClaude({
    ...options,
    cwd: target.cwd,
    args: ['--resume', options.sessionId],
  });
}

/** 新建会话：不 --resume，session_id 由 stream-json 的 system/init 事件带回来 */
export function runFresh(options) {
  if (options.platform === 'deepseek') return runDsh(options);
  return runClaude({ ...options, args: [] });
}

export function runSession(options) {
  const platform = options.platform || 'claude-code';
  if (platform === 'codex') return runCodex(options);
  if (platform === 'deepseek') {
    if (options.agentPreset) {
      return runPresetSession(resolveDshLaunch(), {
        ...options, confirmTurn: (requestId) => waitForDshTurn(options.file, requestId),
      });
    }
    return runDsh(options);
  }
  return runPrompt(options);
}

function runCodex(options) {
  return spawnCapture({
    command: resolveCodexBin(),
    args: codexResumeArgs(options),
    cwd: options.cwd,
    onSpawn: options.onSpawn,
    trustExit: true,
  }).then((result) => ({ ...result, trustExit: true }));
}

function runDsh(options) {
  const launch = resolveDshLaunch();
  return spawnCapture({
    command: launch.command,
    args: [...launch.prefix, ...dshLaunchArgs(options)],
    cwd: options.cwd,
    onSpawn: options.onSpawn,
    onEvent: options.onEvent,
    trustExit: true,
  }).then((result) => ({ ...result, trustExit: true }));
}

function runClaude({ args: baseArgs, cwd, prompt, timeoutMs = 15 * 60 * 1000, onSpawn, onEvent }) {
  const args = [
    ...baseArgs,
    '-p',
    String(prompt).slice(0, 8000),
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    'bypassPermissions',
  ];
  return spawnCapture({ command: resolveClaudeBin(), args, cwd, timeoutMs, onSpawn, onEvent });
}

function spawnCapture({ command, args, cwd, timeoutMs = 15 * 60 * 1000, onSpawn, onEvent }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: cwd || undefined,
        windowsHide: true,
        env: process.env,
        // 不关 stdin 的话，CLI 会等 3 秒才继续
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err?.message || err), timedOut: false });
      return;
    }

    // 把子进程 PID 交给调用方：巡逻时要能把它和"外部持有者"区分开
    if (typeof onSpawn === 'function' && child.pid) {
      try {
        onSpawn(child.pid);
      } catch {
        /* 回调出错不影响执行 */
      }
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let lineBuffer = '';
    let reportedError = '';
    child.stdout?.on('data', (d) => {
      const chunk = stdoutDecoder.write(d);
      stdout += chunk;
      lineBuffer += chunk;
      let index;
      while ((index = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, index).trim();
        lineBuffer = lineBuffer.slice(index + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'error' && typeof event.message === 'string') reportedError = event.message;
          onEvent?.(event);
        } catch {
          /* 半行或非 JSON，跳过 */
        }
      }
    });
    child.stderr?.on('data', (d) => (stderr += stderrDecoder.write(d)));

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err?.message || err), timedOut });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolve({ code, stdout, stderr: [stderr, reportedError].filter(Boolean).join('\n'), timedOut });
    });
  });
}
