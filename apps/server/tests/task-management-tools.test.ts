import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GLOBAL_ASSISTANT_SESSION_ID, UNKNOWN_CHANGE_ORIGIN, type TaskProposalPayload } from '@multivac/contracts';
import { InternalToolService, MULTIVAC_INTERNAL_TOOLS, type InternalToolServices } from '../src/application/internal-tools/index.js';
import { TaskService } from '../src/application/task-service.js';
import { createTaskKind } from '../src/application/proposals/task-proposals.js';
import { SqliteAssistantStore, SqliteInternalToolCallRepository } from '../src/storage/sqlite-assistant-store.js';

test('任务创建提议只读预览，项目目录变化使预览过期，确认命令重放不重复创建', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-proposal-'));
  const store = new SqliteAssistantStore(join(root, 'db.sqlite'));
  let project = { name: '研究', directories: [{ path: '/research' }], defaultConstraints: '仅文本' };
  store.createProject({ projectId: 'project', ...project, directories: [{ kind: 'mounted', path: '/research' }], createdAt: new Date().toISOString() });
  const tasks = new TaskService({ repository: store.tasks, requireProject: () => project, describeProject: () => project });
  const kind = createTaskKind(tasks);
  const payload = { title: '调研', goal: '比较资料', projectId: 'project' };
  try {
    const draft = await kind.prepare(payload);
    assert.equal(tasks.list().total, 0);
    assert.equal(await kind.revalidate(payload, draft.preview, undefined), null);
    project = { ...project, directories: [{ path: '/new-directory' }] };
    assert.match((await kind.revalidate(payload, draft.preview, undefined))!, /已变化/);
    const current = await kind.prepare(payload);
    const origin = { ...UNKNOWN_CHANGE_ORIGIN, commandId: 'user-confirm-proposal' };
    await kind.execute(payload, current.preview, origin, undefined);
    await kind.execute(payload, current.preview, origin, undefined);
    assert.equal(tasks.list().total, 1);
    assert.equal(tasks.list().tasks[0]?.status, 'idle');
    assert.equal(store.taskRuns.active().length, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('同一轮直接创建整组任务与父子依赖，无确认卡、不启动，重放不重复创建', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-tools-'));
  const store = new SqliteAssistantStore(join(root, 'db.sqlite'));
  const tasks = new TaskService({ repository: store.tasks, requireProject: () => undefined });
  const service = new InternalToolService({
    tools: MULTIVAC_INTERNAL_TOOLS,
    // 本用例仅调用任务管理工具，不接入提议服务，确保创建不依赖确认卡。
    services: { taskManagement: tasks } as InternalToolServices,
    calls: new SqliteInternalToolCallRepository(store),
    currentTurn: () => ({ commandId: 'create-plan', windowId: 'window' }),
  });
  const invoke = (toolName: string, toolCallId: string, args: unknown) => service.invoke({
    assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, toolName, toolCallId, args,
  }, new AbortController().signal);
  const create = async (toolCallId: string, params: TaskProposalPayload) => {
    const result = await invoke('create_task', toolCallId, params);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error(result.reason);
    const ref = result.result.refs[0];
    assert.equal(ref?.kind, 'task');
    if (ref?.kind !== 'task') throw new Error('缺少真实任务引用');
    assert.match(result.content, /revision 1，状态 idle，尚未启动/);
    assert.ok(result.content.includes(ref.taskId));
    return tasks.get(ref.taskId);
  };
  try {
    const parent = await create('parent', { title: '上线报告系统', goal: '交付完整报告流程' });
    const first = await create('first', { title: '整理数据', goal: '准备输入数据', parentTaskId: parent.taskId });
    const parallel = await create('parallel', { title: '设计模板', goal: '完成报告模板', parentTaskId: parent.taskId });
    const finalInput = { title: '生成报告', goal: '合并数据与模板', parentTaskId: parent.taskId, dependencyIds: [first.taskId, parallel.taskId] };
    const final = await create('final', finalInput);
    assert.equal((await create('final', finalInput)).taskId, final.taskId);
    assert.equal(tasks.list().total, 4);
    assert.equal(tasks.relations(parent.taskId).summary.children.total, 3);
    assert.deepEqual(new Set(tasks.get(final.taskId).dependencyIds), new Set([first.taskId, parallel.taskId]));
    assert.deepEqual(tasks.get(parallel.taskId).dependencyIds, []);
    assert.ok(tasks.list().tasks.every((task) => task.status === 'idle' && task.currentRunId === null && task.sessionId === null));
    assert.equal(store.taskRuns.active().length, 0);

    const invalid = await invoke('create_task', 'missing-parent', { title: '无效关系', goal: '验证', parentTaskId: 'missing' });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.match(invalid.reason, /任务不存在或已删除/);
    const crossProject = await invoke('create_task', 'cross-project', { title: '跨项目', goal: '验证', projectId: 'other', parentTaskId: parent.taskId });
    assert.equal(crossProject.ok, false);
    if (!crossProject.ok) assert.match(crossProject.reason, /不能跨项目/);
    const cycle = await invoke('update_task', 'cycle', { taskId: first.taskId, revision: first.revision, patch: { dependencyIds: [final.taskId] } });
    assert.equal(cycle.ok, false);
    assert.deepEqual(tasks.get(first.taskId).dependencyIds, []);
    const budget = await invoke('create_task', 'budget', { title: '调整预算', goal: '验证', budget: { maxRuns: 100, maxMillis: 86400000, maxOutputBytes: 67108864 } });
    assert.equal(budget.ok, false);
    assert.equal(tasks.list().total, 4);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
