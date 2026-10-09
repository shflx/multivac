import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { ManagedProcessService } from '../src/application/managed-process-service.js';
import { managedBashTool } from '../src/runtime/executors/managed-bash-tool.js';
import { NativeTaskTools } from '../src/runtime/executors/native-task-tools.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'multivac-bash-'));
  const work = join(root, 'work'); await mkdir(work);
  const store = new SqliteAssistantStore(join(root, 'store.sqlite'));
  const service = new ManagedProcessService(store.managedProcesses, join(root, 'logs'), []);
  const source = { sessionId: 'session-a', executionId: 'turn-a', directory: work };
  return { root, work, store, service, source, close: async () => { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
}
async function eventually(check: () => Promise<void> | void) {
  let last: unknown;
  for (let i = 0; i < 80; i++) { try { await check(); return; } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 25)); } }
  throw last;
}
const long = `exec '${process.execPath}' -e 'console.log("ready");setInterval(()=>{},1000)'`;

test('前台 bash 经 SDK 返回输出，登记会话/调用/进程身份与失败，普通历史不占运行页', async () => {
  const f = await fixture();
  try {
    const port = { execute: (_session: string, _cwd: string, call: string, ...args: Parameters<typeof f.service.bash.execute> extends [unknown, unknown, ...infer R] ? R : never) => f.service.bash.execute(f.source, call, ...args) };
    const tool = managedBashTool(f.source.sessionId, f.work, port);
    const output = await tool.execute('call-demo|fc-demo', { command: 'printf "hello\\n"' }, undefined, undefined, undefined as never);
    assert.match(JSON.stringify(output.content), /hello/);
    const record = f.store.managedProcesses.all()[0]!;
    assert.equal(record.public.toolCallId, 'call-demo|fc-demo'); assert.equal(record.public.executionId, 'turn-a');
    assert.equal(record.public.sessionId, 'session-a'); assert.equal(record.public.mode, 'foreground');
    assert.ok(record.public.pid); assert.equal(record.public.pid, record.public.processGroupId);
    await eventually(() => assert.equal(f.service.list(true)[0]!.state, 'exited'));
    assert.equal(f.service.list().length, 0);
    await assert.rejects(tool.execute('failure-call', { command: 'echo broken; exit 7' }, undefined, undefined, undefined as never), /code 7/);
    assert.equal(f.store.managedProcesses.all()[0]!.public.exitCode, 7);
    assert.match((await f.service.logs(record.public.processId)).text, /hello/);
  } finally { await f.close(); }
});

test('后台返回标识、日志与端口，同调用重放不重启，轮次结束与新一轮不停止已有服务', async () => {
  const f = await fixture();
  try {
    const command = `exec '${process.execPath}' -e 'require("node:http").createServer((q,r)=>r.end("ok")).listen(0,"127.0.0.1",()=>console.log("listening"));'`;
    const input = { command, mode: 'background' as const, name: '开发服务' };
    const [a, b] = await Promise.all([f.service.bash.execute(f.source, 'server-call', input, undefined, () => {}), f.service.bash.execute(f.source, 'server-call', input, undefined, () => {})]);
    assert.equal(a.process.processId, b.process.processId); assert.equal(f.store.managedProcesses.all().length, 1);
    await eventually(async () => { await f.service.observe(); assert.ok(f.service.get(a.process.processId)!.port); });
    const port = f.service.get(a.process.processId)!.port;
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'ok');
    await eventually(async () => assert.match((await f.service.logs(a.process.processId)).text, /listening/));
    f.service.bash.resumeSession('session-a');
    await f.service.bash.execute({ ...f.source, executionId: 'turn-b' }, 'next-call', { command: 'true' }, undefined, () => {});
    assert.equal(f.service.get(a.process.processId)!.state, 'running');
    await assert.rejects(f.service.bash.execute(f.source, 'server-call', { ...input, name: 'changed' }, undefined, () => {}), /参数/);
    await f.service.stop(a.process.processId);
    assert.equal(f.service.get(a.process.processId)!.state, 'exited');
    await assert.rejects(fetch(`http://127.0.0.1:${port}`));
  } finally { await f.close(); }
});

