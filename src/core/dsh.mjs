/**
 * 只读 DeepSeek Harness 的会话。
 *
 * 会话在 ~/.dsh/sessions/<工作区>/session-<id>/session.v4.jsonl.zstd。
 * 文件是多段 zstd，每段一条 JSON。只用来发现和展示，不写回去。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { conversationBrief } from './brief.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export const DEFAULT_DSH_DIR = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions');

export function dshTurnReason(text, requestId) {
  let sawPrompt = false;
  for (const line of text.split('\n')) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record) continue;
    if (record.type === 'user/message' && record.data?.source?.rpcId === requestId) sawPrompt = true;
    if (sawPrompt && record.type === 'turn/end') return record.data?.reason;
  }
  return undefined;
}

export async function waitForDshTurn(file, requestId) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const reason = dshTurnReason(decodeDshBuffer(await fsp.readFile(file)), requestId);
    if (reason) return reason;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

export function parseDshLog(text, options = {}) {
  const historyLimit = options.historyLimit || 60;
  const parsed = {
    id: '',
    cwd: '',
    title: '',
    agentPreset: '',
    subagent: false,
    messages: [],
    running: false,
    updatedAt: 0,
  };

  for (const line of String(text || '').split(/\n/)) {
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

  if (!parsed.title) {
    for (const message of parsed.messages) {
      if (message.kind === 'user') parsed.title = conversationBrief(message.text);
      if (parsed.title) break;
    }
  }
  if (parsed.messages.length > historyLimit) {
    parsed.messages = parsed.messages.slice(-historyLimit);
  }
  return parsed;
}

export function decodeDshBuffer(buffer) {
  const chunks = [];
  let offset = 0;
  while (offset < buffer.length) {
    const end = zstdFrameEnd(buffer, offset);
    if (end <= offset || end > buffer.length) break;
    try {
      chunks.push(zlib.zstdDecompressSync(buffer.subarray(offset, end)));
    } catch {
      break;
    }
    offset = end;
  }
  return Buffer.concat(chunks).toString('utf8');
}

function applyRecord(parsed, record) {
  const ts = Number(record.time || record.createdAt) || 0;
  if (ts > parsed.updatedAt) parsed.updatedAt = ts;

  if (record.type === 'session') {
    if (!parsed.id && record.id) parsed.id = String(record.id);
    if (!parsed.cwd && record.cwd) parsed.cwd = String(record.cwd);
    if (typeof record.agentPreset === 'string') parsed.agentPreset = record.agentPreset;
    parsed.subagent = record.origin === 'subagent';
    return;
  }

  if (record.type === 'turn/start') {
    parsed.running = true;
    return;
  }
  if (record.type === 'turn/end') {
    parsed.running = false;
    return;
  }

  const data = record.data || {};
  if (record.type === 'agent-preset/selected') {
    if (typeof data.agentPreset === 'string' && data.agentPreset) parsed.agentPreset = data.agentPreset;
    return;
  }

  if (record.type === 'session/title' && data.title) {
    parsed.title = conversationBrief(data.title);
    return;
  }

  if (record.type === 'user/message') {
    const text = blockText(data.content, 'text');
    if (!text) return;
    parsed.messages.push({ kind: 'user', text, ts, sessionId: parsed.id, cwd: parsed.cwd });
    return;
  }

  if (record.type === 'assistant/message') {
    const text = blockText(data.message?.content, 'text');
    if (!text) return;
    parsed.messages.push({ kind: 'assistant', text, ts, sessionId: parsed.id, cwd: parsed.cwd });
  }
}

function blockText(content, type) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || block.type !== type || !block.text || !String(block.text).trim()) continue;
    parts.push(String(block.text).trim());
  }
  return parts.join('\n\n').trim();
}

function zstdFrameEnd(buffer, start) {
  if (start + 4 > buffer.length || buffer.subarray(start, start + 4).compare(MAGIC) !== 0) return -1;
  let cursor = start + 4;
  const descriptor = buffer[cursor++];
  const sizeFlag = descriptor >> 6;
  const single = (descriptor >> 5) & 1;
  const checksum = (descriptor >> 2) & 1;
  const dictFlag = descriptor & 3;
  if (!single) cursor += 1;
  cursor += [0, 1, 2, 4][dictFlag] || 0;
  cursor += sizeFlag === 0 ? (single ? 1 : 0) : sizeFlag === 1 ? 2 : sizeFlag === 2 ? 4 : 8;

  while (cursor + 3 <= buffer.length) {
    const header = buffer[cursor] | (buffer[cursor + 1] << 8) | (buffer[cursor + 2] << 16);
    const last = header & 1;
    const type = (header >> 1) & 3;
    const size = header >> 3;
    cursor += 3;
    if (type === 1) cursor += 1;
    else cursor += size;
    if (last) break;
  }
  if (checksum) cursor += 4;
  return cursor;
}

export class DshStore {
  constructor(options = {}) {
    this.dir = options.dir || DEFAULT_DSH_DIR;
    this.pollMs = options.pollMs || 2000;
    this.historyLimit = options.historyLimit || 60;
    this.sessions = new Map();
    this.timer = null;
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
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async scan() {
    const files = await sessionFiles(this.dir);
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

      const session = await loadSession(file, stat, this.historyLimit);
      if (!session) continue;
      this.sessions.set(session.id, session);
      seen.add(session.id);
    }

    for (const id of [...this.sessions.keys()]) {
      if (!seen.has(id)) this.sessions.delete(id);
    }
  }
}

async function sessionFiles(dir) {
  const out = [];
  async function walk(current, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(abs, depth + 1);
      else if (entry.isFile() && entry.name === 'session.v4.jsonl.zstd') out.push(abs);
    }
  }
  await walk(dir, 0);
  return out;
}

async function loadSession(file, stat, historyLimit) {
  let parsed;
  try {
    const buffer = await fsp.readFile(file);
    parsed = parseDshLog(decodeDshBuffer(buffer), { historyLimit });
  } catch {
    return null;
  }
  if (!parsed.id) parsed.id = path.basename(path.dirname(file));
  const project = parsed.cwd ? path.basename(parsed.cwd) : '';
  return {
    id: parsed.id,
    file,
    platform: 'deepseek',
    projectDir: project,
    cwd: parsed.cwd,
    project: project || 'DeepSeek',
    title: parsed.title,
    agentPreset: parsed.agentPreset,
    subagent: parsed.subagent,
    lastPrompt: '',
    model: '',
    status: parsed.running ? 'running' : 'idle',
    updatedAt: Math.max(parsed.updatedAt, stat.mtimeMs),
    messages: parsed.messages.map((message) => ({ ...message, sessionId: parsed.id, cwd: parsed.cwd })),
    lastWriteAt: stat.mtimeMs,
    size: stat.size,
  };
}
