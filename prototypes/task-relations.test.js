import test from 'node:test';
import assert from 'node:assert/strict';
import { relationError, relationEditReason, unmetDependencies, taskTreeRows } from './task-relations.js';
import { createTaskFromDraft, filterPanelTasks, presentTask, taskDropAction } from './task-panel-state.js';

const tasks = [
  { id: 'parent', projectId: 'p', status: 'idle' },
  { id: 'child', projectId: 'p', status: 'idle', parentTaskId: 'parent', dependencyIds: ['review'] },
  { id: 'review', projectId: 'p', status: 'review' },
  { id: 'done', projectId: 'p', status: 'done' },
  { id: 'other', projectId: 'q', status: 'done' },
];

test('父子循环、依赖循环、自引用、跨项目和失效关系均拒绝', () => {
  assert.match(relationError(tasks[0], { parentTaskId: 'child' }, tasks), /循环/);
  assert.match(relationError(tasks[2], { dependencyIds: ['child'] }, tasks), /循环/);
  assert.match(relationError(tasks[0], { dependencyIds: ['parent'] }, tasks), /自身/);
  assert.match(relationError(tasks[0], { dependencyIds: ['other'] }, tasks), /项目/);
  assert.match(relationError(tasks[0], { parentTaskId: 'missing' }, tasks), /失效/);
  assert.equal(relationError(tasks[0], { dependencyIds: ['review', 'done'] }, tasks), '');
});

test('审核中和已完成满足执行依赖，取消和失效任务不满足', () => {
  assert.deepEqual(unmetDependencies({ dependencyIds: ['review', 'done', 'parent', 'missing'] }, tasks), ['parent', 'missing']);
  assert.deepEqual(unmetDependencies({ dependencyIds: ['cancelled'] }, [{ id: 'cancelled', status: 'cancelled' }]), ['cancelled']);
  assert.deepEqual(unmetDependencies({ parentTaskId: 'parent' }, tasks), []);
});

test('创建人工任务不启动，保留显式父子和依赖选择', () => {
  const task = createTaskFromDraft({ title: '确认', goal: '确认资料', projectId: 'p', humanOnly: true, parentTaskId: 'parent', dependencyIds: ['review'] }, [{ id: 'p' }], { tasks });
  assert.equal(task.humanOnly, true);
  assert.equal(task.status, 'idle');
  assert.equal(task.parentTaskId, 'parent');
  assert.deepEqual(task.dependencyIds, ['review']);
  assert.equal(taskDropAction(task, [], 'running').kind, 'blocked');
  assert.deepEqual(filterPanelTasks([task], [], { handling: 'agent' }), []);
  assert.deepEqual(filterPanelTasks([task], [], { handling: 'human' }), [task]);
});

test('排队中仍归未开始列，但显示实际状态且不能重复启动', () => {
  const queued = { id: 'queued', status: 'queued' };
  assert.equal(presentTask(queued, []).column, 'idle');
  assert.equal(presentTask(queued, []).label, '排队中');
  assert.equal(taskDropAction(queued, [], 'running').kind, 'blocked');
});

test('执行中、终态、带请求的任务不能修改关系', () => {
  assert.ok(relationEditReason({ id: 'a', status: 'running' }));
  assert.ok(relationEditReason({ id: 'a', status: 'done' }));
  assert.ok(relationEditReason({ id: 'a', status: 'paused' }, [{ taskId: 'a', state: 'new' }]));
  assert.equal(relationEditReason({ id: 'a', status: 'paused' }), '');
});

test('关系树展开包含筛选外子任务，折叠时命中筛选的子任务不消失', () => {
  assert.deepEqual(taskTreeRows([tasks[0]], tasks, new Set(['parent'])).map(({ task, depth }) => [task.id, depth]), [['parent', 0], ['child', 1]]);
  assert.deepEqual(taskTreeRows(tasks.slice(0, 2), tasks, new Set()).map(({ task, depth }) => [task.id, depth]), [['parent', 0], ['child', 0]]);
  assert.deepEqual(taskTreeRows([tasks[1]], tasks, new Set()).map(({ task, depth }) => [task.id, depth]), [['child', 0]]);
});

test('旧数据中的父子循环不导致栈溢出或整组任务丢失', () => {
  const broken = [{ id: 'a', parentTaskId: 'b' }, { id: 'b', parentTaskId: 'a' }];
  assert.equal(taskTreeRows(broken, broken, new Set(['a', 'b'])).length, 2);
});
