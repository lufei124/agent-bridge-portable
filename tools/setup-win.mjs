/**
 * 一键安装（Windows）。
 *
 * 做四件事：
 *   1. 体检：Node、Claude Code CLI、~/.claude/projects
 *   2. 写 .env（交互输入飞书 App ID / Secret）
 *   3. 装开机自启（往「启动」文件夹写一个静默 VBS）
 *   4. 拉起守护进程
 *
 * 用法：
 *   install.cmd              正常安装
 *   install.cmd remove       卸载开机自启并停止守护进程
 *
 * 设计原则：只做加法，不删用户已有的东西；每一步失败都给出可执行的下一步。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');
const LOCK_FILE = path.join(ROOT, 'data', 'bridge.lock');
const LOG_FILE = path.join(ROOT, 'data', 'bridge.log');

const NODE_BIN = fs.existsSync(path.join(ROOT, 'runtime', 'node.exe'))
  ? path.join(ROOT, 'runtime', 'node.exe')
  : process.execPath;

const STARTUP_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup'
);
const VBS_FILE = path.join(STARTUP_DIR, 'ClaudeBridgeWatchdog.vbs');

const mode = process.argv.slice(2).find((a) => !a.startsWith('-')) || 'install';
const UNINSTALL = mode === 'remove' || mode === 'uninstall';

// ---------------------------------------------------------------- 输出

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};
const tty = process.stdout.isTTY;
const paint = (color, text) => (tty ? `${color}${text}${C.reset}` : text);

const ok = (m) => console.log(`${paint(C.green, '  ✓')} ${m}`);
const warn = (m) => console.log(`${paint(C.yellow, '  !')} ${m}`);
const bad = (m) => console.log(`${paint(C.red, '  ×')} ${m}`);
const info = (m) => console.log(`${paint(C.dim, '  ·')} ${m}`);
const head = (m) => console.log(`\n${paint(C.bold + C.cyan, m)}`);
const gap = () => console.log('');

// ---------------------------------------------------------------- 交互

/** 复用同一个 readline 实例，避免多次创建抢 stdin */
let rlInstance = null;
function reader() {
  if (!rlInstance) {
    rlInstance = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return rlInstance;
}

/** 普通提问 */
function ask(question, fallback = '') {
  const suffix = fallback ? paint(C.dim, `（直接回车 = ${fallback}）`) : '';
  return new Promise((resolve) => {
    const r = reader();
    r.resume(); // 掩码输入后会 pause，这里恢复
    r.question(`${question}${suffix} `, (answer) => {
      resolve(String(answer || '').trim() || fallback);
    });
  });
}

/** 是/否，回车取默认值 */
async function confirm(question, defaultYes = true) {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = (await ask(`${question} ${paint(C.dim, `[${hint}]`)}`)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes' || answer === '是';
}

/** 隐藏输入（用于 App Secret），有回显星号 */
function askSecret(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      // 管道输入时退回普通读取，不做掩码
      resolve('');
      return;
    }
    rlInstance?.pause();
    process.stdout.write(question);
    const chars = [];
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(chars.join(''));
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n已取消。\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (chars.length) {
            chars.pop();
            process.stdout.write('\b \b');
          }
          continue;
        }
        chars.push(ch);
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

function closeInput() {
  try {
    rlInstance?.close();
  } catch {
    /* 已经关了 */
  }
  rlInstance = null;
}

// ---------------------------------------------------------------- 体检

function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const okVersion = major > 20 || (major === 20 && minor >= 6);
  if (okVersion) ok(`Node ${process.versions.node}（${NODE_BIN}）`);
  else bad(`Node ${process.versions.node} 太旧，需要 ≥ 20.6`);
  return okVersion;
}

function claudeCandidates() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return [
    process.env.CLAUDE_BIN,
    path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    path.join(appData, 'npm', 'claude.cmd'),
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ].filter(Boolean);
}

function checkClaude() {
  const found = claudeCandidates().find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  if (found) {
    ok(`Claude Code CLI：${found}`);
  } else {
    const probe = spawnSync('where', ['claude'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim()) {
      ok(`Claude Code CLI：${probe.stdout.trim().split(/\r?\n/)[0]}`);
      return true;
    }
    bad('没找到 Claude Code CLI');
    info('装一个再回来：npm i -g @anthropic-ai/claude-code');
    info('装完在终端敲 claude --version 能出版本号就算好');
    info('如果 CLI 装在别处，可以在 .env 里加一行 CLAUDE_BIN=完整路径');
    return false;
  }
  return true;
}

function checkProjects() {
  const dir = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
  let count = 0;
  try {
    for (const project of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const inner = path.join(dir, project.name);
      count += fs.readdirSync(inner).filter((f) => f.endsWith('.jsonl')).length;
    }
  } catch {
    /* 目录不存在 */
  }

  if (count > 0) {
    ok(`Claude Code 会话目录：${dir}（${count} 个会话）`);
    return true;
  }
  warn(`会话目录是空的：${dir}`);
  info('这通常是「本机还没用 Claude Code 跑过任何项目」。');
  info('先去 VS Code 插件或终端里随便跑一个会话，再回来装——否则手机上列表是空的。');
  return false;
}

// ---------------------------------------------------------------- .env

function readEnv() {
  const map = {};
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
      if (m) map[m[1]] = m[2].trim();
    }
  } catch {
    /* 没有就算了 */
  }
  return map;
}

