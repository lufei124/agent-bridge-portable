/**
 * 可行性探针：验证"桥自己持有一个会话，靠 stdin 收消息"这条路。
 *
 * 步骤：
 *   1. 在一个临时目录里建一个新会话，记住一个暗号
 *   2. 用扩展同样的参数（--resume + stream-json 双向）拉起长驻进程
 *   3. 往 stdin 写一条用户消息，看它是否带着上下文回答
 *
 *   node tools/holder-probe.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BIN =
  process.env.CLAUDE_BIN ||
  path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'holder-probe-'));
const common = ['--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions'];

function step1() {
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, ['-p', '记住暗号：蓝色海豚。只回复 OK', '--output-format', 'json', ...common], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`建会话失败 code=${code} ${err.slice(0, 400)}`));
      try {
        const json = JSON.parse(out.trim().split('\n').filter(Boolean).pop());
        resolve(json.session_id);
      } catch (e) {
        reject(new Error(`解析失败：${out.slice(0, 400)}`));
      }
    });
  });
}

function step2(sessionId) {
  return new Promise((resolve, reject) => {
    const args = [
      '--resume',
      sessionId,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--replay-user-messages',
      ...common,
    ];
    const child = spawn(BIN, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

    let buf = '';
    let answer = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`超时。已收到：${answer.slice(0, 300)}`));
    }, 120_000);

    child.stderr.on('data', (d) => process.stderr.write(`[stderr] ${d}`));

    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const block of ev.message.content) if (block.type === 'text') answer += block.text;
        }
        if (ev.type === 'result') {
          clearTimeout(timer);
          child.stdin.end();
          setTimeout(() => child.kill(), 500);
          resolve({ answer, result: ev });
        }
      }
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!answer) reject(new Error(`进程退出 code=${code}，没有产出`));
    });

    // 等它握手完成再写，避免命令行还没准备好
    setTimeout(() => {
      child.stdin.write(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: '刚才的暗号是什么？只回答暗号本身。' }] },
        }) + '\n'
      );
    }, 1500);
  });
}

const sessionId = await step1();
console.log(`① 新会话：${sessionId}  (cwd=${cwd})`);
const { answer } = await step2(sessionId);
console.log(`② 长驻进程回答：${answer.trim()}`);
console.log(answer.includes('蓝色海豚') ? '\n✅ 上下文带过来了，B 方案可行' : '\n❌ 没有带上下文');