test('bash 启动器退出后组内子进程仍登记并可停止，停止覆盖普通子孙进程', async () => {
  const f = await fixture();
  try {
    const command = `'${process.execPath}' -e 'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});setInterval(()=>{},1000)' > children.log 2>&1 &`;
    const result = await f.service.bash.execute(f.source, 'tree', { command }, undefined, () => {});
    assert.equal(result.exitCode, 0); assert.equal(result.process.state, 'running');
    const stopped = await f.service.stop(result.process.processId);
    assert.equal(stopped.state, 'exited');
    const receipt = JSON.parse(await readFile(join(f.root, 'logs', `${stopped.processId}.exit.json`), 'utf8'));
    assert.equal(receipt.groupStopped, true);
  } finally { await f.close(); }
});

test('停止执行只清理该轮进程，结束会话清理全部轮次，其他会话不受影响', async () => {
  const f = await fixture();
  try {
    const start = (sessionId: string, executionId: string) => f.service.bash.execute({ ...f.source, sessionId, executionId }, `${sessionId}-${executionId}`, { command: long, mode: 'background' }, undefined, () => {});
    const old = await start('session-a', 'old'); const current = await start('session-a', 'current'); const other = await start('session-b', 'current');
    await f.service.bash.stopExecution('session-a', 'current');
    assert.equal(f.service.get(current.process.processId)!.state, 'exited'); assert.equal(f.service.get(old.process.processId)!.state, 'running');
    await f.service.stopSession('session-a');
    assert.equal(f.service.get(old.process.processId)!.state, 'exited'); assert.equal(f.service.get(other.process.processId)!.state, 'running');
    await assert.rejects(start('session-a', 'late'), /已停止/);
    f.service.bash.resumeSession('session-a');
    const next = await start('session-a', 'next'); assert.equal(next.process.state, 'running');
  } finally { await f.close(); }
});

test('取消与超时保留输出，应用关闭升级强制停止并核对所有登记进程组', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController(); let output = '';
    const running = f.service.bash.execute(f.source, 'abort', { command: long }, controller.signal, data => { output += data.toString(); });
    await eventually(() => assert.match(output, /ready/)); controller.abort();
    await assert.rejects(running, /aborted/);
    await assert.rejects(f.service.bash.execute(f.source, 'timeout', { command: long, timeout: 0.1 }, undefined, () => {}), /timeout/);
    const command = `exec '${process.execPath}' -e 'process.on("SIGTERM",()=>{});console.log("ignoring");setInterval(()=>{},1000)'`;
    const background = await f.service.bash.execute(f.source, 'force', { command, mode: 'background' }, undefined, () => {});
    await eventually(async () => assert.match((await f.service.logs(background.process.processId)).text, /ignoring/));
    await f.service.close();
    assert.ok(f.service.list(true).every(item => ['exited', 'failed'].includes(item.state)));
    assert.throws(() => process.kill(background.process.pid!, 0), { code: 'ESRCH' });
    await assert.rejects(f.service.bash.execute(f.source, 'after-close', { command: 'true' }, undefined, () => {}), /已停止/);
  } finally { await f.close(); }
});

test('任务 bash 统一登记但沿用禁止派生和额度租约', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture(); const leases: string[] = [];
  const native = await NativeTaskTools.create(f.work, [], (phase) => { leases.push(phase); return 100000; });
  try {
    const source = { ...f.source, taskId: 'task', runId: 'run' };
    const tool = managedBashTool(source.sessionId, f.work, { execute: (_id, _cwd, call, input, signal, onData, isolated) => f.service.bash.execute(source, call, input, signal, onData, isolated) }, native);
    await tool.execute('task-call', { command: 'echo task' }, undefined, undefined, undefined as never);
    assert.deepEqual(leases, ['starting', 'settled']);
    const item = f.store.managedProcesses.all()[0]!.public;
    assert.equal(item.taskId, 'task'); assert.equal(item.runId, 'run'); assert.equal(item.processGroupId, null); assert.equal(item.state, 'exited');
    assert.equal(native.processesStopped, true);
  } finally { native.dispose(); await f.close(); }
});