function writeEnv(values) {
  const lines = [
    '# 飞书自建应用凭证 —— 开发者后台「基础信息 > 凭证与基础信息」',
    '# 不要加引号、不要留空格',
    `FEISHU_APP_ID=${values.FEISHU_APP_ID}`,
    `FEISHU_APP_SECRET=${values.FEISHU_APP_SECRET}`,
    '',
    '# 下面都是可选项，需要时取消注释',
    '# Claude Code 的 claude.exe 不在默认位置时，在这里写死完整路径',
    '# CLAUDE_BIN=',
    '# Claude Code 会话目录，默认 %USERPROFILE%\\.claude\\projects',
    '# CLAUDE_PROJECTS_DIR=',
    '# 轮询间隔（毫秒），越小越实时、越费 CPU',
    '# POLL_MS=800',
    '# 每个会话在内存里保留多少条消息',
    '# HISTORY_LIMIT=60',
    '# 会话卡片上的快捷短语，用 | 分隔，最多 4 个',
    '# QUICK_REPLIES=继续|跑一下测试|看下状态',
    '',
  ];
  fs.writeFileSync(ENV_FILE, lines.join('\r\n'), 'utf8');
}

async function setupEnv() {
  const current = readEnv();
  const hasReal =
    /^cli_/.test(current.FEISHU_APP_ID || '') && (current.FEISHU_APP_SECRET || '').length > 10;

  if (hasReal) {
    ok(`.env 已存在，App ID 是 ${current.FEISHU_APP_ID.slice(0, 12)}…`);
    if (!(await confirm('  要重新填写凭证吗？', false))) return true;
  }

  // 没有终端就没法交互输入，别死循环
  if (!process.stdin.isTTY) {
    bad('当前不是交互终端，没法输入凭证');
    info('解决办法二选一：');
    info('  A. 双击 install.cmd（会有窗口）');
    info(`  B. 手动复制 .env.example 为 .env，填好 FEISHU_APP_ID / FEISHU_APP_SECRET`);
    return false;
  }

  head('填写飞书应用凭证');
  info('去 https://open.feishu.cn/app → 你的应用 →「基础信息」→「凭证与基础信息」');
  info('必须是「企业自建应用」，商店应用不支持长连接。');
  gap();

  let appId = '';
  while (!/^cli_[A-Za-z0-9]+$/.test(appId)) {
    appId = await ask('App ID（cli_ 开头）：');
    if (!/^cli_[A-Za-z0-9]+$/.test(appId)) bad('格式不对，应该形如 cli_a1b2c3d4e5f6g7h8');
  }

  let appSecret = '';
  while (appSecret.length < 16) {
    appSecret = await askSecret('App Secret（输入时不显示字符，回车确认）：');
    if (appSecret.length < 16) bad('太短了，App Secret 一般 32 位');
  }

  writeEnv({ FEISHU_APP_ID: appId, FEISHU_APP_SECRET: appSecret });
  ok(`已写入 ${ENV_FILE}`);
  return true;
}

// ---------------------------------------------------------------- 开机自启

/** VBS 用 UTF-16LE + BOM 写，中文路径也不会乱码 */
function writeAutostart() {
  try {
    fs.mkdirSync(STARTUP_DIR, { recursive: true });
    const body = [
      "' 登录时静默启动 Claude 桥的看门狗（无窗口）",
      'Set shell = CreateObject("WScript.Shell")',
      `shell.CurrentDirectory = "${ROOT}"`,
      `shell.Run """${NODE_BIN}"" tools\\watchdog.mjs", 0, False`,
      '',
    ].join('\r\n');
    fs.writeFileSync(VBS_FILE, '\ufeff' + body, 'utf16le');
    ok(`开机自启已装：${VBS_FILE}`);
    return true;
  } catch (err) {
    bad(`写开机自启失败：${err.message}`);
    info('不影响使用，只是重启电脑后要手动双击 start.cmd');
    return false;
  }
}

function removeAutostart() {
  try {
    fs.unlinkSync(VBS_FILE);
    ok('开机自启已移除');
  } catch (err) {
    if (err.code === 'ENOENT') info('本来就没装开机自启');
    else bad(`删除失败：${err.message}`);
  }
}

