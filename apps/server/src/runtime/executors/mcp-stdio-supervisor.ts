import { PROCESS_TREE_TRACKER } from './process-tree-tracker.js';
/**
 * 新任务、工作会话与全局对话的 stdio MCP 监护器：与工作会话 bash 同一托管方式。
 * 以独立进程组启动服务，MCP 消息经监护器的 stdin/stdout 原样透传，监护器自身不向 stdout 写任何内容。
 * 服务端关闭输入、发送 SIGTERM 或服务端退出导致管道断开时，先向整个进程组发 SIGTERM，宽限后 SIGKILL；
 * 组内不再有存活成员才退出，作为停止证明。采样间主动脱组且未观察到的后代不保证回收。
 */
export const MCP_STDIO_SUPERVISOR = String.raw`
const {spawn, execFileSync} = require('node:child_process');
${PROCESS_TREE_TRACKER}
const config = JSON.parse(process.argv[1]);
let stopping = false, killTimer, polling;
const child = spawn(config.command, config.args, {cwd: config.cwd, env: process.env, detached: true, stdio: ['pipe', 'inherit', 'inherit']});
let tree;
child.once('spawn', () => { tree=processTree(child.pid);try{tree.observe();}catch{} });
const observation = setInterval(() => {try{tree?.observe();}catch{}},50);
function alive() { try { return tree ? tree.observe().length : 1; } catch { return 1; } }
function signalGroup(signal) { try { tree?.signal(signal); } catch {} }
function stop() {
  if (stopping) return;
  stopping = true;
  signalGroup('SIGTERM');
  killTimer = setTimeout(() => signalGroup('SIGKILL'), config.graceMillis);
}
function finish(code) {
  stop();
  polling ??= setInterval(() => { if (!alive()) { clearInterval(polling); clearInterval(observation); clearTimeout(killTimer); process.exit(0); } }, 100);
}
child.stdin.on('error', () => {});
process.stdin.pipe(child.stdin);
process.stdin.on('end', stop);
process.on('SIGTERM', stop); process.on('SIGINT', stop);
child.once('error', () => process.exit(127));
child.once('exit', code => finish(code ?? 1));
`;
