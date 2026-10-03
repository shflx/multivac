import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskFromDraft, presentTask, filterPanelTasks, splitCompleted, visibleSelectedId, taskAfterDecision, taskWithEvent, taskDropAction, orderTasks, reorderTasks } from './task-panel-state.js';
import { canSubmitDecision, decisionLabel } from './ui-state.js';

const tasks = [
  { id: 'running', title: '构建原型', projectId: 'multivac', status: 'running', reason: '正在核对', next: '生成说明' },
  { id: 'grant', title: '推送修复', projectId: 'multivac', status: 'running', reason: '需要推送授权' },
  { id: 'paused', title: '更新文档', projectId: 'multivac', status: 'paused' },
  { id: 'failed', title: '构建失败', projectId: 'multivac', status: 'failed', reason: '缺少配置' },
  { id: 'recover', title: '恢复修改', projectId: 'multivac', status: 'recovery', reason: '旧命令状态不明' },
  { id: 'done', title: '报告完成', projectId: 'research', status: 'done' },
];
const requests = [{ id: 'grant-request', taskId: 'grant', type: '工具授权', state: 'new' }, { id: 'recover-request', taskId: 'recover', type: '恢复确认', state: 'new' }];

test('手动创建登记为未开始，并可通过现有启动动作推进', () => {
  const task = createTaskFromDraft({ title: '  整理项目进展  ', goal: '汇总本周变更' }, [], { id: 'created', at: '2026-10-01T08:00:00Z' });
  assert.equal(task.title, '整理项目进展');
  assert.equal(task.projectId, null);
  assert.equal(task.acceptance, true);
  assert.equal(presentTask(task, []).column, 'idle');
  assert.deepEqual(filterPanelTasks([task], [], { project: 'daily', status: 'idle' }), [task]);
  assert.equal(taskDropAction(task, [], 'running').kind, 'start');
  assert.equal(task.events[0].at, '2026-10-01T08:00:00Z');
  assert.ok(!task.completedAt);
});

test('手动创建保留项目、目标、范围、优先级与验收选择', () => {
  const draft = { title: '周报', goal: '  汇总本周变更  ', scope: '  项目文档  ', projectId: 'multivac', priority: '高', acceptance: false };
  const task = createTaskFromDraft(draft, [{ id: 'multivac' }]);
  assert.equal(task.goal, '汇总本周变更');
  assert.equal(task.scope, '项目文档');
  assert.equal(task.priority, '高');
  assert.equal(task.acceptance, false);
  assert.deepEqual(filterPanelTasks([task], [], { project: 'multivac' }), [task]);
  assert.equal(draft.goal, '  汇总本周变更  ');
});

test('空名称、空目标、失效项目和无效优先级不能创建任务', () => {
  assert.throws(() => createTaskFromDraft({ title: '  ', goal: '汇总本周变更' }, []), /任务名称/);
  for (const goal of [undefined, '', '  ']) {
    assert.throws(() => createTaskFromDraft({ title: '周报', goal }, []), /目标说明/);
  }
  assert.throws(() => createTaskFromDraft({ title: '周报', goal: '汇总本周变更', projectId: 'removed' }, []), /项目已不可用/);
  assert.throws(() => createTaskFromDraft({ title: '周报', goal: '汇总本周变更', priority: '紧急' }, []), /有效的优先级/);
  const first = createTaskFromDraft({ title: '周报', goal: '汇总本周变更' }, []);
  const second = createTaskFromDraft({ title: '周报', goal: '汇总本周变更' }, []);
  assert.notEqual(first.id, second.id);
});

test('不选择项目也可创建任务，并归入日常筛选', () => {
  for (const projectId of [undefined, null, '']) {
    const task = createTaskFromDraft({ title: '周报', goal: '汇总本周变更', projectId }, [{ id: 'multivac' }]);
    assert.equal(task.projectId, null);
    assert.deepEqual(filterPanelTasks([task], [], { project: 'daily' }), [task]);
    assert.deepEqual(filterPanelTasks([task], [], { project: 'multivac' }), []);
  }
});

