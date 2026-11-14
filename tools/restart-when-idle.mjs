/**
 * 等桥空闲时重启守护进程。
 *
 * 守护进程每个回合都会起一个 claude 子进程。直接 taskkill 会把正在生成的
 * 这一轮一起杀掉，手机上就卡在"正在工作"——这个脚本先等子进程退出，再重启。
 *
 *   node tools/restart-when-idle.mjs <daemonPid>
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const daemonPid = Number(process.argv[2]);

if (!Number.isInteger(daemonPid) || daemonPid <= 0) {
  console.error('用法: node tools/restart-when-idle.mjs <daemonPid>');
  process.exit(1);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** 守护进程当前的子进程（运行时就是 claude 子进程） */
function children(pid) {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} } | Select-Object -ExpandProperty ProcessId`,
      ],
      { encoding: 'utf8', windowsHide: true }
    );
    return out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

// 最多等 30 分钟；期间守护进程要是自己没了，就不用再动它
for (let i = 0; i < 900; i++) {
  if (!alive(daemonPid)) process.exit(0);
  if (children(daemonPid).length === 0) break;
  sleep(2000);
}

if (alive(daemonPid)) {
  try {
    execFileSync('taskkill', ['/F', '/PID', String(daemonPid)], { stdio: 'ignore' });
  } catch {
    /* 可能刚好退了 */
  }
}
sleep(1000);

const log = fs.openSync(path.join(root, 'data', 'bridge.log'), 'a');
const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/index.mjs'], {
  cwd: root,
  detached: true,
  stdio: ['ignore', log, log],
  windowsHide: true,
});
child.unref();
fs.closeSync(log);
console.log(`已重启守护进程（旧 PID ${daemonPid} -> 新 PID ${child.pid}）`);
