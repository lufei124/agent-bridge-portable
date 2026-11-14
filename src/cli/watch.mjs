/**
 * 实时打印本机所有 Claude Code 会话的流水，用来验证数据层。
 * 用法：node src/cli/watch.mjs
 */

import { TranscriptStore } from '../core/transcript.mjs';

const store = new TranscriptStore({
  dir: process.env.CLAUDE_PROJECTS_DIR || undefined,
});

store.on('session:new', (s) => {
  console.log(`\n📁 发现会话 ${s.id.slice(0, 8)} · ${s.project} · ${s.title || '未命名'}`);
});

store.on('message', (s, event) => {
  const who = { user: '你', assistant: 'Claude', tool: '工具' }[event.kind] || event.kind;
  const body =
    event.kind === 'tool'
      ? `[${event.name}] ${event.summary}`
      : String(event.text || '').replace(/\s+/g, ' ').slice(0, 140);

  console.log(`${clock(event.ts)} ${s.project} › ${s.title || s.id.slice(0, 8)} | ${who}: ${body}`);
});

store.on('turn:end', (s) => {
  console.log(`✅ ${clock(Date.now())} ${s.project} › ${s.title || s.id.slice(0, 8)} 回合结束`);
});

store.on('error', (err) => console.error('监听出错:', err.message));

await store.start();
console.log(`监听中：${process.env.CLAUDE_PROJECTS_DIR || '~/.claude/projects'}（Ctrl+C 退出）`);

process.on('SIGINT', () => {
  store.stop();
  process.exit(0);
});

function clock(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
}