test('会话停止重试固定首次范围，后来启动的服务保留，不同会话复用命令拒绝', async () => {
  const f = await fixture();
  try {
    await f.service.bash.execute(f.source, 'first-background', { command: long, mode: 'background' }, undefined, () => {});
    await f.service.stopSession(f.source.sessionId, 'session-stop-command');
    f.service.bash.resumeSession(f.source.sessionId);
    const next = await f.service.bash.execute({ ...f.source, executionId: 'next-turn' }, 'next-background', { command: long, mode: 'background' }, undefined, () => {});
    await f.service.stopSession(f.source.sessionId, 'session-stop-command');
    assert.equal(f.service.get(next.process.processId)!.state, 'running');
    await assert.rejects(f.service.stopSession('other-session', 'session-stop-command'), /参数/);
  } finally { await f.close(); }
});


test('真实 Vite 与构建子进程可启动、读取日志与页面，并按本次进程组清理', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.work, 'index.html'), '<title>managed-vite</title><p>原型服务</p>');
    await writeFile(join(f.work, 'vite.config.mjs'), 'export default { server: { host: "127.0.0.1", port: 0 } };');
    const vite = fileURLToPath(new URL('../../../node_modules/vite/bin/vite.js', import.meta.url));
    const result = await f.service.bash.execute(f.source, 'vite', { command: `'${process.execPath}' '${vite}'`, mode: 'background', name: 'Vite 原型', timeout: 1 }, undefined, () => {});
    await eventually(async () => { await f.service.observe(); assert.ok(f.service.get(result.process.processId)!.port); });
    const port = f.service.get(result.process.processId)!.port;
    const response = await fetch(`http://127.0.0.1:${port}`);
    assert.match(await response.text(), /managed-vite/);
    assert.match((await f.service.logs(result.process.processId)).text, /VITE/);
    // 模拟截图中的启动等待参数；超过这个时间仍应保留服务。
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(f.service.get(result.process.processId)!.state, 'running');
    assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 200);
    await f.service.stop(result.process.processId);
    assert.equal(f.service.get(result.process.processId)!.state, 'exited');
    await assert.rejects(fetch(`http://127.0.0.1:${port}`));
  } finally { await f.close(); }
});

test('大量前台输出保持完整，日志尾部轮转有界；相同调用并发等待都获得输出', async () => {
  const f = await fixture();
  try {
    const command = `exec '${process.execPath}' -e 'process.stdout.write("line\\n".repeat(600000));'`;
    let output = ''; let duplicateOutput = '';
    const [result, duplicate] = await Promise.all([
      f.service.bash.execute(f.source, 'output', { command }, undefined, data => { output += data.toString(); }),
      f.service.bash.execute(f.source, 'output', { command }, undefined, data => { duplicateOutput += data.toString(); }),
    ]);
    assert.equal(result.process.processId, duplicate.process.processId);
    assert.equal(output.length, 3000000); assert.equal(duplicateOutput, output);
    assert.ok((await stat(join(f.root, 'logs', `${result.process.processId}.log`))).size <= 2 * 1024 * 1024);
    const log = await f.service.logs(result.process.processId); assert.equal(log.truncated, true); assert.ok(log.text.length <= 65536);
  } finally { await f.close(); }
});


test('后台启动等待超时清理本次启动，前台运行超时保存准确失败原因', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.bash.execute(f.source, 'background-startup-timeout', { command: long, mode: 'background', timeout: 0.0001 }, undefined, () => {}), /未在.*秒内启动/);
    assert.equal(f.service.bash.activeCount, 0);
    assert.ok(f.service.list(true).every(item => ['exited', 'failed'].includes(item.state)));
    await assert.rejects(f.service.bash.execute(f.source, 'foreground-runtime-timeout', { command: long, timeout: 0.1 }, undefined, () => {}), /timeout/);
    await eventually(async () => {
      const item = f.service.list(true).find(item => item.toolCallId === 'foreground-runtime-timeout')!;
      assert.equal(item.state, 'failed'); assert.match(item.reason, /执行超过 0.1 秒.*核对退出/);
    });
  } finally { await f.close(); }
});
