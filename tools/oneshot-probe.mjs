/**
 * E1 实测：一次性 `--resume -p` 能不能产生干净的一轮。
 *
 * 这决定架构：如果一次性进程能带着上下文回答、并在 JSONL 里留下正常的
 * user / assistant 记录，那么"每条消息一个进程、每次重读"就是成立的，
 * 也就天然不会分叉。
 *
 *   node tools/oneshot-probe.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BIN =
  process.env.CLAUDE_BIN ||
  path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oneshot-probe-'));
const common = ['--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions'];

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(BIN, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// ① 建会话
const first = await run(['-p', '记住暗号：蓝色海豚。只回复 OK', '--output-format', 'json', ...common]);
const firstJson = JSON.parse(first.stdout.trim().split('\n').filter(Boolean).pop());
const sessionId = firstJson.session_id;
console.log(`① 新会话 ${sessionId}`);
console.log(`   cwd = ${cwd}`);

// ② 一次性 resume：这就是手机发消息将要做的事
const started = Date.now();
const second = await run([
  '--resume',
  sessionId,
  '-p',
  '刚才的暗号是什么？只回答暗号本身。',
  '--output-format',
  'stream-json',
  '--verbose',
  ...common,
]);
const elapsed = Date.now() - started;

// ③ 看 stdout 里有没有回显用户消息、有没有 result
const lines = second.stdout.split('\n').filter((l) => l.trim()).map((l) => {
  try {
    return JSON.parse(l);
  } catch {
    return null;
  }
}).filter(Boolean);

const echoed = lines.filter((e) => e.type === 'user');
const results = lines.filter((e) => e.type === 'result');
const assistantText = lines
  .filter((e) => e.type === 'assistant')
  .flatMap((e) => e.message?.content || [])
  .filter((b) => b.type === 'text')
  .map((b) => b.text)
  .join('');

// ④ 直接看文件，确认写进去的是正常的两轮对话
const projectDir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[:\\/]/g, '-').replace(/^([a-zA-Z])/, (c) => c.toLowerCase()));
const jsonl = path.join(projectDir, `${sessionId}.jsonl`);
const records = fs.existsSync(jsonl)
  ? fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean)
  : [];

console.log(`\n② 一次性 resume 耗时 ${elapsed}ms，退出码 ${second.code}`);
if (second.stderr) console.log(`   stderr: ${second.stderr.replace(/\s+/g, ' ').slice(0, 600)}`);
console.log(`   stdout 前 300 字: ${second.stdout.replace(/\s+/g, ' ').slice(0, 300)}`);
console.log(`   stdout 里：用户消息回显 ${echoed.length} 条 · result ${results.length} 条`);
console.log(`   回答：${assistantText.trim().slice(0, 120)}`);
console.log(`\n③ 文件 ${path.basename(jsonl)}：${records.length} 条记录`);
for (const r of records) {
  const kind = r.type + (r.message?.role ? `(${r.message.role})` : '');
  const text =
    typeof r.message?.content === 'string'
      ? r.message.content
      : Array.isArray(r.message?.content)
        ? r.message.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ')
        : '';
  console.log(`   - ${kind}: ${String(text).replace(/\s+/g, ' ').slice(0, 90)}`);
}

const ok = assistantText.includes('蓝色海豚') && records.some((r) => r.type === 'user');
console.log(ok ? '\n✅ E1 通过：一次性进程带着上下文跑完，文件里是一轮正常对话' : '\n❌ E1 未通过');
