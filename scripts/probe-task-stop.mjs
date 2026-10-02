import { spawn } from 'node:child_process';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 仅运行受控探针，不调用模型、不读取用户资料；失败表示原生进程组停止不足以充当任务停止门禁。
if (process.platform !== 'darwin') {
  console.error('此探针只验证 macOS Seatbelt 与进程组行为。');
  process.exitCode = 2;
} else {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'multivac-task-stop-probe-')));
  let childPid;
  try {
    const profile = `(version 1) (deny default) (allow process-exec) (allow process-fork)
      (allow process-info* (target self)) (allow sysctl-read) (allow file-read*)
      (allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))`;
    const childCode = 'setTimeout(()=>require("node:fs").writeFileSync("late-write.txt","still-running"),300);setTimeout(()=>{},30000);';
    const launcher = 'const c=require("node:child_process").spawn(process.execPath,["-e",process.argv[1]],{detached:true,stdio:"ignore"});process.stdout.write(String(c.pid));c.unref();';
    const worker = spawn('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', launcher, childCode], {
      cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { HOME: root, TMPDIR: root, PATH: '/usr/bin:/bin', OPENSSL_CONF: '/dev/null' },
    });
    let output = '';
    let error = '';
    worker.stdout.on('data', (chunk) => { output += chunk; });
    worker.stderr.on('data', (chunk) => { error += chunk; });
    const result = await new Promise((resolve, reject) => {
      worker.on('error', reject);
      worker.on('close', (code) => resolve(code));
    });
    if (result !== 0) throw new Error(`探针未启动：${error.slice(0, 1000)}`);
    childPid = Number(output);
    if (!Number.isSafeInteger(childPid) || childPid < 2) throw new Error('未取得探针子进程 PID。');
    try { process.kill(-worker.pid, 'SIGKILL'); }
    catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
    await new Promise((resolve) => setTimeout(resolve, 600));
    let lateWrite = false;
    try { await access(join(root, 'late-write.txt')); lateWrite = true; }
    catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
    console.log(JSON.stringify({ parentExited: true, processGroupStopped: true, detachedChildWroteAfterStop: lateWrite, safeToReleaseLease: !lateWrite }));
    process.exitCode = lateWrite ? 1 : 0;
  } finally {
    // 只清理本探针返回的精确 PID 与自建临时目录，不按进程名称清理。
    if (childPid) {
      try { process.kill(-childPid, 'SIGKILL'); }
      catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
    }
    await rm(root, { recursive: true, force: true });
  }
}
