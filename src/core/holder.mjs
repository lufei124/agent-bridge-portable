/**
 * 会话持有者：一个长驻的 Claude Code 进程。
 *
 * 这是"手机直接给你发消息"和"另起进程 resume"的根本区别：
 *   - 旧做法 runPrompt()：每次一条消息就 spawn 一次，跑完退出，上下文靠文件重建
 *   - 这里：进程一直活着，上下文在它内存里，手机发一条就写一行 JSON 进 stdin
 *
 * 参数与 VS Code 扩展自己拉起子进程时完全一致（已从扩展源码确认）：
 *   --resume <id> --input-format stream-json --output-format stream-json
 *
 * 已验证：新建会话 → 记住暗号 → 另起长驻进程 resume → 问暗号，能答对。
 *
 * 事件：
 *   'ready'     (sessionId)        进程起来了
 *   'message'   (holder, event)    新消息（assistant / tool）
 *   'turn:end'  (holder, event)    一轮跑完
 *   'error'     (Error)
 *   'exit'      (code)             进程没了（被 kill 或异常）
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolveClaudeBin, resolveResumeCwd } from './runner.mjs';

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;

export class SessionHolder extends EventEmitter {
  /**
   * @param {{sessionId:string, cwd?:string, projectDir?:string}} options
   */
  constructor(options = {}) {
    super();
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.projectDir = options.projectDir;

    this.child = null;
    this.buffer = '';
    this.startedAt = 0;
    this.lastActivityAt = 0;
    this.busy = false;
    this.stopped = false;

    /** 最近一次写进 stdin 的原文，用于在文件里认出"这条是我们发的" */
    this.sent = [];
  }

  get alive() {
    return Boolean(this.child && this.child.exitCode === null && !this.stopped);
  }

  start() {
    if (this.alive) return this;

    const target = resolveResumeCwd({
      sessionId: this.sessionId,
      cwd: this.cwd,
      projectDir: this.projectDir,
    });
    if (!target.sure) {
      throw new Error(`找不到 ${this.sessionId} 的会话文件，无法持有`);
    }
    this.cwd = target.cwd;

    const args = [
      '--resume',
      this.sessionId,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      // 让 CLI 把收到的用户消息回显出来，用来确认"这条真的进去了"
      '--replay-user-messages',
      '--permission-mode',
      'bypassPermissions',
      '--allow-dangerously-skip-permissions',
    ];

    this.child = spawn(resolveClaudeBin(), args, {
      cwd: this.cwd,
      windowsHide: true,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.startedAt = Date.now();
    this.lastActivityAt = this.startedAt;

    this.child.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      // CLI 的 debug 输出很多，只在真的报错时才往外冒
      if (/error|Error|failed/i.test(text)) this.emit('stderr', text);
    });

    this.child.on('error', (err) => this.emit('error', err));
    this.child.on('exit', (code) => {
      this.busy = false;
      this.emit('exit', code);
    });

    return this;
  }

  /**
   * 把一条用户消息写进这个进程的 stdin —— 等价于在窗口里按回车。
   * @returns {boolean} 进程不在就返回 false，调用方据此回滚
   */
  send(text) {
    if (!this.alive) return false;
    const message = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: String(text) }] } };
    this.child.stdin.write(JSON.stringify(message) + '\n');
    this.sent.push(String(text));
    if (this.sent.length > 20) this.sent.shift();
    this.busy = true;
    this.lastActivityAt = Date.now();
    return true;
  }

  /** 打断当前回合（发一条 interrupt 控制消息），进程继续活着 */
  interrupt() {
    if (!this.alive) return false;
    this.child.stdin.write(JSON.stringify({ type: 'control_request', request_id: `i${Date.now()}`, request: { subtype: 'interrupt' } }) + '\n');
    return true;
  }

  async stop({ graceMs = 1500 } = {}) {
    if (!this.child) return;
    this.stopped = true;
    this.busy = false;
    try {
      this.child.stdin.end();
    } catch {
      /* 已经关了 */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.child.kill();
        } catch {
          /* 已经没了 */
        }
        resolve();
      }, graceMs);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
  }

  _onStdout(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      this.lastActivityAt = Date.now();
      this._dispatch(event);
    }
  }

  _dispatch(event) {
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') this.emit('ready', this.sessionId);
        return;

      case 'user':
        // --replay-user-messages 的回显：确认这条真的被进程收下了
        this.emit('accepted', event);
        return;

      case 'assistant':
      case 'tool_use':
      case 'tool_result':
        this.emit('message', this, event);
        return;

      case 'result':
        this.busy = false;
        this.emit('turn:end', this, event);
        return;

      default:
        return;
    }
  }
}

/**
 * 有没有别的 Claude 进程正拿着这个会话。
 *
 * VS Code 扩展拉子进程时会把 `--resume=<sessionId>` 放进命令行，
 * 所以能在进程列表里直接看到（实测 PID 13656 就是这么暴露的）。
 * 新建的会话进程不带 --resume，这种情况只能靠"发出去有没有被接收"兜底。
 *
 * @returns {Promise<{pid:number}|null>}
 */
export async function findExternalOwner(sessionId) {
  if (process.platform !== 'win32') return null;
  const { execFile } = await import('node:child_process');
  const script =
    `Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | ` +
    `Where-Object { $_.CommandLine -like '*${sessionId}*' -and $_.ProcessId -ne ${process.pid} } | ` +
    `Select-Object -First 1 -ExpandProperty ProcessId`;
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', script], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null);
      const pid = parseInt(String(stdout).trim(), 10);
      resolve(Number.isFinite(pid) ? { pid } : null);
    });
  });
}

export { DEFAULT_TURN_TIMEOUT_MS };
