/**
 * 守护进程看门狗。
 *
 * 每 30 秒检查一次 data/bridge.lock 里的 PID 是否还活着；不在了就重新拉起。
 * 由 Windows 任务计划在登录时启动，解决"PC 重启 / 进程崩了，手机上完全没反应"。
 *
 *   node tools/watchdog.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockFile = path.join(root, 'data', 'bridge.lock');
const logFile = path.join(root, 'data', 'watchdog.log');

function log(message) {
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    /* 日志写不了就算了 */
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // 存在但没权限，也算活着
  }
}

function daemonPid() {
  try {
    return Number(fs.readFileSync(lockFile, 'utf8').trim());
  } catch {
    return 0;
  }
}

function startDaemon() {
  const out = fs.openSync(path.join(root, 'data', 'bridge.log'), 'a');
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/index.mjs'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(out);
  log(`守护进程不在，已拉起 PID ${child.pid}`);
}

let coolingDown = 0;

function tick() {
  if (Date.now() < coolingDown) return;

  const pid = daemonPid();
  if (alive(pid)) return;

  log(pid ? `守护进程 PID ${pid} 已退出` : '没有锁文件（可能从未启动过）');
  startDaemon();
  coolingDown = Date.now() + 15_000; // 给新进程一点启动时间，别重复拉起
}

log('watchdog 启动');
tick();
setInterval(tick, 30_000);
