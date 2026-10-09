import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { NativeTaskTools } from '../src/runtime/executors/native-task-tools.js';
import { managedBashTool } from '../src/runtime/executors/managed-bash-tool.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

async function eventually(check: () => Promise<void>) {
  let last: unknown;
  for (let i = 0; i < 100; i++) { try { await check(); return; } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 25)); } }
  throw last;
}

test('真实应用关闭先停止跨会话 bash，再关闭数据库，退出结果可从持久记录重新核对', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-bash-application-'));
  const app = createMultivacApplication(testApplicationEnvironment(root));
  let applicationClosed = false;
  try {
    await app.ready;
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const port = (app.server.address() as { port: number }).port;
    const api = `http://127.0.0.1:${port}`;
    const post = async (path: string, data: unknown) => {
      const response = await fetch(`${api}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
      const result = await response.json(); assert.equal(response.ok, true, JSON.stringify(result)); return result;
    };
    for (const sessionId of ['close-a', 'close-b']) {
      await post('/api/sessions', { sessionId, title: sessionId });
      const command = `exec '${process.execPath}' -e 'process.on("SIGTERM",()=>{});console.log("shutdown-ready");setInterval(()=>{},1000)'`;
      await post(`/api/sessions/${sessionId}/turns`, { commandId: `start-${sessionId}`, assistantSessionId: sessionId, contextRefs: [], text: `bash执行：${JSON.stringify({ command, mode: 'background', name: sessionId })}` });
    }
    const processes = app.managedProcesses.list(); assert.equal(processes.length, 2);
    for (const process of processes) await eventually(async () => assert.match((await app.managedProcesses.logs(process.processId)).text, /shutdown-ready/));
    await new Promise<void>(resolve => app.server.close(() => resolve()));
    await app.close(); applicationClosed = true;
    const store = new SqliteAssistantStore(app.paths.databasePath);
    try {
      const records = store.managedProcesses.all(); assert.equal(records.length, 2);
      assert.ok(records.every(record => record.public.state === 'exited' && !!record.public.endedAt));
      for (const record of records) assert.throws(() => process.kill(record.pid!, 0), { code: 'ESRCH' });
    } finally { store.close(); }
  } finally {
    if (!applicationClosed) { app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close(); }
    await rm(root, { recursive: true, force: true });
  }
});


test('应用关闭期间任务 bash 仍核对原生退出、输出额度和待退出租约，再释放调度所有者', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-bash-task-close-'));
  const adapter = new FakeCoordinatorAdapter();
  const app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: adapter });
  let native: NativeTaskTools | undefined; let applicationClosed = false;
  try {
    await app.ready; adapter.armPromptCompletionBarrier();
    const task = app.tasks.create({ commandId: 'create', title: '关闭核对', goal: '保持任务隔离' }).task;
    await app.taskExecution.control(task.taskId, { commandId: 'start', revision: 1, action: 'start' });
    await adapter.waitForPromptCompletionBarrierEntry();
    const run = app.tasks.detail(task.taskId).runs![0]!;
    native = await NativeTaskTools.create(run.directory!.path, [], (phase, marker, bytes) => app.taskExecution.nativeLease(run.sessionId, phase, marker, bytes));
    const source = { sessionId: run.sessionId, executionId: run.commandId, directory: run.directory!.path, taskId: task.taskId, runId: run.runId };
    const tool = managedBashTool(run.sessionId, run.directory!.path, { execute: (_id, _cwd, call, input, signal, onData, isolated) => app.managedProcesses.bash.execute(source, call, input, signal, onData, isolated) }, native);
    const execution = tool.execute('task-close', { command: `exec '${process.execPath}' -e 'console.log("lease-ready");setInterval(()=>{},1000)'` }, undefined, undefined, undefined as never).catch(error => error);
    await eventually(async () => {
      const item = app.managedProcesses.list()[0]; assert.ok(item);
      assert.match((await app.managedProcesses.logs(item.processId)).text, /lease-ready/);
    });
    await app.close(); applicationClosed = true; await execution;
    assert.equal(native.processesStopped, true);
    const store = new SqliteAssistantStore(app.paths.databasePath);
    try {
      const record = store.taskRuns.get(run.runId)!;
      assert.deepEqual(record.nativePendingIds, []); assert.ok(record.outputBytes! >= 'lease-ready\n'.length);
      assert.equal(store.managedProcesses.all()[0]!.public.state, 'exited');
      assert.equal(store.taskRuntime.owner(), null);
    } finally { store.close(); }
  } finally { native?.dispose(); if (!applicationClosed) await app.close(); await rm(root, { recursive: true, force: true }); }
});
