/**
 * Agent 平台登记表。
 *
 * 「平台」指的是电脑上和 Claude Code 并行跑的其他 agent 工具
 * （Codex、Cursor、MarsCode…），手机端最外层列表就是这张表。
 *
 * 新增一个平台接入分两步：
 *   1. 在这里登记，probe 指到它存放会话数据的目录；
 *   2. 在 index.mjs 的 sessionsOf() 里给出该平台会话的读取方式。
 *   没有第 2 步的平台会显示成「未接入」，但会照实告诉用户本机检测到没有。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

export const PLATFORMS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    icon: '✴️',
    subtitle: 'VS Code 插件 · 命令行',
    probe: path.join(HOME, '.claude', 'projects'),
    ready: true,
  },
  {
    id: 'codex',
    name: 'Codex',
    icon: '🤖',
    subtitle: 'OpenAI · 命令行 / IDE',
    probe: path.join(HOME, '.codex', 'sessions'),
    ready: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: '🐋',
    subtitle: 'DeepSeek Harness',
    probe: path.join(HOME, '.dsh', 'sessions'),
    ready: true,
  },
  {
    id: 'marscode',
    name: 'MarsCode',
    subtitle: '豆包 · VS Code 插件',
    probe: path.join(HOME, '.marscode'),
    ready: false,
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    subtitle: 'Google · 命令行',
    probe: path.join(HOME, '.gemini'),
    ready: false,
  },
];

/** 本机是否装了某个平台 */
export function installed(platform) {
  try {
    return fs.existsSync(platform.probe);
  } catch {
    return false;
  }
}

/**
 * 手机端要展示的平台列表：
 * - 已接入的平台永远展示；
 * - 未接入的平台只在真的检测到时才展示，避免一堆噪音。
 */
export function visiblePlatforms() {
  return PLATFORMS.filter((p) => p.ready || installed(p));
}

export function findPlatform(id) {
  return PLATFORMS.find((p) => p.id === id) || null;
}

const LIST_FILTERS = new Set(['claude-code', 'codex', 'deepseek']);

export function normalizeListFilter(value) {
  return LIST_FILTERS.has(value) ? value : 'all';
}

export function sessionFilterName(id) {
  return (
    {
      'claude-code': 'Claude Code',
      codex: 'Codex',
      deepseek: 'DeepSeek',
    }[id] || '全部会话'
  );
}

/** 飞书底部菜单「发送文字消息」的整句，对应一张会话列表。普通聊天内容返回空。 */
export function filterFromMenuText(input) {
  const text = String(input || '').trim().toLowerCase();
  return (
    {
      claude: 'claude-code',
      'claude code': 'claude-code',
      codex: 'codex',
      deepseek: 'deepseek',
    }[text] || ''
  );
}
