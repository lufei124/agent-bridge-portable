/**
 * 只读 Codex 的 rollout 记录。
 *
 * 会话在 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl。
 * 文件只用来发现和展示，不写回去。手机发消息续跑还没接。
 *
 * 大文件只读开头（会话 id、目录、第一句当标题）和末尾（最近对话）。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { conversationBrief } from './brief.mjs';

const MAX_TEXT = 4000;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 512 * 1024;

export const DEFAULT_CODEX_DIR = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');

export function parseCodexLog(text, options = {}) {
  const historyLimit = options.historyLimit || 60;
  const lines = String(text || '').split(/\n/);
  if (options.dropPartialStart) lines.shift();
  if (options.dropPartialEnd) lines.pop();

  const parsed = {
    id: '',
    cwd: '',
    title: '',
    messages: [],
    running: false,
    updatedAt: 0,
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    applyRecord(parsed, record);
  }

  if (parsed.messages.length > historyLimit) {
    parsed.messages = parsed.messages.slice(-historyLimit);
  }
  return parsed;
}

export function mergeCodexParts(head, tail) {
  return {
    id: head.id || tail.id || '',
    cwd: head.cwd || tail.cwd || '',
    title: head.title || tail.title || '',
    messages: tail.messages || [],
    running: Boolean(tail.running),
    updatedAt: Math.max(head.updatedAt || 0, tail.updatedAt || 0),
  };
}

function applyRecord(parsed, record) {
  const ts = record.timestamp ? Date.parse(record.timestamp) : 0;
  if (ts && ts > parsed.updatedAt) parsed.updatedAt = ts;

  const payload = record.payload || {};
  if (record.type === 'session_meta') {
    if (!parsed.id && payload.session_id) parsed.id = String(payload.session_id);
    if (!parsed.cwd && payload.cwd) parsed.cwd = String(payload.cwd);
    return;
  }

  if (record.type === 'event_msg') {
    if (payload.type === 'task_started') parsed.running = true;
    else if (payload.type === 'task_complete') parsed.running = false;
    return;
  }

  if (record.type !== 'response_item' || payload.type !== 'message') return;
  if (payload.role !== 'user' && payload.role !== 'assistant') return;

  const text = messageText(payload.content);
  if (!text) return;

  if (payload.role === 'user' && !parsed.title) {
    parsed.title = conversationBrief(text);
  }

  parsed.messages.push({
    kind: payload.role,
    text: clip(text),
    ts,
    sessionId: parsed.id,
    cwd: parsed.cwd,
  });
}

function messageText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if ((block.type === 'input_text' || block.type === 'output_text') && block.text && String(block.text).trim()) {
      parts.push(String(block.text).trim());
    }
  }
  return parts.join('\n\n').trim();
}

function clip(text, max = MAX_TEXT) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export class CodexStore {
  constructor(options = {}) {
    this.dir = options.dir || DEFAULT_CODEX_DIR;
    this.pollMs = options.pollMs || 2000;
    this.historyLimit = options.historyLimit || 60;
    this.sessions = new Map(); // id -> session
    this.timer = null;
    this.titleFile = options.titleFile || path.join(path.dirname(this.dir), 'session_index.jsonl');
    this.titles = new Map();
    this.titleFileVersion = '';
  }

  async start() {
    await this.scan();
    this.timer = setInterval(() => {
      this.scan().catch(() => {});
    }, this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  list() {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((session) => this.titles.has(session.id) ? { ...session, title: this.titles.get(session.id) } : session);
  }

  async scan() {
    const [files] = await Promise.all([rolloutFiles(this.dir), this.refreshTitles()]);
    const seen = new Set();

    for (const file of files) {
      let stat;
      try {
        stat = await fsp.stat(file);
      } catch {
        continue;
      }

      const existing = [...this.sessions.values()].find((session) => session.file === file);
      if (existing && existing.lastWriteAt === stat.mtimeMs && existing.size === stat.size) {
        seen.add(existing.id);
        continue;
      }

      const session = await loadRollout(file, stat, this.historyLimit);
      if (!session) continue;
      const previous = this.sessions.get(session.id);
      const previousStillThere = previous && files.includes(previous.file);
      if (previousStillThere && previous.file !== file && previous.updatedAt > session.updatedAt) {
        seen.add(previous.id);
        continue;
      }
      this.sessions.set(session.id, session);
      seen.add(session.id);
    }

    for (const id of [...this.sessions.keys()]) {
      if (!seen.has(id)) this.sessions.delete(id);
    }
  }

  async refreshTitles() {
    try {
      const stat = await fsp.stat(this.titleFile);
      const version = `${stat.mtimeMs}:${stat.size}`;
      if (version === this.titleFileVersion) return;
      const titles = new Map();
      for (const row of (await fsp.readFile(this.titleFile, 'utf8')).split('\n')) {
        if (!row.trim()) continue;
        try {
          const { id, thread_name: name } = JSON.parse(row);
          const title = conversationBrief(name);
          if (id && title) titles.set(id, title);
        } catch {
          // 索引追加写入时，末行可能还没写完。
        }
      }
      this.titles = titles;
      this.titleFileVersion = version;
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.titles.clear();
        this.titleFileVersion = '';
      }
    }
  }
}

async function rolloutFiles(dir) {
  const out = [];
  async function walk(current, depth) {
    if (depth > 6) return;
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(abs, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) out.push(abs);
    }
  }
  await walk(dir, 0);
  return out;
}

async function loadRollout(file, stat, historyLimit) {
  const headLength = Math.min(HEAD_BYTES, stat.size);
  const headText = await readSlice(file, 0, headLength);
  const tailStart = Math.max(0, stat.size - TAIL_BYTES);
  const sameSlice = stat.size <= HEAD_BYTES;
  const tailText = sameSlice ? headText : await readSlice(file, tailStart, stat.size - tailStart);

  const head = parseCodexLog(headText, { historyLimit, dropPartialEnd: headLength < stat.size });
  const tail = sameSlice
    ? head
    : parseCodexLog(tailText, { dropPartialStart: tailStart > 0, historyLimit });
  const merged = mergeCodexParts(head, tail);
  if (!merged.id) return null;

  const project = merged.cwd ? path.basename(merged.cwd) : '';
  return {
    id: merged.id,
    file,
    platform: 'codex',
    projectDir: project,
    cwd: merged.cwd,
    project: project || 'Codex',
    title: merged.title,
    lastPrompt: '',
    model: '',
    status: merged.running ? 'running' : 'idle',
    updatedAt: Math.max(merged.updatedAt, stat.mtimeMs),
    messages: merged.messages.map((message) => ({ ...message, sessionId: merged.id, cwd: merged.cwd })),
    lastWriteAt: stat.mtimeMs,
    size: stat.size,
  };
}

async function readSlice(file, start, length) {
  if (length <= 0) return '';
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}
