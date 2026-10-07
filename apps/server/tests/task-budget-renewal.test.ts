import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TASK_BUDGET, UNKNOWN_CHANGE_ORIGIN, type Task } from '@multivac/contracts';
import { TaskService } from '../src/application/task-service.js';
import { TaskExecutionService } from '../src/application/task-execution-service.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'multivac-budget-renewal-'));
  const path = join(directory, 'db.sqlite');
  const store = new SqliteAssistantStore(path);
  const tasks = new TaskService({ repository: store.tasks, runs: store.taskRuns, requireProject: () => {} });
  let now = Date.parse('2026-10-07T04:00:00Z');
  let millis = 2 * 3_600_000;
  let wait = false;
  let entered!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  const execution = new TaskExecutionService({
    tasks, runs: store.taskRuns, events: new AssistantEventStream(), now: () => new Date(now).toISOString(),
    defaultBudget: () => ({ ...DEFAULT_TASK_BUDGET, maxMillis: millis }),
    prepare: async () => ({ directory: { kind: 'task-isolated', path: directory }, baseline: 'baseline' }),
    createSession: async () => {},
    runtime: () => ({ commands: {
      currentPromptCommandId: () => null,
      cancel: async () => { throw new Error('取消通过发送信号收敛'); },
      send: async (command, options) => {
        entered();
        if (wait) await new Promise<void>(resolve => { if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener('abort', () => resolve(), { once: true }); });
        return { ...command, kind: 'send', status: 'terminal', terminalOutcome: 'succeeded', error: null,
          piSessionId: 'pi', piEntryId: 'entry', piTurnRef: null, createdAt: '', updatedAt: '' };
      },
    } }),
  });
  async function start(task: Task) {
    await execution.control(task.taskId, { commandId: `start:${task.taskId}`, revision: task.revision, action: 'start' });
    if (wait) await entry; else await execution.idle();
    return store.taskRuns.get(tasks.get(task.taskId).currentRunId!)!;
  }
  function exhaust(task: Task, runId: string) {
    tasks.facts(() => store.taskRuns.save({ ...store.taskRuns.get(runId)!, elapsedMs: 900_960, outputBytes: 16 * 1024 * 1024, status: 'paused', stopIntent: 'pause' }));
    tasks.transition(task.taskId, { commandId: `exhaust:${task.taskId}`, key: task.taskId, kind: 'budget', summary: '测试中已耗尽额度。' }, current => ({ ...current, status: 'paused', pauseSource: 'budget' }));
  }
  return { directory, path, store, tasks, execution, start, exhaust,
    advance: (value: number) => { now += value; }, preference: (value: number) => { millis = value; }, hold: () => { wait = true; },
    async close() { execution.dispose(); await execution.idle(); store.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('旧任务继续时补满时间、次数与字节额度，保留文件边界和历史，命令重放不重复补充', async () => {
  const f = await fixture();
  try {
    const task = f.tasks.create({ commandId: 'create', title: '旧任务', goal: '继续已有工作', budget: { maxRuns: 1, maxMillis: 900000, maxOutputBytes: 4096 } }).task;
    const old = await f.start(task); f.exhaust(task, old.runId);
    const command = { commandId: 'resume', revision: f.tasks.get(task.taskId).revision, action: 'resume' as const };
    const accepted = await f.execution.control(task.taskId, command);
    await f.execution.idle();
    const latest = f.store.taskRuns.get(f.tasks.get(task.taskId).currentRunId!)!;
    assert.equal(latest.sessionId, old.sessionId);
    assert.deepEqual(latest.directory, old.directory);
    assert.equal(latest.baseline, old.baseline);
    assert.deepEqual(latest.budgetRenewal?.limit, { ...DEFAULT_TASK_BUDGET, maxMillis: 2 * 3_600_000 });
    assert.deepEqual(f.store.taskRuns.get(old.runId)?.elapsedMs, 900_960);
    assert.equal(f.store.taskRuns.get(old.runId)?.outputBytes, 16 * 1024 * 1024);
    assert.equal(f.execution.budget(task.taskId).remainingMillis, 2 * 3_600_000);
    assert.equal(f.execution.budget(task.taskId).remainingRuns, 19);
    assert.equal(f.execution.budget(task.taskId).remainingBytes, 16 * 1024 * 1024);
    assert.equal(f.tasks.get(task.taskId).status, 'waiting');
    assert.deepEqual(await f.execution.control(task.taskId, command), accepted);
    assert.equal(f.store.taskRuns.tree(task.taskId).length, 2);
    // 偏好变化与数据库重开不会丢失已经发放的额度检查点。
    f.preference(6 * 3_600_000);
    const reopened = new SqliteAssistantStore(f.path);
    try { assert.deepEqual(reopened.taskRuns.get(latest.runId)?.budgetRenewal, latest.budgetRenewal); } finally { reopened.close(); }
    assert.equal(f.execution.budget(task.taskId).remainingMillis, 2 * 3_600_000);
    await f.execution.control(task.taskId, { commandId: 'pause-again', revision: f.tasks.get(task.taskId).revision, action: 'pause' });
    f.tasks.update(task.taskId, { commandId: 'explicit-budget', revision: f.tasks.get(task.taskId).revision, patch: { budget: { ...DEFAULT_TASK_BUDGET, maxMillis: 6 * 3_600_000 } } });
    assert.equal(f.execution.budget(task.taskId).remainingMillis, 6 * 3_600_000);
    await f.execution.control(task.taskId, { commandId: 'resume-again', revision: f.tasks.get(task.taskId).revision, action: 'resume' });
    await f.execution.idle();
    assert.equal(f.execution.budget(task.taskId).remainingRuns, 19);
    assert.equal(f.execution.budget(task.taskId).remainingMillis, 6 * 3_600_000);
    assert.equal(f.store.taskRuns.tree(task.taskId).length, 3);
  } finally { await f.close(); }
});

test('运行中时长和字节耗尽时，任务与运行的暂停说明一致，包含具体用量和继续方法', async () => {
  const f = await fixture();
  try {
    f.hold();
    const task = f.tasks.create({ commandId: 'create', title: '超限', goal: '核对停止', budget: { maxRuns: 20, maxMillis: 900000, maxOutputBytes: 4096 } }).task;
    const old = await f.start(task);
    f.advance(900_000);
    f.tasks.facts(() => f.store.taskRuns.save({ ...f.store.taskRuns.get(old.runId)!, outputBytes: 4096 }));
    await f.execution.stopForBudget(old.runId);
    const paused = f.tasks.get(task.taskId), run = f.store.taskRuns.get(old.runId)!;
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pauseSource, 'budget');
    assert.equal(run.stopConfirmed, true);
    assert.equal(run.reason, paused.reason);
    assert.match(paused.reason, /执行时间已用完.*已用 15 分钟，上限 15 分钟/);
    assert.match(paused.reason, /读写和输出额度已用完.*上限 4 KiB/);
    assert.match(paused.reason, /已有工作已保留.*继续任务/);
    assert.doesNotMatch(paused.reason, /用户暂停/);
  } finally { await f.close(); }
});

test('子任务主动继续重置根任务共享额度，其他子任务的后续消耗仍扣除同一份额度', async () => {
  const f = await fixture();
  try {
    const root = f.tasks.create({ commandId: 'root', title: '父任务', goal: '核对', budget: { maxRuns: 2, maxMillis: 900000, maxOutputBytes: 4096 } }).task;
    const child = f.tasks.create({ commandId: 'child', title: '子任务', goal: '核对', parentTaskId: root.taskId }).task;
    const sibling = f.tasks.create({ commandId: 'sibling', title: '另一个子任务', goal: '核对', parentTaskId: root.taskId }).task;
    const old = await f.start(child); f.exhaust(child, old.runId);
    await f.execution.control(child.taskId, { commandId: 'resume', revision: f.tasks.get(child.taskId).revision, action: 'resume' });
    await f.execution.idle();
    assert.equal(f.execution.budget(root.taskId).remainingRuns, 19);
    await f.start(sibling);
    assert.equal(f.execution.budget(root.taskId).remainingRuns, 18);
    assert.equal(f.tasks.get(root.taskId).budget?.maxMillis, 900000);
    assert.throws(() => f.tasks.update(child.taskId, { commandId: 'move', revision: f.tasks.get(child.taskId).revision, patch: { parentTaskId: null } }), /共享预算/);
  } finally { await f.close(); }
});

test('人工请求后的自动恢复不补充额度，用户主动继续仍可补充', async () => {
  const f = await fixture();
  try {
    const task = f.tasks.create({ commandId: 'create', title: '人工恢复', goal: '核对', budget: { maxRuns: 1, maxMillis: 900000, maxOutputBytes: 4096 } }).task;
    const old = await f.start(task); f.exhaust(task, old.runId);
    await f.execution.control(task.taskId, { commandId: 'human-resume', revision: f.tasks.get(task.taskId).revision, action: 'resume' }, UNKNOWN_CHANGE_ORIGIN, 'human');
    assert.equal(f.store.taskRuns.list(task.taskId)[0]?.budgetRenewal, undefined);
    assert.ok(f.execution.budget(task.taskId).remainingMillis < 0);
    await f.execution.control(task.taskId, { commandId: 'pause-queued', revision: f.tasks.get(task.taskId).revision, action: 'pause' });
    await f.execution.control(task.taskId, { commandId: 'user-resume', revision: f.tasks.get(task.taskId).revision, action: 'resume' });
    await f.execution.idle();
    assert.ok(f.execution.budget(task.taskId).remainingMillis > 0);
  } finally { await f.close(); }
});

test('停止未确认、未核对工具、待处理请求与旧 revision 均不能通过继续发放额度', async () => {
  const f = await fixture();
  try {
    const task = f.tasks.create({ commandId: 'create', title: '受限继续', goal: '核对' }).task;
    const old = await f.start(task); f.exhaust(task, old.runId);
    const revision = f.tasks.get(task.taskId).revision;
    await assert.rejects(f.execution.control(task.taskId, { commandId: 'stale', revision: 1, action: 'resume' }), /已变化/);
    f.execution.setPendingRequest(() => true);
    await assert.rejects(f.execution.control(task.taskId, { commandId: 'request', revision, action: 'resume' }), /原人工请求/);
    f.execution.setPendingRequest(() => false);
    f.tasks.facts(() => f.store.taskRuns.save({ ...f.store.taskRuns.get(old.runId)!, pendingToolIds: ['unknown'] }));
    await assert.rejects(f.execution.control(task.taskId, { commandId: 'tool', revision, action: 'resume' }), /未核对工具/);
    f.tasks.facts(() => f.store.taskRuns.save({ ...f.store.taskRuns.get(old.runId)!, stopConfirmed: false, pendingToolIds: [] }));
    await assert.rejects(f.execution.control(task.taskId, { commandId: 'stop', revision, action: 'resume' }), /未确认停止/);
    assert.equal(f.store.taskRuns.tree(task.taskId).length, 1);
    assert.equal(f.store.taskRuns.get(old.runId)?.budgetRenewal, undefined);
  } finally { await f.close(); }
});
