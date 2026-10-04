/**
 * 服务端私有监护器：与沙箱进程分离，沙箱无法读取配置、日志或退出凭据。
 * 服务连接断开也会收敛子进程；只有 close 后才原子写出停止证明。
 */
export const MANAGED_SUPERVISOR = String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
let child, timer, killTimer, stopping = false, bytes = 0;
const input = readline.createInterface({input: process.stdin});
function stop() {
  stopping = true;
  if (!child) return;
  child.kill('SIGTERM');
  killTimer ??= setTimeout(() => child.kill('SIGKILL'), 500);
}
input.once('line', line => {
  const config = JSON.parse(line);
  child = spawn('/usr/bin/sandbox-exec', ['-p', config.profile, config.executable, ...config.args], {
    cwd: config.directory, stdio: ['ignore', 'pipe', 'pipe'],
    env: {PATH:'/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin',HOME:config.directory,TMPDIR:config.directory,LANG:'en_US.UTF-8',OPENSSL_CONF:'/dev/null'}
  });
  timer = setTimeout(stop, config.maxMillis);
  if (stopping) stop();
  child.once('spawn', () => process.stdout.write(JSON.stringify({pid:child.pid})+'\n'));
  let spawnError = false;
  child.once('error', () => { spawnError = true; });
  const receive = chunk => {
    bytes += chunk.length;
    if (bytes > config.maxBytes) { stop(); return; }
    fs.appendFileSync(config.log, chunk, {mode:0o600});
  };
  child.stdout.on('data', receive); child.stderr.on('data', receive);
  child.once('close', (code, signal) => {
    clearTimeout(timer); clearTimeout(killTimer);
    const result = {token:config.token,pid:child.pid ?? null,code,signal,spawnError,bytes,stopping,endedAt:new Date().toISOString()};
    fs.writeFileSync(config.receipt+'.pending', JSON.stringify(result), {mode:0o600});
    fs.renameSync(config.receipt+'.pending', config.receipt);
    process.stdout.write(JSON.stringify({closed:true})+'\n', () => process.exit(0));
  });
  input.on('line', stop);
});
input.on('close', stop);
process.on('SIGTERM', stop); process.on('SIGINT', stop);
`;
