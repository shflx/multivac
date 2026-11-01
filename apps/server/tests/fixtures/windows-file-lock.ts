import { spawn } from 'node:child_process';
import { once } from 'node:events';

export async function withWindowsFileLock<T>(path: string, operation: () => Promise<T> | T): Promise<T> {
  const quoted = path.replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop';$file=[IO.File]::Open('${quoted}','Open','ReadWrite','None');[Console]::Out.WriteLine('locked');try{[Console]::In.ReadLine() | Out-Null}finally{$file.Dispose()}`;
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 4096); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        let output = '';
        child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('locked')) resolve(); });
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`文件锁进程提前退出：${code} ${stderr}`)));
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('等待 Windows 文件锁超时。')), 10000); }),
    ]);
    clearTimeout(timer);
    return await operation();
  } finally {
    clearTimeout(timer);
    child.stdin.end('\n');
    if (child.exitCode === null) {
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([once(child, 'exit'), new Promise((_, reject) => {
          stopTimer = setTimeout(() => { child.kill(); reject(new Error('释放 Windows 文件锁超时。')); }, 10000);
        })]);
      } finally { clearTimeout(stopTimer); }
    }
  }
}