test('同一批任务按请求、暂停和异常语义派生状态', () => {
  assert.equal(presentTask(tasks[0], requests).column, 'running');
  assert.equal(presentTask(tasks[1], requests).column, 'waiting');
  assert.equal(presentTask(tasks[1], requests).waitLabel, '授权');
  assert.equal(presentTask(tasks[2], requests).column, 'paused');
  assert.equal(presentTask(tasks[3], requests).abnormal, true);
  assert.equal(presentTask(tasks[3], requests).label, '执行失败');
  assert.equal(presentTask(tasks[3], requests).column, 'waiting');
  assert.equal(presentTask(tasks[4], requests).column, 'waiting');
  assert.equal(presentTask(tasks[4], requests).abnormal, true);
  const legacyPause = presentTask({ id: 'legacy', status: 'scheduler-paused' }, []);
  assert.equal(legacyPause.column, 'waiting');
  assert.equal(legacyPause.abnormal, true);
});

test('未完成、项目和阻塞筛选不混入其他任务', () => {
  assert.equal(filterPanelTasks(tasks, requests).some((task) => task.id === 'done'), false);
  assert.deepEqual(filterPanelTasks(tasks, requests, { status: 'running' }).map((task) => task.id), ['running']);
  assert.deepEqual(filterPanelTasks(tasks, requests, { status: 'waiting' }).map((task) => task.id), ['grant', 'failed', 'recover']);
  assert.deepEqual(filterPanelTasks(tasks, requests, { status: 'paused' }).map((task) => task.id), ['paused']);
  assert.deepEqual(filterPanelTasks(tasks, requests, { status: 'all', project: 'research' }).map((task) => task.id), ['done']);
});

test('所有执行异常都属于阻塞，执行中只保留正常推进的任务', () => {
  const abnormalTasks = ['failed', 'stalled', 'env-stopped', 'recovery', 'scheduler-paused'].map((status) => ({ id: status, status, reason: `${status} 的具体原因` }));
  for (const task of abnormalTasks) {
    const state = presentTask(task, []);
    assert.equal(state.column, 'waiting');
    assert.equal(state.summary, task.reason);
    assert.equal(state.abnormal, true);
    assert.equal(taskDropAction(task, [], 'waiting').kind, 'reorder');
    assert.equal(taskDropAction(task, [], 'running').kind, 'blocked');
  }
  const all = [...abnormalTasks, tasks[0], tasks[2]];
  assert.deepEqual(filterPanelTasks(all, [], { status: 'waiting' }).map((task) => task.id), abnormalTasks.map((task) => task.id));
  assert.deepEqual(filterPanelTasks(all, [], { status: 'running' }).map((task) => task.id), ['running']);
  assert.deepEqual(filterPanelTasks(all, [], { status: 'paused' }).map((task) => task.id), ['paused']);
});

test('搜索过滤后关闭不可见选择，视图切换可保留可见选择', () => {
  assert.equal(visibleSelectedId('running', filterPanelTasks(tasks, requests)), 'running');
  assert.equal(visibleSelectedId('running', filterPanelTasks(tasks, requests, { query: '配置' })), null);
  assert.equal(visibleSelectedId('grant', filterPanelTasks(tasks, requests, { status: 'running' })), null);
});

test('完成历史默认限最近七天与五项，旧历史仍能找到', () => {
  const now = Date.parse('2026-10-01T06:00:00Z');
  const completed = Array.from({ length: 7 }, (_, index) => ({ id: String(index), status: 'done', completedAt: new Date(now - index * 3600000).toISOString() }));
  completed.push({ id: 'older', status: 'done', completedAt: '2026-09-01T06:00:00Z' });
  const result = splitCompleted(completed, now);
  assert.equal(result.recent.length, 5);
  assert.deepEqual(result.older.map((task) => task.id), ['5', '6', 'older']);
});

test('澄清、授权和验收修改处理后直接执行，验收通过完成', () => {
  for (const [type, action] of [['澄清', 'allow'], ['澄清', 'deny'], ['工具授权', 'once'], ['工具授权', 'deny'], ['验收', 'revise']]) {
    assert.equal(taskAfterDecision({ type, capability: 'GitHub' }, action, '修正文案').status, 'running');
  }
  assert.equal(taskAfterDecision({ type: '验收' }, 'accept').status, 'done');
  assert.equal(taskAfterDecision({ type: '外发授权' }, 'deny').status, 'done');
});

test('恢复决定在 Inbox 和会话中使用同一校验与结果', () => {
  for (const action of ['resume', 'restart', 'stop']) {
    assert.equal(canSubmitDecision('恢复确认', action), true);
    assert.ok(decisionLabel('恢复确认', action));
  }
  assert.equal(canSubmitDecision('恢复确认', 'allow'), false);
  assert.equal(taskAfterDecision({ type: '恢复确认' }, 'resume').status, 'running');
  assert.equal(taskAfterDecision({ type: '恢复确认' }, 'stop').status, 'env-stopped');
});

