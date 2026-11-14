/**
 * 会话持有者探测。
 *
 * Claude Code 每个活着的会话进程都会在 ~/.claude/sessions/ 下写一个
 *   <pid>.json
 * 里面有 sessionId、cwd、status（busy/idle）、messagingSocketPath 等。
 * 进程退出时文件会被清掉。
 *
 * 这比解析命令行可靠得多：
 *   - 新建的会话命令行里没有 --resume <id>（实测），但从这里能查到
 *   - 直接给出 status，不用猜是不是正在跑
 *
 * 所以"这个会话现在有没有别人在用"这个问题，有了确切答案。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

const CACHE_MS = 1000;
let cache = { at: 0, list: [] };

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程在，只是没权限
    return err.code === 'EPERM';
  }
}

/**
 * 当前所有活着的 Claude 会话进程。
 * @returns {Array<{pid:number, sessionId:string, cwd:string, status:string,
 *                  kind:string, entrypoint:string, name:string, updatedAt:number, socket:string}>}
 */
export function listLiveSessions(options = {}) {
  const now = Date.now();
  const cacheMs = options.cacheMs ?? CACHE_MS;
  if (now - cache.at < cacheMs) return cache.list;

  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return (cache = { at: now, list: [] }).list;
  }

  const list = [];
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
    } catch {
      continue;
    }
    if (!data?.sessionId || !Number.isInteger(data.pid)) continue;
    if (!isProcessAlive(data.pid)) continue;

    list.push({
      pid: data.pid,
      sessionId: data.sessionId,
      cwd: data.cwd || '',
      status: data.status || 'unknown',
      kind: data.kind || '',
      entrypoint: data.entrypoint || '',
      name: data.name || '',
      updatedAt: Number(data.updatedAt) || 0,
      socket: data.messagingSocketPath || '',
    });
  }

  cache = { at: now, list };
  return list;
}

/** 找到持有某个会话的活进程（可能不止一个，正常应该只有一个） */
export function findOwners(sessionId) {
  if (!sessionId) return [];
  return listLiveSessions().filter((s) => s.sessionId === sessionId);
}

/** 只要一个，用于卡片文案 */
export function findOwner(sessionId) {
  return findOwners(sessionId)[0] || null;
}

export function invalidateCache() {
  cache = { at: 0, list: [] };
}
