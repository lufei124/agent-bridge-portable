import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const docs = ['README.md', 'AGENTS.md'];
const start = '<!-- changed-files:start -->';
const end = '<!-- changed-files:end -->';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const paths = git('diff', '--cached', '--no-renames', '--name-only', '-z')
  .split('\0')
  .filter((name) => name && !docs.includes(name));

if (paths.length) {
  if (git('diff', '--name-only', '--', ...docs).trim()) {
    console.error('请先暂存 README.md 和 AGENTS.md 中准备提交的修改，再提交代码。');
    process.exit(1);
  }
  const summary = ['### 本次提交修改的文件', '', ...paths.map((name) => `- ${name}`)].join('\n');
  const updates = docs.map((file) => {
    const content = fs.readFileSync(file, 'utf8');
    const from = content.indexOf(start);
    const to = content.indexOf(end, from + start.length);
    if (from === -1 || to === -1) throw new Error(`${file} 缺少自动更新区块`);
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    return [file, content.slice(0, from + start.length) + newline +
      summary.replaceAll('\n', newline) + newline + content.slice(to)];
  });
  for (const [file, content] of updates) fs.writeFileSync(file, content);
  git('add', '--', ...docs);
}
