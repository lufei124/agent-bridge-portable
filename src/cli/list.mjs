/**
 * 列出本机所有 Claude Code 会话（含 VS Code 插件里的）。
 * 用法：node src/cli/list.mjs
 */

import { TranscriptStore } from '../core/transcript.mjs';

const store = new TranscriptStore({
  dir: process.env.CLAUDE_PROJECTS_DIR || undefined,
});

await store.start();

const sessions = store.list();
store.stop();

if (sessions.length === 0) {
  console.log('没有找到会话。检查目录：' + (process.env.CLAUDE_PROJECTS_DIR || '~/.claude/projects'));
  process.exit(0);
}

const now = Date.now();
console.log(`共 ${sessions.length} 个会话\n`);

for (const s of sessions.slice(0, 30)) {
  // 超过 5 分钟没有新记录的会话不算是“正在跑”
  const running = s.status === 'running' && now - s.updatedAt < 5 * 60 * 1000;
  const dot = running ? '🟢' : '⚪';
  const title = s.title || `(未命名 ${s.id.slice(0, 8)})`;
  console.log(
    `${dot} ${pad(s.project, 18)} ${pad(ago(now - s.updatedAt), 8)} ${title}\n` +
      `   ${' '.repeat(18)} ${s.messages.length} 条 · ${s.cwd || s.projectDir}`
  );
}

function ago(ms) {
  if (!ms || ms < 0) return '—';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

function pad(text, width) {
  const value = String(text);
  const len = [...value].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return value + ' '.repeat(Math.max(0, width - len));
}
