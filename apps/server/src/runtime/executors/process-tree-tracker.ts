/**
 * 私有监护脚本共用的进程归属核对。只接管自己创建的组与观察到的后代；
 * 每次发送信号复核启动身份，不操作仅凭旧 PID 推断的进程。
 * 在两次采样之间主动脱组且父进程已退出的后代可能未被观察到。
 */
export const PROCESS_TREE_TRACKER = String.raw`
function processTree(root) {
  const known = new Map();
  function snapshot() {
    return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], {encoding:'utf8',timeout:1000,env:{PATH:'/usr/bin:/bin',LC_ALL:'C',LANG:'C',TZ:'UTC'}})
      .trim().split('\n').map(line => line.trim().split(/\s+/)).filter(p => p.length >= 9)
      .map(p => ({pid:Number(p[0]),ppid:Number(p[1]),group:Number(p[2]),zombie:p[3].startsWith('Z'),identity:p.slice(4).join(' ')}));
  }
  function observe() {
    const all = snapshot();
    const groupOwned = all.some(p => p.group === root && !p.zombie && (known.get(p.pid)?.identity === p.identity || p.pid === root && !known.has(root)));
    let added = true;
    while (added) {
      added = false;
      for (const p of all) {
        if (p.zombie || known.has(p.pid)) continue;
        const parent = all.find(v => v.pid === p.ppid);
        if (p.pid === root && !known.has(root) || groupOwned && p.group === root || parent && known.get(parent.pid)?.identity === parent.identity) {
          known.set(p.pid, p); added = true;
        }
      }
    }
    return all.filter(p => !p.zombie && known.get(p.pid)?.identity === p.identity);
  }
  return {
    observe,
    signal(signal) {
      // 直接逐个作用于已复核身份的进程，避免根退出后按复用的组号发送信号。
      for (const p of observe().reverse()) {
        try { process.kill(p.pid, signal); } catch(e) { if (e.code !== 'ESRCH') throw e; }
      }
    },
    identities: () => [...known.values()].map(p => ({pid:p.pid,group:p.group,identity:p.identity})),
  };
}
`;