test('进展记录只追加实际动作描述与时间，不把下一步当事件', () => {
  const previous = { id: 'one', status: 'running', events: [] };
  const next = taskWithEvent(previous, { status: 'paused', reason: '你已暂停', next: '等待继续' }, undefined, '2026-10-01T06:00:00Z');
  assert.deepEqual(next.events, [{ title: '你已暂停', at: '2026-10-01T06:00:00Z' }]);
  assert.equal(previous.events.length, 0);
  const done = taskWithEvent(next, { status: 'done', reason: '成果已验收' }, undefined, '2026-10-01T06:10:00Z');
  assert.equal(done.completedAt, '2026-10-01T06:10:00Z');
});

test('跨列拖动使用启动、暂停、继续动作，不伪造完成或请求', () => {
  assert.equal(taskDropAction({ id: 'idle', status: 'idle' }, [], 'running').kind, 'start');
  assert.equal(taskDropAction(tasks[0], [], 'paused').kind, 'pause');
  assert.equal(taskDropAction(tasks[2], [], 'running').kind, 'start');
  assert.equal(taskDropAction(tasks[0], [], 'done').kind, 'blocked');
  assert.equal(taskDropAction(tasks[0], [], 'waiting').kind, 'blocked');
  assert.equal(taskDropAction(tasks[5], [], 'running').kind, 'blocked');
  assert.equal(taskDropAction(tasks[3], [], 'paused').kind, 'blocked');
});

test('等待任务拖到执行或完成列只打开原请求，不直接改变状态', () => {
  assert.equal(taskDropAction(tasks[1], requests, 'running').kind, 'request');
  assert.equal(taskDropAction(tasks[4], requests, 'running').kind, 'request');
  assert.equal(taskDropAction(tasks[1], requests, 'done').kind, 'blocked');
  const review = { id: 'review', status: 'acceptance' };
  const approval = [{ id: 'review-request', taskId: 'review', type: '验收', state: 'new' }];
  assert.equal(taskDropAction(review, approval, 'done').kind, 'request');
  assert.equal(taskDropAction(review, approval, 'running').kind, 'blocked');
  assert.equal(review.status, 'acceptance');
});

test('列内排序去重并保留其他任务，列表共享同一顺序', () => {
  const members = ['a', 'b', 'c', 'd'];
  const ordered = reorderTasks([], members, 'c', 'a');
  assert.deepEqual(ordered, ['c', 'a', 'b', 'd']);
  assert.deepEqual(reorderTasks(ordered, members, 'a', 'a'), ordered);
  assert.deepEqual(reorderTasks(['old', 'a', 'a'], members, 'c', 'b'), ['a', 'c', 'b', 'd']);
  assert.deepEqual(orderTasks([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], ordered).map((task) => task.id), ordered);
  assert.deepEqual(reorderTasks(ordered, members, 'c'), ['a', 'b', 'd', 'c']);
});

test('验收任务进入审核中，可独立筛选且必须通过验收才能完成', () => {
  const task = { id: 'review', status: 'acceptance', reason: '等待审阅成果' };
  const approval = [{ taskId: task.id, type: '验收', state: 'new' }];
  const state = presentTask(task, approval);
  assert.equal(state.column, 'review');
  assert.equal(state.label, '审核中');
  assert.equal(state.summary, task.reason);
  assert.equal(presentTask(task, []).column, 'review');
  assert.equal(presentTask({ ...task, status: 'review' }, []).column, 'review');
  assert.deepEqual(filterPanelTasks([task], approval, { status: 'review' }), [task]);
  assert.deepEqual(filterPanelTasks([task], approval, { status: 'waiting' }), []);
  assert.deepEqual(filterPanelTasks([task], approval), [task]);
  assert.equal(taskDropAction(task, approval, 'review').kind, 'reorder');
  assert.equal(taskDropAction(task, approval, 'done').kind, 'request');
  assert.equal(taskDropAction(task, [], 'done').kind, 'blocked');
  assert.equal(taskAfterDecision(approval[0], 'accept').status, 'done');
  assert.equal(taskAfterDecision(approval[0], 'custom', '补充说明').status, 'running');
});
