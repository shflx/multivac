import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Check } from 'typebox/value';
import { AssistantToolResultSchema, GLOBAL_ASSISTANT_SESSION_ID, parseMultivacObjectLink } from '@multivac/contracts';
import { TaskService, TaskServiceError } from '../src/application/task-service.js';
import { InternalToolService, type InternalToolServices } from '../src/application/internal-tools/internal-tool-service.js';
import { listTasksTool, getTaskTool } from '../src/application/internal-tools/task-query-tools.js';
import { SqliteAssistantStore, SqliteInternalToolCallRepository } from '../src/storage/sqlite-assistant-store.js';

test('任务查询工具读取真实存储并返回稳定对象、分页和空记录，不产生修改或执行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-query-'));
  const store = new SqliteAssistantStore(join(root, 'db.sqlite'));
  const tasks = new TaskService({ repository: store.tasks, runs: store.taskRuns, requireProject: () => { throw new TaskServiceError('NOT_FOUND', '项目不存在。'); } });
  const calls = new SqliteInternalToolCallRepository(store);
  const tools = new InternalToolService({ tools: [listTasksTool, getTaskTool], services: { tasks } as InternalToolServices, calls, currentTurn: () => null });
  const invoke = (toolName: string, args: unknown, toolCallId = toolName) => tools.invoke({ assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, toolName, args, toolCallId }, new AbortController().signal);
  try {
    const first = tasks.create({ commandId: 'one', title: '来源核对', goal: '比较两个来源' }).task;
    tasks.create({ commandId: 'two', title: '汇总', goal: '整理结果', dependencyIds: [first.taskId] });
    const listing = await invoke('list_tasks', { projectId: 'daily', limit: 1 });
    assert.equal(listing.ok, true);
    if (!listing.ok) return;
    assert.equal(Check(AssistantToolResultSchema, listing.result), true);
    assert.match(listing.content, /共 2 项，当前 1 项；下一页 offset：1/);
    assert.deepEqual(listing.result.refs[0], { kind: 'task', taskId: first.taskId, label: first.title });
    assert.deepEqual(parseMultivacObjectLink(`multivac://task/${first.taskId}`), { kind: 'task', id: first.taskId });
    const detail = await invoke('get_task', { taskId: first.taskId });
    assert.equal(detail.ok, true);
    if (!detail.ok) return;
    assert.match(detail.content, /比较两个来源/);
    assert.match(detail.content, /尚无执行记录/);
    assert.equal(tasks.get(first.taskId).revision, 1);
    assert.equal(tasks.get(first.taskId).status, 'idle');
    assert.equal(store.taskRuns.active().length, 0);
    assert.equal(calls.get('get_task'), undefined);
    const empty = await invoke('list_tasks', { query: '不存在的目标' }, 'empty');
    assert.equal(empty.ok, true);
    if (empty.ok) assert.match(empty.content, /暂无符合条件/);
    const missing = await invoke('get_task', { taskId: 'missing' }, 'missing');
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.reason, /任务不存在/);
    assert.equal((await invoke('list_tasks', { status: 'imaginary' }, 'invalid')).ok, false);
    assert.equal((await invoke('list_tasks', { projectId: 'missing' }, 'project')).ok, false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
