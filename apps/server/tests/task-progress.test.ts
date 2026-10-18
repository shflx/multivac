import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { UNKNOWN_CHANGE_ORIGIN, type Task, type TaskRun } from '@multivac/contracts';
import { TaskService } from '../src/application/task-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { SqliteTaskRepository, TASK_MIGRATION } from '../src/storage/sqlite-task-repository.js';
import { SqliteTaskRunRepository, TASK_RUN_MIGRATION } from '../src/storage/sqlite-task-run-repository.js';
import { SqliteHumanRequestRepository, HUMAN_REQUEST_MIGRATION } from '../src/storage/sqlite-human-request-repository.js';
import { SqliteArtifactRepository, ARTIFACT_MIGRATION } from '../src/storage/sqlite-artifact-repository.js';
import { SqliteTaskRuntimeRepository } from '../src/storage/sqlite-task-runtime-repository.js';
import { SqliteInboxRepository, INBOX_MIGRATION } from '../src/storage/sqlite-inbox-repository.js';
import { SqliteTaskFacts } from '../src/storage/sqlite-task-facts.js';

function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON; CREATE TABLE project(project_id TEXT PRIMARY KEY);');
  database.exec(TASK_MIGRATION + TASK_RUN_MIGRATION + HUMAN_REQUEST_MIGRATION + ARTIFACT_MIGRATION + INBOX_MIGRATION);
  const repository = new SqliteTaskRepository(database);
  const events = new WorkbenchEvents(); let count = 0; let commands = 0;
  const facts = new SqliteTaskFacts(database, {
    tasks: repository, runs: new SqliteTaskRunRepository(database), requests: new SqliteHumanRequestRepository(database),
    artifacts: new SqliteArtifactRepository(database), runtime: new SqliteTaskRuntimeRepository(database), externalOperations: new SqliteInboxRepository(database),
  });
  const tasks = new TaskService({ afterCommit: () => {}, facts, events, requireProject: () => {}, newId: () => `task-${++count}` });
  const create = (title: string, parentTaskId: string | null = null) => tasks.create({ commandId: `create-${++commands}`, title, goal: title, parentTaskId }).task;
  const transition = (task: Task, status: Task['status'], extra: Partial<Task> = {}) => tasks.transition(task.taskId,
    { commandId: `${task.taskId}-${status}-${task.revision}`, key: `${task.taskId}-${status}-${task.revision}`, kind: 'progress', summary: '更新真实状态' },
    (current) => ({ ...current, ...extra, status })).task;
  return { database, repository, tasks, events, create, transition };
}

test('状态事件发布时完整统计已提交，审核中与取消单列且不受子列表分页影响', () => {
  const f = fixture();
  try {
    const parent = f.create('父任务');
    const children = Array.from({ length: 110 }, (_, index) => f.create(`子任务-${index}`, parent.taskId));
    let published = 0;
    f.events.subscribe((event) => {
      if (event.type !== 'task.changed') return;
      published++;
      const facts = f.tasks.relations(parent.taskId).summary.children;
      assert.equal(facts.total, 110);
      assert.equal(facts.done, f.tasks.list({ parentTaskId: parent.taskId, status: 'done', limit: 1 }).total);
    });
    for (const [index, child] of children.entries()) f.transition(child, index < 80 ? 'done' : index < 95 ? 'review' : index < 105 ? 'cancelled' : 'paused');
    assert.equal(published, 110);
    assert.deepEqual(f.tasks.relations(parent.taskId).summary.children, { total: 110, done: 80, cancelled: 10 });
    assert.equal(f.tasks.detail(parent.taskId).children.length, 100);
    assert.equal(f.tasks.detail(parent.taskId).totalChildren, 110);
    const page = f.tasks.list({ ids: [parent.taskId], includeRelations: true, limit: 1 });
    assert.deepEqual(page.relations![parent.taskId]!.children, { total: 110, done: 80, cancelled: 10 });
    assert.equal(f.tasks.get(parent.taskId).revision, 1);
    f.transition(children[0]!, 'done');
    assert.equal(published, 110, '重放同一命令不重复发布事件');
  } finally { f.database.close(); }
});

test('新增、改父和删除发布的事件可核对新旧父统计，孙任务不计入直属集合', () => {
  const f = fixture();
  try {
    const a = f.create('原父'); const b = f.create('新父');
    const observations: number[][] = [];
    f.events.subscribe((event) => {
      if (event.type === 'task.changed') observations.push([f.tasks.relations(a.taskId).summary.children.total, f.tasks.relations(b.taskId).summary.children.total]);
    });
    const child = f.create('子任务', a.taskId);
    const grandchild = f.create('孙任务', child.taskId);
    f.tasks.remove(grandchild.taskId, { commandId: 'delete-grandchild', revision: 1 });
    const moved = f.tasks.update(child.taskId, { commandId: 'move', revision: 1, patch: { parentTaskId: b.taskId } }).task;
    assert.deepEqual(f.tasks.relations(a.taskId).summary.children, { total: 0, done: 0, cancelled: 0 });
    assert.deepEqual(f.tasks.relations(b.taskId).summary.children, { total: 1, done: 0, cancelled: 0 });
    f.tasks.remove(moved.taskId, { commandId: 'delete-child', revision: moved.revision });
    assert.deepEqual(observations, [[1, 0], [1, 0], [1, 0], [0, 1], [0, 0]]);
  } finally { f.database.close(); }
});

test('父运行统一执行子任务时每次发布到所有窗口，候选和审核中均不计完成', () => {
  const f = fixture();
  try {
    const root = f.create('整体'); const child = f.create('子项', root.taskId);
    const run: TaskRun = { runId: 'run', taskId: root.taskId, sessionId: 'session', commandId: 'start', treeTasks: [child], status: 'running', stopIntent: null,
      stopConfirmed: false, ownerId: 'owner', directory: null, baseline: null, projectId: null, scope: '', goal: '', pendingToolIds: [], toolFailures: 0,
      piSessionId: null, piEntryId: null, reason: '', createdAt: '', updatedAt: '' };
    const windows: number[][] = [[], []];
    for (const [index, counts] of windows.entries()) f.events.subscribe((event) => {
      if (event.type === 'task.changed') counts.push(f.tasks.relations(root.taskId).summary.children.done);
    }, `window-${index}`);
    const bound = f.tasks.facts(() => f.tasks.bindExecutionChildren(run));
    f.tasks.publishExecutionChildren(bound, UNKNOWN_CHANGE_ORIGIN);
    let current = f.transition(bound[0]!, 'waiting', { executionProgress: 'processing' });
    current = f.transition(current, 'waiting', { executionProgress: 'ready' });
    current = f.transition(current, 'review');
    f.transition(current, 'done');
    assert.deepEqual(windows, [[0, 0, 0, 0, 1], [0, 0, 0, 0, 1]]);
    assert.equal(f.tasks.get(root.taskId).revision, 1);
  } finally { f.database.close(); }
});
