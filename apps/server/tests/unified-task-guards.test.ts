import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { TaskToolLifecycle } from '../src/runtime/executors/task-tool-lifecycle.js';
import { createBoundaryFileTools } from '../src/runtime/executors/pi-tool-boundary.js';
import { TaskExecutionService } from '../src/application/task-execution-service.js';
import { TaskService } from '../src/application/task-service.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

for (const stop of ['pause', 'cancel'] as const) test(`文件真实执行入口：${stop} 后的迟到批准不能继续原 Run`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-unified-file-'));
  const cwd = join(root, 'work'); await mkdir(cwd);
  const target = join(root, 'outside.txt'); await writeFile(target, 'original');
  let active = true, approve!: () => void, requested!: () => void;
  const request = new Promise<void>(resolve => { requested = resolve; });
  const leases = new Set<string>();
  const lifecycle = new TaskToolLifecycle((phase, marker) => {
    if ((phase === 'starting' || phase === 'check') && !active) throw new Error('原 Run 已暂停或取消。');
    if (phase === 'starting') leases.add(marker);
    if (phase === 'settled') leases.delete(marker);
    return 10000;
  });
  const tools = createBoundaryFileTools({ cwd, assertExecution: () => { if (!active) throw new Error('原 Run 已暂停或取消。'); },
    authorizeOutsideAccess: async () => { requested(); await new Promise<void>(resolve => { approve = resolve; }); return { allowed: true }; } });
  try {
    const tool = lifecycle.wrap(tools.find(tool => tool.name === 'write')!);
    const writing = tool.execute('original-call', { path: target, content: 'must not write' }, undefined, undefined, {} as ExtensionContext);
    const denied = assert.rejects(writing, /原 Run 已暂停或取消/);
    await request; assert.equal(lifecycle.stopped, false);
    active = false; approve(); await denied;
    assert.equal(await readFile(target, 'utf8'), 'original'); assert.equal(lifecycle.stopped, true); assert.equal(leases.size, 0);
  } finally { lifecycle.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('原进程凭据恢复只结算对应 Run 与剩余输出，未知/错配身份不释放租约，也不重发工具', async () => {
  const store = new SqliteAssistantStore(':memory:');
  const tasks = new TaskService({ facts: store.taskFacts, afterCommit: () => {}, requireProject: () => {} });
  const execution = new TaskExecutionService({ tasks, runs: store.taskRuns, events: new AssistantEventStream(), settleArtifacts: async () => {},
    prepare: async () => { throw new Error('受控失败，不启动模型。'); }, createSession: async () => {}, runtime: () => { throw new Error('不能重发'); } });
  try {
    const task = tasks.create({ commandId: 'create', title: '持久恢复', goal: '核对原凭据' }).task;
    await execution.control(task.taskId, { commandId: 'start', revision: task.revision, action: 'start' }); await execution.idle();
    const run = store.taskRuns.get(tasks.get(task.taskId).currentRunId!)!;
    run.stopConfirmed = false; run.status = 'recovery'; run.nativePendingIds = ['bash-process:process', 'unknown-marker']; run.outputBytes = 100;
    store.taskRuns.save(run);
    const record: import('../src/modules/processes/managed-process.js').ManagedProcessRecord = { backend: 'bash', executionMode: 'workspace',
      token: 'proof', pid: 123, directory: '/fixture', commandId: 'call', fingerprint: 'fixed', ownerId: 'old-owner', accountedBytes: 20, totalOutputBytes: 80,
      public: { processId: 'process', sessionId: run.sessionId, taskId: run.taskId, runId: run.runId, executionId: run.commandId, revision: 1,
        name: 'test', command: 'test', state: 'recovery', requiredWhileRunning: true, startedAt: null, endedAt: null, port: null, exitCode: null, reason: '核对' } };
    execution.reconcileBashLease(record);
    assert.deepEqual(store.taskRuns.get(run.runId)!.nativePendingIds, run.nativePendingIds);
    record.public.state = 'exited'; record.public.executionId = 'other-run'; execution.reconcileBashLease(record);
    assert.equal(store.taskRuns.get(run.runId)!.outputBytes, 100);
    record.public.executionId = run.commandId; execution.reconcileBashLease(record); execution.reconcileBashLease(record);
    const restored = store.taskRuns.get(run.runId)!;
    assert.deepEqual(restored.nativePendingIds, ['unknown-marker']); assert.equal(restored.outputBytes, 160);
    assert.equal(restored.status, 'recovery'); assert.equal(restored.stopConfirmed, false);
    assert.throws(() => execution.nativeLease(run.sessionId, 'settled', 'late-other-run', 99), /不属于/);
    assert.equal(store.taskRuns.get(run.runId)!.outputBytes, 160);
  } finally { execution.dispose(); store.close(); }
});
