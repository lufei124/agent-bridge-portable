/**
 * 体检工具：一条命令告诉你「现在卡在哪」。
 *
 *   runtime\node.exe tools\doctor.mjs
 *
 * 普通体检只读。--deepseek 会启动一次本机 Harness 服务来检查历史会话。
 * 退出码：0 = 全部通过，1 = 有硬伤。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DshStore } from '../src/core/dsh.mjs';
import { dshStartupDiagnostic, openDshWeb } from '../src/core/dsh-web.mjs';
import { resolveDshLaunch } from '../src/core/runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');
const LOCK_FILE = path.join(ROOT, 'data', 'bridge.lock');
const LOG_FILE = path.join(ROOT, 'data', 'bridge.log');

if (process.argv.includes('--deepseek')) {
  let host;
  try {
    const store = new DshStore({ dir: process.env.DSH_SESSIONS_DIR });
    await store.scan();
    const session = store.list().find((entry) => entry.agentPreset && !entry.subagent && entry.cwd && fs.existsSync(entry.cwd));
    if (!session) throw new Error('DSH_WEB_START_NO_PRESET_SESSION');
    host = await openDshWeb(resolveDshLaunch(), { cwd: session.cwd });
    await host.call('state', { sessionId: session.id });
    console.log('DeepSeek 本机会话服务正常，已读取原有预设会话。');
  } catch (error) {
    console.error('DeepSeek 检查失败', error.code || dshStartupDiagnostic(error.message));
    process.exitCode = 1;
  } finally {
    await host?.close();
  }
  process.exit(process.exitCode || 0);
}

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m' };
const tty = process.stdout.isTTY;
const paint = (c, t) => (tty ? `${c}${t}${C.reset}` : t);

let hard = 0;
let soft = 0;

const pass = (label, detail = '') => {
  console.log(`${paint(C.green, '  ✓')} ${label}${detail ? paint(C.dim, `  ${detail}`) : ''}`);
};
const warn = (label, detail = '', fix = '') => {
  soft++;
  console.log(`${paint(C.yellow, '  !')} ${label}${detail ? paint(C.dim, `  ${detail}`) : ''}`);
  if (fix) console.log(`${paint(C.dim, '      → ' + fix)}`);
};
const fail = (label, detail = '', fix = '') => {
  hard++;
  console.log(`${paint(C.red, '  ×')} ${label}${detail ? paint(C.dim, `  ${detail}`) : ''}`);
  if (fix) console.log(`${paint(C.dim, '      → ' + fix)}`);
};
const head = (m) => console.log(`\n${m}`);

function readEnv() {
  const map = {};
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
      if (m) map[m[1]] = m[2].trim();
    }
  } catch {
    /* 没有 */
  }
  return map;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function claudePath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const candidates = [
    process.env.CLAUDE_BIN,
    path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    path.join(appData, 'npm', 'claude.cmd'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ].filter(Boolean);
  const hit = candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  if (hit) return hit;
  const probe = spawnSync('where', ['claude'], { encoding: 'utf8' });
  if (probe.status === 0) return probe.stdout.trim().split(/\r?\n/)[0];
  return '';
}

// ---------------------------------------------------------------- 检查

const env = readEnv();

head('运行时');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 20 || (major === 20 && minor >= 6)) pass(`Node ${process.versions.node}`);
else fail(`Node ${process.versions.node} 太旧`, '需要 ≥ 20.6', '装新版 Node，或恢复 runtime\\node.exe');

const bin = claudePath();
if (bin) pass('Claude Code CLI', bin);
else fail('找不到 claude 可执行文件', '', 'npm i -g @anthropic-ai/claude-code，或在 .env 里设 CLAUDE_BIN');

head('凭证');
if (/^cli_[A-Za-z0-9]+$/.test(env.FEISHU_APP_ID || '')) {
  pass('FEISHU_APP_ID', env.FEISHU_APP_ID.slice(0, 14) + '…');
} else {
  fail('FEISHU_APP_ID 缺失或格式不对', env.FEISHU_APP_ID || '(空)', '复制 .env.example 为 .env 并填写');
}
if ((env.FEISHU_APP_SECRET || '').length >= 16) pass('FEISHU_APP_SECRET', '已填写');
else fail('FEISHU_APP_SECRET 缺失或太短', '', '从开发者后台「凭证与基础信息」重新复制');

head('会话数据');
const projectsDir = env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
let count = 0;
try {
  for (const d of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    count += fs.readdirSync(path.join(projectsDir, d.name)).filter((f) => f.endsWith('.jsonl')).length;
  }
} catch {
  /* 不存在 */
}
if (count > 0) pass(`${count} 个 Claude 会话`, projectsDir);
else warn('没有可用的会话', projectsDir, '先在本机用 Claude Code 跑一个会话');

head('守护进程');
let pid = 0;
try {
  pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) || 0;
} catch {
  /* 没锁 */
}
if (pid && isAlive(pid)) pass(`运行中`, `PID ${pid}`);
else if (pid) fail(`锁文件写着 PID ${pid}，但进程已不在`, '', '跑 start.cmd 重启；若提示锁冲突就先删 data\\bridge.lock');
else warn('没在运行', '', '双击 install.cmd 或 start.cmd');

head('飞书长连接');
let log = '';
try {
  const stat = fs.statSync(LOG_FILE);
  const fh = fs.openSync(LOG_FILE, 'r');
  const len = Math.min(stat.size, 64 * 1024);
  const buf = Buffer.alloc(len);
  fs.readSync(fh, buf, 0, len, stat.size - len);
  fs.closeSync(fh);
  log = buf.toString('utf8');
} catch {
  /* 没日志 */
}

if (/ws client ready/.test(log)) pass('日志里有 ws client ready');
else if (log) fail('日志里没有 ws client ready', '', '看 data\\bridge.log 最后的报错；凭证错或应用没发布都会这样');
else warn('还没有日志', '', '守护进程至少启动过一次才会有');

if (/忽略非所有者消息/.test(log)) {
  warn('出现过「忽略非所有者消息」', '', '换了手机号/账号：删 data\\state.json 里的 ownerOpenId 后重启');
}
if (/99991672|99991663/.test(log)) {
  fail('飞书返回权限错误', '', '开发者后台补权限（im:message 相关）后重新发版');
}

head('开机自启');
const startup = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup',
  'ClaudeBridgeWatchdog.vbs'
);
if (fs.existsSync(startup)) pass('已安装', startup);
else warn('没装', '', '重跑 install.cmd，第三步选 y（重启电脑后需手动双击 start.cmd）');

// ---------------------------------------------------------------- 结论

console.log('');
if (hard === 0 && soft === 0) {
  console.log(paint(C.green, '全部通过。如果手机上还是没反应，去飞书后台确认事件与回调都选的是「长连接」。'));
} else if (hard === 0) {
  console.log(paint(C.yellow, `${soft} 项提醒，不影响主流程，有空再处理。`));
} else {
  console.log(paint(C.red, `${hard} 项硬伤，按上面 → 后面的提示逐个修。`));
  process.exitCode = 1;
}
console.log('');
