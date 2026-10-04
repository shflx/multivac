import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GLOBAL_ASSISTANT_SESSION_ID } from '@multivac/contracts';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { InternalToolService, MULTIVAC_INTERNAL_TOOLS, WORK_SESSION_TASK_TOOLS, type InternalToolServices } from '../src/application/internal-tools/index.js';
import { SqliteAssistantStore, SqliteInternalToolCallRepository } from '../src/storage/sqlite-assistant-store.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

test('默认 Agent，不按会议标题推断；个人标记阻止启动和自报完成，用户完成满足依赖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'human-only-'));
  const app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: new FakeCoordinatorAdapter() });
  try {
    await app.ready;
    const normal = app.tasks.create({ commandId: 'normal', title: '开会', goal: '整理会议议程' }).task;
    assert.equal(normal.humanOnly, false);
    assert.equal(app.tasks.create({ commandId: 'normal', title: '开会', goal: '整理会议议程', humanOnly: false }).task.taskId, normal.taskId);
    app.tasks.transition(normal.taskId, { commandId: 'legacy', key: 'legacy', kind: 'test', summary: '核对旧数据缺省标记' }, (task) => { const { humanOnly, ...legacy } = task; return legacy; });
    assert.equal(app.tasks.get(normal.taskId).humanOnly, undefined);
    const personal = app.tasks.create({ commandId: 'personal', title: '参加评审', goal: '参加评审', humanOnly: true }).task;
    assert.equal(app.tasks.list({ humanOnly: false }).total, 1);
    assert.equal(app.tasks.list({ humanOnly: true }).total, 1);
    await assert.rejects(app.taskExecution.control(personal.taskId, { commandId: 'start', revision: 1, action: 'start' }), /不能由 Agent/);
    assert.throws(() => app.humanRequests.completeSession(personal.taskId, { commandId: 'fake-complete', revision: 1, summary: '已完成' }, 'work'), /用户确认/);
    assert.equal(app.tasks.detail(personal.taskId).runs?.length, 0);
    const after = app.tasks.create({ commandId: 'after', title: '会后整理', goal: '根据会议结论整理', dependencyIds: [personal.taskId], humanOnly: true }).task;
    assert.throws(() => app.tasks.confirmHumanCompletion(after.taskId, { commandId: 'blocked', revision: 1 }), /前置任务/);
    const input = { commandId: 'confirmed', revision: 1 };
    const result = app.tasks.confirmHumanCompletion(personal.taskId, input);
    assert.equal(result.task.status, 'done');
    assert.deepEqual(app.tasks.confirmHumanCompletion(personal.taskId, input), result);
    assert.equal(app.humanRequests.list(personal.taskId).length, 0);
    assert.equal(app.tasks.relations(after.taskId).summary.dependencies.done, 1);
    assert.throws(() => app.tasks.confirmHumanCompletion(normal.taskId, { commandId: 'wrong-type', revision: app.tasks.get(normal.taskId).revision }), /只能确认/);
    assert.throws(() => app.tasks.update(personal.taskId, { commandId: 'terminal', revision: result.task.revision, patch: { humanOnly: false } }), /历史/);
  } finally { await app.taskExecution.idle(); app.close(); await rm(root, { recursive: true, force: true }); }
});

test('对话工具缺少用户明确表达时不能添加移除个人标记或代为完成', async () => {
  const root = await mkdtemp(join(tmpdir(), 'human-only-tools-'));
  const app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: new FakeCoordinatorAdapter() });
  const ledger = new SqliteAssistantStore(join(root, 'ledger.sqlite'));
  try {
    await app.ready;
    const tools = new InternalToolService({ tools: [...MULTIVAC_INTERNAL_TOOLS, ...WORK_SESSION_TASK_TOOLS.filter((tool) => !MULTIVAC_INTERNAL_TOOLS.some((item) => item.name === tool.name))], services: { taskManagement: app.tasks, humanTaskCompletion: app.tasks, taskCompletion: app.humanRequests } as InternalToolServices, calls: new SqliteInternalToolCallRepository(ledger), currentTurn: () => null });
    let index = 0;
    const invoke = (toolName: string, args: unknown) => tools.invoke({ assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, toolCallId: `call-${index++}`, toolName, args }, new AbortController().signal);
    assert.equal((await invoke('create_task', { title: '参加会议', goal: '参加会议', humanOnly: true })).ok, false);
    assert.equal(app.tasks.list().total, 0);
    const created = await invoke('create_task', { title: '参加会议', goal: '参加会议', humanOnly: true, userConfirmation: '这场会议我自己参加，帮我记一下' });
    assert.equal(created.ok, true, JSON.stringify(created));
    const task = app.tasks.list().tasks[0]!;
    assert.equal((await invoke('update_task', { taskId: task.taskId, revision: 1, patch: { humanOnly: false } })).ok, false);
    assert.equal((await invoke('confirm_human_task', { taskId: task.taskId, revision: 1 })).ok, false);
    assert.equal((await invoke('complete_task', { taskId: task.taskId, revision: 1, summary: '我判断会议已结束' })).ok, false);
    assert.equal((await invoke('confirm_human_task', { taskId: task.taskId, revision: 1, userConfirmation: '这场会议已经开完了' })).ok, true);
    assert.equal(app.tasks.get(task.taskId).status, 'done');
  } finally { app.close(); ledger.close(); await rm(root, { recursive: true, force: true }); }
});
