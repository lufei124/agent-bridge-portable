/**
 * E2 / E3 / E5 实测。
 *
 *   node tools/patrol-probe.mjs            # 快照一次
 *   node tools/patrol-probe.mjs --watch 10 # 每 60 秒一次，持续 10 分钟（观察空闲回收）
 *   node tools/patrol-probe.mjs --kill 13656 # 杀掉指定 PID，然后每 2 秒看 60 秒（E3）
 */

import { execFile } from 'node:child_process';

// GetLastInputInfo：系统级空闲毫秒数
const PS_IDLE = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class IdleProbe {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  public static uint Get() {
    LASTINPUTINFO li = new LASTINPUTINFO();
    li.cbSize = (uint)Marshal.SizeOf(li);
    GetLastInputInfo(ref li);
    return (uint)Environment.TickCount - li.dwTime;
  }
}
"@
[IdleProbe]::Get()
`;

function ps(script, timeout = 15000) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', script], { timeout }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

async function snapshot() {
  const idle = await ps(PS_IDLE);
  const list = await ps(
    `$p = Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | ForEach-Object {
       $sid = $null
       if ($_.CommandLine -match '--resume[= ]([0-9a-f-]{36})') { $sid = $matches[1] }
       [pscustomobject]@{ pid = $_.ProcessId; session = $sid }
     }
     $p | ConvertTo-Json -Depth 3 -Compress`
  );
  let procs = [];
  try {
    const parsed = JSON.parse(list || '[]');
    procs = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    procs = [];
  }
  return { idleMs: Number(idle), procs };
}

function fmtIdle(ms) {
  if (!Number.isFinite(ms)) return '未知';
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  return `${Math.round(ms / 60_000)} 分钟`;
}

function show(snap) {
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const list = snap.procs.map((p) => `${p.pid}${p.session ? `(${p.session.slice(0, 8)})` : '(新建会话)'}`).join(' ');
  console.log(`${stamp}  空闲 ${fmtIdle(snap.idleMs).padEnd(8)} claude 进程: ${list || '无'}`);
}

const args = process.argv.slice(2);
const watchIndex = args.indexOf('--watch');
const killIndex = args.indexOf('--kill');

if (killIndex !== -1) {
  // E3：杀掉后看扩展会不会自己起一个新的
  const pid = Number(args[killIndex + 1]);
  const before = await snapshot();
  console.log('杀掉前：');
  show(before);

  try {
    process.kill(pid);
    console.log(`\n已发送终止信号给 PID ${pid}`);
  } catch (err) {
    console.log(`\n终止失败：${err.message}`);
    process.exit(1);
  }

  const beforePids = new Set(before.procs.map((p) => p.pid));
  for (let i = 1; i <= 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const snap = await snapshot();
    const fresh = snap.procs.filter((p) => !beforePids.has(p.pid));
    if (fresh.length) {
      console.log(`第 ${i * 2} 秒：出现新进程 ${fresh.map((p) => p.pid).join(',')} → 扩展自动重启了`);
      process.exit(0);
    }
  }
  console.log('\n60 秒内没有新进程 → 扩展不会自动重启，必须重开标签页');
} else if (watchIndex !== -1) {
  const minutes = Number(args[watchIndex + 1]) || 10;
  const end = Date.now() + minutes * 60_000;
  while (Date.now() < end) {
    show(await snapshot());
    await new Promise((r) => setTimeout(r, 60_000));
  }
  show(await snapshot());
} else {
  show(await snapshot());
}
