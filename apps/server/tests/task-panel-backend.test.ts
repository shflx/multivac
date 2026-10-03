import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Check } from 'typebox/value';
import { TaskDetailSchema, taskViewStatus, type TaskRun, type TaskStatus, type TaskViewStatus } from '@multivac/contracts';
import { TaskService } from '../src/application/task-service.js';
import { HumanRequestService } from '../src/application/human-request-service.js';
import { TaskExecutionService } from '../src/application/task-execution-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-panel-backend-'));
  const store = new SqliteAssistantStore(join(root, 'db.sqlite'));
  const events = new WorkbenchEvents();
  const assistantEvents = new AssistantEventStream();
  const tasks = new TaskService({ repository: store.tasks, runs: store.taskRuns, requests: store.humanRequests, artifacts: store.artifacts, events, requireProject: () => {} });
  let sends = 0;
  const execution = new TaskExecutionService({ tasks, runs: store.taskRuns, events: assistantEvents,
    prepare: async () => ({ directory: { kind: 'task-isolated', path: root }, baseline: null }),
    createSession: async () => {}, runtime: () => ({ commands: {
      currentPromptCommandId: () => null, cancel: async () => { throw new Error('没有可取消的旧执行'); },
      send: async (command) => { sends++; return { commandId: command.commandId, assistantSessionId: command.assistantSessionId, kind: 'send', status: 'terminal', terminalOutcome: 'succeeded', error: null, piSessionId: 'pi', piEntryId: 'entry', piTurnRef: null, createdAt: '', updatedAt: '' }; },
    } }),
  });
  const requests = new HumanRequestService({ tasks, runs: store.taskRuns, requests: store.humanRequests, execution, events, assistantEvents, authorization: { list: () => [], decide: () => { throw new Error('此测试没有授权操作'); } } });
  return { root, store, tasks, requests, execution, sends: () => sends,
    async close() { await execution.idle(); requests.dispose(); execution.dispose(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('面板状态在分页前筛选，与共享投影一致，检索能找到百条之后的旧任务', async () => {
  const f = await fixture();
  try {
    const tasks = [];
    const statuses: TaskStatus[] = ['idle', 'queued', 'running', 'waiting', 'review', 'paused', 'done', 'cancelled', 'failed', 'recovery'];
    for (const status of statuses) {
      const task = f.tasks.create({ commandId: `create-${status}`, title: `历史深处-${status}`, goal: '核对来源' }).task;
      f.tasks.transition(task.taskId, { commandId: `status-${status}`, key: status, kind: 'fixture', summary: '设置测试执行事实' }, (current) => ({ ...current, status }));
      tasks.push(f.tasks.get(task.taskId));
    }
    const paused = tasks.find((task) => task.status === 'paused')!;
    f.requests.create(paused.taskId, 'clarification', '待回应', 'clarification');
    f.requests.create(paused.taskId, 'review', '待验收', 'review', 'version');
    // 人工请求优先于暂停列，多个请求同时存在时以成果审核列展示。
    f.tasks.transition(paused.taskId, { commandId: 'user-paused', key: 'user-paused', kind: 'fixture', summary: '用户暂停不取消原请求' }, (current) => ({ ...current, status: 'paused', pauseSource: 'user' }));
    const pending = f.requests.list();
    for (const viewStatus of ['idle', 'running', 'waiting', 'review', 'paused', 'done', 'cancelled', 'unfinished'] as TaskViewStatus[]) {
      const all = f.tasks.list({ limit: 100 }).tasks;
      const expected = all.filter((task) => viewStatus === 'unfinished' ? !['done', 'cancelled'].includes(taskViewStatus(task, pending)) : taskViewStatus(task, pending) === viewStatus);
      const first = f.tasks.list({ viewStatus, limit: 1 });
      assert.equal(first.total, expected.length, viewStatus);
      const ids: string[] = [];
      let offset: number | null = 0;
      do {
        const page = f.tasks.list({ viewStatus, limit: 1, offset });
        ids.push(...page.tasks.map((task) => task.taskId)); offset = page.nextOffset;
      } while (offset !== null);
      assert.deepEqual(new Set(ids), new Set(expected.map((task) => task.taskId)), viewStatus);
    }
    for (let index = 0; index < 105; index++) f.tasks.create({ commandId: `filler-${index}`, title: `较新任务-${index}`, goal: '普通任务' });
    const filtered = f.tasks.list({ sort: 'recent', query: '历史深处-failed', viewStatus: 'waiting', limit: 100 });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.tasks[0]?.status, 'failed');
  } finally { await f.close(); }
});

test('历史超过百条仍核对旧待处理请求，分页完整，取消不遗漏失效记录', async () => {
  const f = await fixture();
  try {
    const task = f.tasks.create({ commandId: 'create', title: '请求很多的任务', goal: '核对来源' }).task;
    const pending = f.requests.create(task.taskId, 'clarification', '最早的待处理问题', 'old-request');
    for (let index = 0; index < 110; index++) f.store.humanRequests.save({ ...pending, requestId: `history-${index}`, status: 'answered', decision: 'answer', answer: '已回应' });
    assert.equal(f.requests.pending(task.taskId), true);
    assert.equal(Check(TaskDetailSchema, f.tasks.detail(task.taskId)), true);
    assert.equal(f.tasks.detail(task.taskId).requests?.[0]?.requestId, pending.requestId);
    const first = f.requests.page({ taskId: task.taskId, limit: 100 });
    assert.equal(first.requests.length, 100);
    assert.equal(first.total, 111);
    const second = f.requests.page({ taskId: task.taskId, offset: first.nextOffset! });
    assert.equal(second.requests.length, 11);
    assert.equal(second.nextOffset, null);
    assert.equal(second.requests.at(-1)?.requestId, pending.requestId);
    await assert.rejects(f.execution.control(task.taskId, { commandId: 'bypass', revision: f.tasks.get(task.taskId).revision, action: 'resume' }), /原人工请求/);
    await f.execution.control(task.taskId, { commandId: 'pause', revision: f.tasks.get(task.taskId).revision, action: 'pause' });
    assert.throws(() => f.tasks.remove(task.taskId, { commandId: 'delete', revision: f.tasks.get(task.taskId).revision }), /待处理请求/);
    await f.execution.control(task.taskId, { commandId: 'cancel', revision: f.tasks.get(task.taskId).revision, action: 'cancel' });
    assert.equal(f.requests.get(pending.requestId).status, 'invalidated');
    assert.equal(f.requests.pending(task.taskId), false);
  } finally { await f.close(); }
});

for (const confirmed of [false, true]) test(`恢复保持停止不伪造证明，旧执行停止确认=${confirmed}`, async () => {
  const f = await fixture();
  try {
    const task = f.tasks.create({ commandId: 'create', title: '恢复核对', goal: '保留上下文' }).task;
    const run: TaskRun = { runId: 'legacy-run', taskId: task.taskId, sessionId: 'legacy-session', commandId: 'legacy-command', status: 'recovery', stopIntent: null, stopConfirmed: confirmed, ownerId: 'legacy-owner', directory: { kind: 'task-isolated', path: f.root }, baseline: null, projectId: null, scope: '', goal: task.goal, pendingToolIds: [], toolFailures: 0, nativePendingIds: confirmed ? [] : ['unconfirmed-tool'], piSessionId: null, piEntryId: null, reason: '旧执行恢复未知', createdAt: '', updatedAt: '' };
    f.store.taskRuns.save(run);
    f.tasks.transition(task.taskId, { commandId: 'recover', key: 'recover', kind: 'fixture', summary: '设置重启后的执行事实' }, (current) => ({ ...current, status: 'recovery', currentRunId: run.runId, sessionId: run.sessionId }));
    const request = f.requests.list(task.taskId).find((request) => request.status === 'pending')!;
    if (!confirmed) await assert.rejects(f.requests.decide(request.requestId, { commandId: 'continue', revision: request.revision, decision: 'continue' }), /停止尚不能确认/);
    const decision = { commandId: 'stay-stopped', revision: request.revision, decision: 'stop' as const };
    const receipt = await f.requests.decide(request.requestId, decision);
    assert.equal(receipt.status, 'answered');
    assert.deepEqual(await f.requests.decide(request.requestId, decision), receipt);
    assert.equal(f.tasks.get(task.taskId).status, confirmed ? 'paused' : 'recovery');
    assert.equal(f.store.taskRuns.get(run.runId)?.stopConfirmed, confirmed);
    assert.equal(f.tasks.detail(task.taskId).runs?.length, 1);
    assert.equal(f.sends(), 0);
    if (!confirmed) {
      assert.equal(f.store.taskRuns.get(run.runId)?.stopIntent, 'pause');
      await assert.rejects(f.execution.control(task.taskId, { commandId: 'unsafe-resume', revision: f.tasks.get(task.taskId).revision, action: 'resume' }), /未确认停止/);
      assert.throws(() => f.tasks.remove(task.taskId, { commandId: 'unsafe-delete', revision: f.tasks.get(task.taskId).revision }));
    }
  } finally { await f.close(); }
});
