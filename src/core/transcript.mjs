/**
 * 监听 ~/.claude/projects 下的 JSONL 会话文件。
 *
 * Claude Code（包括 VS Code 插件）把每个会话追加写入
 *   <projects>/<项目路径编码>/<sessionId>.jsonl
 * 文件只追加、不重写，所以这里按字节偏移增量读取。
 *
 * 事件：
 *   'session:new'  (session)
 *   'message'      (session, event)  仅实时新消息
 *   'turn:end'     (session, event)  仅实时回合结束
 *   'error'        (Error)
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { normalize } from './normalize.mjs';

export const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

export class TranscriptStore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.dir = options.dir || DEFAULT_PROJECTS_DIR;
    this.pollMs = options.pollMs || 800;
    this.historyLimit = options.historyLimit || 60;
    this.sessions = new Map(); // file -> session
    this.timer = null;
    this.ticks = 0;
  }

  async start() {
    await this.scan();
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.emit('error', err));
    }, this.pollMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 会话列表，按最后活跃时间倒序 */
  list() {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async scan() {
    let projects;
    try {
      projects = await fsp.readdir(this.dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const dir = path.join(this.dir, project.name);

      let files;
      try {
        files = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const file of files) {
        // 只取项目根目录下的会话文件，忽略 <sessionId>/subagents/*.jsonl
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        const abs = path.join(dir, file.name);
        if (this.sessions.has(abs)) continue;
        await this.load(abs);
      }
    }
  }

  async load(file) {
    const id = path.basename(file, '.jsonl');
    const session = {
      id,
      file,
      projectDir: path.basename(path.dirname(file)),
      cwd: '',
      project: path.basename(path.dirname(file)),
      title: '',
      lastPrompt: '',
      model: '',
      status: 'idle',
      updatedAt: 0,
      messages: [],
      offset: 0,
      buffer: Buffer.alloc(0),
    };

    let size = 0;
    let buf = Buffer.alloc(0);
    try {
      const info = await fsp.stat(file);
      size = info.size;
      session.lastWriteAt = info.mtimeMs;
      if (size > 0) {
        const fh = await fsp.open(file, 'r');
        try {
          buf = Buffer.allocUnsafe(size);
          await fh.read(buf, 0, size, 0);
        } finally {
          await fh.close();
        }
      }
    } catch {
      return;
    }

    session.offset = size;
    // 历史只解析、不推送，避免重启后把旧的对话全部重发一遍
    for (const event of this._parse(buf)) this._apply(session, event, false);

    this.sessions.set(file, session);
    this.emit('session:new', session);
  }

  async tick() {
    for (const session of this.sessions.values()) {
      try {
        await this.poll(session);
      } catch {
        // 文件可能正在被替换，下一轮再试
      }
    }
    // 每 5 轮（约 4 秒）重新扫一次目录，发现新建的会话
    if (++this.ticks % 5 === 0) await this.scan();
  }

  async poll(session) {
    const stat = await fsp.stat(session.file);
    // 文件最后写入时间：判断"这个会话是不是正在被用"比解析出来的 status 更可靠，
    // 因为 status 要等下一轮解析才更新，存在最多 800ms 的空窗。
    session.lastWriteAt = stat.mtimeMs;

    if (stat.size < session.offset) {
      // 文件被截断或替换，从头再来
      session.offset = 0;
      session.buffer = Buffer.alloc(0);
    }
    if (stat.size <= session.offset) return;

    const length = stat.size - session.offset;
    const chunk = Buffer.allocUnsafe(length);
    const fh = await fsp.open(session.file, 'r');
    try {
      await fh.read(chunk, 0, length, session.offset);
    } finally {
      await fh.close();
    }
    session.offset = stat.size;

    for (const event of this._parse(chunk, session)) this._apply(session, event, true);
  }

  /** 把字节块切成完整行，返回规范化事件 */
  _parse(chunk, session) {
    let buffer = session ? session.buffer : Buffer.alloc(0);
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;

    const events = [];
    let index;
    while ((index = buffer.indexOf(0x0a)) !== -1) {
      const line = buffer.subarray(0, index).toString('utf8').trim();
      buffer = buffer.subarray(index + 1);
      if (!line) continue;

      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // 半行或坏行，跳过
      }
      events.push(...normalize(record));
    }

    if (session) session.buffer = buffer;
    return events;
  }

  _apply(session, event, live) {
    if (event.ts && event.ts > session.updatedAt) session.updatedAt = event.ts;

    // 只用会话开始时的 cwd。
    // 每条记录都带 cwd，但那是"当时 shell 的目录"——助手在会话里 cd 来 cd 去，
    // 用最新的会把会话 cwd 污染成子目录，导致 claude --resume 找不到会话。
    if (event.cwd && !session.cwd) {
      session.cwd = event.cwd;
      session.project = path.basename(event.cwd) || session.projectDir;
    }

    switch (event.kind) {
      case 'title':
        session.title = event.title;
        return;

      case 'prompt':
        session.lastPrompt = event.text;
        return;

      case 'turn_end':
        session.status = 'idle';
        if (live) this.emit('turn:end', session, event);
        return;

      case 'user':
      case 'assistant':
        session.status = 'running';
        break;

      case 'tool':
        session.status = 'running';
        break;

      default:
        return;
    }

    session.messages.push(event);
    if (session.messages.length > this.historyLimit) {
      session.messages.splice(0, session.messages.length - this.historyLimit);
    }

    if (live) this.emit('message', session, event);
  }
}
