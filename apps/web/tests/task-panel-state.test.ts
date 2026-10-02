import assert from 'node:assert/strict';
import test from 'node:test';
import type { Task } from '@multivac/contracts';
import { splitCompleted, taskColumn, matchesTask, taskDropAction, reorderTasks } from '../src/features/tasks/task-panel-state.js';
const task = (id: string, status: Task['status'], completedAt: string | null = null): Task => ({ taskId: id, title: id, goal: '目标', scope: '', projectId: null, groupId: null, parentTaskId: null, dependencyIds: [], priority: 'medium', acceptance: true, acceptanceCriteria: '', revision: 1, status, sessionId: null, currentRunId: null, reason: '真实原因', nextStep: '下一步', createdAt: '', updatedAt: '', completedAt });
test('任务状态投影不掩盖执行失败，暂停可筛选，完成历史只保留近七天五项', () => {
  assert.equal(taskColumn(task('failed', 'failed')), 'waiting');
  assert.equal(taskColumn(task('recover', 'recovery')), 'waiting');
  assert.equal(taskColumn(task('queue', 'queued')), 'idle');
  assert.equal(matchesTask(task('paused', 'paused'), '', 'all', 'paused', []), true);
  const now = Date.UTC(2026, 9, 2);
  const completed = Array.from({ length: 8 }, (_, i) => task(String(i), 'done', new Date(now - i * 3600000).toISOString()));
  completed.push(task('old', 'done', new Date(now - 8 * 86400000).toISOString()));
  const split = splitCompleted(completed, now);
  assert.equal(split.recent.length, 5); assert.equal(split.older.length, 4);
});
test('拖动映射业务动作，完成不能改标签绕过，排序不修改优先级', () => {
  const idle = task('a', 'idle');
  assert.equal(taskDropAction(idle, [], 'running').kind, 'start');
  assert.equal(taskDropAction(idle, [], 'done').kind, 'blocked');
  assert.equal(taskDropAction(task('a', 'paused'), [], 'running').kind, 'resume');
  assert.equal(taskDropAction(task('a', 'recovery'), [], 'running').kind, 'blocked');
  assert.deepEqual(reorderTasks(['gone', 'b', 'a'], ['a', 'b', 'c'], 'c', 'b'), ['c', 'b', 'a']);
  assert.equal(idle.priority, 'medium');
});