// ---------------------------------------------------------------- 进程

function readLock() {
  try {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return 0;
    process.kill(pid, 0);
    return pid;
  } catch {
    return 0;
  }
}

function stopDaemon() {
  const pid = readLock();
  if (!pid) {
    info('守护进程没在跑');
    return;
  }
  try {
    process.kill(pid);
    ok(`已停止守护进程 PID ${pid}`);
  } catch (err) {
    warn(`停止失败（${err.code}），尝试强制结束`);
    try {
      spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
      ok('已强制结束');
    } catch {
      bad('还是没能停掉，手动去任务管理器结束那个 node.exe');
    }
  }
}

function startWatchdog() {
  const pid = readLock();
  if (pid) {
    ok(`守护进程已经在跑（PID ${pid}）`);
    return;
  }
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(NODE_BIN, ['tools/watchdog.mjs'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(out);
  ok(`看门狗已启动（PID ${child.pid}）`);
  info('它每 30 秒检查一次守护进程，挂了会自动拉起');
}

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log(paint(C.bold, '\n╭──────────────────────────────────────────────╮'));
  console.log(paint(C.bold, '│   飞书远程会话桥 · 一键安装（Windows）        │'));
  console.log(paint(C.bold, '╰──────────────────────────────────────────────╯'));
  info(`安装目录：${ROOT}`);

  if (UNINSTALL) {
    head('卸载开机自启');
    removeAutostart();
    stopDaemon();
    gap();
    info('程序文件还在，删掉整个文件夹即可彻底清除。');
    closeInput();
    return;
  }

  // 路径检查：空格和中文会让某些老工具抽风，提前提醒
  if (/[^\x00-\x7F]/.test(ROOT)) {
    warn('安装路径里有中文，一般没事，但个别环境会出问题');
    info('稳妥做法是挪到 D:\\agent-bridge 这种纯英文路径再装');
  }

  head('一、环境体检');
  const nodeOk = checkNode();
  const claudeOk = checkClaude();
  const projectsOk = checkProjects();

  if (!nodeOk || !claudeOk) {
    gap();
    bad('必要条件没满足，先把上面标 × 的解决掉，再重新运行 install.cmd');
    closeInput();
    process.exitCode = 1;
    return;
  }
  if (!projectsOk) {
    gap();
    warn('继续装也可以，只是飞书列表里会是空的。');
    if (!(await confirm('  仍然继续？', true))) {
      closeInput();
      return;
    }
  }

  head('二、飞书凭证');
  const envOk = await setupEnv();
  if (!envOk) {
    closeInput();
    process.exitCode = 1;
    return;
  }

  head('三、开机自启');
  if (await confirm('  装到「启动」文件夹，开机自动在后台跑？', true)) writeAutostart();
  else info('跳过。以后重启电脑需要手动双击 start.cmd');

  head('四、启动');
  if (await confirm('  现在就把守护进程拉起来？', true)) {
    startWatchdog();
    await new Promise((r) => setTimeout(r, 2500));
    const pid = readLock();
    gap();
    if (pid) ok(`守护进程活着（PID ${pid}），日志在 data\\bridge.log`);
    else {
      bad('没起来，看 data\\bridge.log 最后几十行找原因');
      info('最常见：App Secret 填错、应用没发布、或者飞书后台没开长连接');
    }
  }

  closeInput();

  head('接下来（顺序不能反）');
  console.log(`
  1. 打开飞书开发者后台 → 你的应用 →「事件与回调」
  2. 订阅方式选「使用长连接接收事件」→ 保存
     ${paint(C.yellow, '（必须是在守护进程已经跑起来的时候保存，否则存不住）')}
  3. 添加事件：接收消息 im.message.receive_v1
  4. 添加回调：卡片回传交互 card.action.trigger（同样选长连接）
  5. 「应用发布 → 版本管理与发布」创建版本并发布
  6. 飞书里搜到你的应用，私聊发一句 hi
`);

  head('验收清单');
  console.log(`
  ${paint(C.dim, '□')} 发 hi          → 回一张会话列表卡片
  ${paint(C.dim, '□')} 发 列表        → 能看到本机所有 Claude 会话
  ${paint(C.dim, '□')} 点开一个会话   → 看到最近对话和输入框
  ${paint(C.dim, '□')} 发一句普通文字 → 电脑上那个会话开始执行，结果推回飞书
  ${paint(C.dim, '□')} 发 /status     → 能看到 PID、运行时长、会话数
`);

  info('详细说明见同目录的 AGENT-INSTALL.md');
  gap();
}

main().catch((err) => {
  console.error('\n安装脚本出错：', err?.stack || err);
  closeInput();
  process.exitCode = 1;
});
