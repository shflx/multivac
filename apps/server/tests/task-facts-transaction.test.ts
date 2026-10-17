import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { HumanRequest } from '@multivac/contracts';
import { TaskService, type TaskChange } from '../src/application/task-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

function request(taskId: string): HumanRequest {
  const at = new Date().toISOString();
  return {
    requestId: 'request-1', taskId, runId: null, sessionId: null, kind: 'clarification', revision: 1, status: 'pending',
    question: '需要采用哪个来源？', artifactVersionId: null, authorizationRequestId: null,
    decision: null, answer: '', reason: '', createdAt: at, updatedAt: at,
  };
}

test('任务转换中后续写入失败时，人工请求、任务、回执与事件均不部分提交；同命令重试得到一致结果', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-facts-'));
  const path = join(root, 'store.sqlite');
  const store = new SqliteAssistantStore(path);
  // 另开连接安装故障触发器：任务行更新被拒绝，模拟同一事务中第二次写入失败。
  const injector = new DatabaseSync(path);
  const events = new WorkbenchEvents();
  const published: string[] = [];
  events.subscribe((event) => { published.push(event.type); });
  const tasks = new TaskService({ facts: store.taskFacts, requireProject: () => {}, events });
  try {
    const task = tasks.create({ commandId: 'create', title: '请求核对', goal: '核对来源' }).task;
    published.length = 0;
    const ask = { commandId: 'ask', key: 'ask-key', kind: 'request', summary: '需要采用哪个来源？' };
    const change: TaskChange = (current, facts) => {
      facts.requests.save(request(current.taskId));
      return { ...current, status: 'waiting', pauseSource: 'human', reason: '需要采用哪个来源？' };
    };

    injector.exec(`CREATE TRIGGER fail_task_update BEFORE UPDATE ON task BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
    assert.throws(() => tasks.transition(task.taskId, ask, change), /injected/);
    assert.equal(store.humanRequests.get('request-1'), null);
    assert.equal(tasks.get(task.taskId).revision, task.revision);
    assert.equal(tasks.commandRecorded('ask'), false);
    assert.deepEqual(store.tasks.events(task.taskId).map((event) => event.commandId), ['create']);
    assert.deepEqual(published, []);

    injector.exec('DROP TRIGGER fail_task_update');
    const first = tasks.transition(task.taskId, ask, change);
    assert.equal(first.task.status, 'waiting');
    assert.equal(store.humanRequests.get('request-1')?.taskId, task.taskId);
    assert.deepEqual(published, ['task.changed']);

    const replay = tasks.transition(task.taskId, ask, () => { throw new Error('重放不应重新执行转换。'); });
    assert.deepEqual(replay.task, first.task);
    assert.throws(() => tasks.transition(task.taskId, { ...ask, key: 'other' }, change), /同一个命令 ID/);
  } finally {
    injector.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('人工门禁只读持久事实：未接线其他服务时，外发操作与待处理请求同样阻止删除', async () => {
  const store = new SqliteAssistantStore(':memory:');
  const tasks = new TaskService({ facts: store.taskFacts, requireProject: () => {} });
  try {
    const task = tasks.create({ commandId: 'create', title: '外发核对', goal: '核对发布' }).task;
    const at = new Date().toISOString();
    const publish = {
      id: 'publish-1', sessionId: 'session', taskId: task.taskId, revision: 1, status: 'unknown' as const,
      repository: '/repo', remote: 'origin', target: 'origin/main', ref: 'main', commit: 'abc', summary: '发布', account: '', createdAt: at, updatedAt: at, result: '',
    };
    tasks.facts((facts) => facts.externalOperations.saveOperation(publish));
    assert.equal(tasks.pendingRequest(task.taskId), true);
    assert.throws(() => tasks.remove(task.taskId, { commandId: 'delete', revision: task.revision }), /待处理请求/);

    tasks.facts((facts) => facts.externalOperations.saveOperation({ ...publish, revision: 2, status: 'succeeded' }));
    tasks.facts((facts) => facts.requests.save(request(task.taskId)));
    assert.equal(tasks.pendingRequest(task.taskId), true);
    assert.equal(tasks.pendingRequest(task.taskId, 'request-1'), false);
    assert.throws(() => tasks.remove(task.taskId, { commandId: 'delete', revision: task.revision }), /待处理请求/);
  } finally {
    store.close();
  }
});
