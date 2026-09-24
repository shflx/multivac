import assert from 'node:assert/strict';
import test from 'node:test';
import { canSubmitDecision, decisionLabel, deriveRunIndicator, describeRunIndicator, groupToolMessages, listRecentOutputs, matchOutput, parseAssistantIntent, resizePair } from './ui-state.js';

test('分隔线只调整相邻会话，保持总宽度和最小宽度', () => {
  const original = [480, 480, 480];
  assert.deepEqual(resizePair(original, 0, 80), [560, 400, 480]);
  assert.deepEqual(resizePair(original, 0, 1000), [640, 320, 480]);
  assert.deepEqual(resizePair(original, 1, -1000), [480, 320, 640]);
  assert.deepEqual(original, [480, 480, 480]);
  assert.deepEqual(resizePair([320, 320], 0, 20), [320, 320]);
});

test('澄清必须明确选择，自定义范围必须填写内容', () => {
  for (const choice of ['', 'other', 'custom']) assert.equal(canSubmitDecision('澄清', choice), false);
  assert.equal(canSubmitDecision('澄清', 'custom', '   '), false);
  assert.equal(canSubmitDecision('澄清', 'custom', '只使用公开摘要'), true);
  assert.equal(canSubmitDecision('澄清', 'allow'), true);
  assert.equal(canSubmitDecision('澄清', 'deny'), true);
});

test('验收和外发分别判断，不接受空修改意见或跨类型操作', () => {
  assert.equal(canSubmitDecision('验收', 'allow'), false);
  assert.equal(canSubmitDecision('验收', 'revise', ''), false);
  assert.equal(canSubmitDecision('验收', 'revise', '补齐失败状态'), true);
  assert.equal(canSubmitDecision('验收', 'accept'), true);
  assert.equal(canSubmitDecision('外发授权', 'accept'), false);
  assert.equal(canSubmitDecision('外发授权', 'deny'), true);
  assert.notEqual(decisionLabel('澄清', 'deny'), decisionLabel('外发授权', 'deny'));
});

test('同一次连续工具步骤归入一层，其他消息保持原顺序', () => {
  const messages = [
    { who: 'user', text: '检查代码' },
    { id: 'a', tool: true, groupId: 'run-1', groupLabel: '运行检查', status: 'running' },
    { id: 'b', tool: true, groupId: 'run-1', groupLabel: '运行检查', status: 'done' },
    { who: 'assistant', text: '检查完成' },
    { id: 'c', tool: true, groupId: 'run-2', status: 'cancelled' },
  ];
  const grouped = groupToolMessages(messages);
  assert.deepEqual(grouped.map(({ kind }) => kind), ['message', 'tools', 'message', 'tools']);
  assert.deepEqual(grouped[1].messages.map(({ id }) => id), ['a', 'b']);
  assert.equal(grouped[1].label, '运行检查');
  assert.deepEqual(grouped[3].messages.map(({ id }) => id), ['c']);
  assert.deepEqual(messages.map(({ id }) => id), [undefined, 'a', 'b', undefined, 'c']);
});

const task = (id, status) => ({ id, status });

test('运行指示：没有执行中或排队的任务时为空闲', () => {
  assert.equal(deriveRunIndicator([]).state, 'idle');
  const indicator = deriveRunIndicator([task('a', 'done'), task('b', 'paused'), task('c', 'scheduler-paused')]);
  assert.equal(indicator.state, 'idle');
  assert.deepEqual([indicator.running.length, indicator.queued.length, indicator.anomalies.length], [0, 0, 0]);
  assert.equal(describeRunIndicator(indicator), '没有执行中或排队的任务');
});

test('运行指示：有执行中或排队且无异常时为正常', () => {
  assert.equal(deriveRunIndicator([task('a', 'queued')]).state, 'ok');
  const indicator = deriveRunIndicator([task('a', 'running'), task('b', 'running'), task('c', 'queued'), task('d', 'done')]);
  assert.equal(indicator.state, 'ok');
  assert.deepEqual(indicator.running.map(({ id }) => id), ['a', 'b']);
  assert.deepEqual(indicator.queued.map(({ id }) => id), ['c']);
  assert.equal(describeRunIndicator(indicator), '2 个执行中 · 1 个排队');
});

test('运行指示：恢复待确认、执行失败、长时间无进展都算异常', () => {
  for (const status of ['recovery', 'failed', 'stalled']) {
    const indicator = deriveRunIndicator([task('a', 'running'), task('b', status)]);
    assert.equal(indicator.state, 'attention');
    assert.deepEqual(indicator.anomalies.map(({ id }) => id), ['b']);
  }
  // 没有任务在跑时，异常依然要提示。
  assert.equal(deriveRunIndicator([task('a', 'stalled')]).state, 'attention');
  const indicator = deriveRunIndicator([task('a', 'running'), task('b', 'running'), task('c', 'running'), task('d', 'queued'), task('e', 'failed')]);
  assert.equal(describeRunIndicator(indicator), '3 个执行中 · 1 个排队 · 1 个异常');
});

test('运行指示：只有等待用户处理的任务时不算异常', () => {
  const waiting = [task('a', 'clarification'), task('b', 'acceptance'), task('c', 'authorization')];
  assert.equal(deriveRunIndicator(waiting).state, 'idle');
  assert.equal(deriveRunIndicator(waiting).anomalies.length, 0);
  assert.equal(deriveRunIndicator([...waiting, task('d', 'running')]).state, 'ok');
});

const outputFixtures = [
  { id: 'old', taskId: 't1', title: '旧报告', at: '2026-09-23T19:10:00' },
  { id: 'new', taskId: 't2', title: '新文档', at: '2026-09-24T14:32:00' },
  { id: 'mid', taskId: 't3', title: '中间的变更', at: '2026-09-24T09:00:00' },
];
const outputTasks = [
  { id: 't1', title: '调研', status: 'done' },
  { id: 't2', title: '审阅', status: 'acceptance' },
  { id: 't3', title: '修复', status: 'running' },
];

test('成果列表按时间倒序，不改动原数组', () => {
  const list = listRecentOutputs(outputFixtures, outputTasks, new Set());
  assert.deepEqual(list.map(({ id }) => id), ['new', 'mid', 'old']);
  assert.deepEqual(outputFixtures.map(({ id }) => id), ['old', 'new', 'mid']);
  assert.equal(list[0].taskTitle, '审阅');
});

test('成果列表的未查看标记只看是否打开过', () => {
  const list = listRecentOutputs(outputFixtures, outputTasks, new Set(['mid']));
  assert.deepEqual(list.map(({ id, unviewed }) => [id, unviewed]), [['new', true], ['mid', false], ['old', true]]);
});

test('成果列表按来源任务判断待验收', () => {
  const list = listRecentOutputs(outputFixtures, outputTasks, new Set());
  assert.deepEqual(list.filter(({ awaitingAcceptance }) => awaitingAcceptance).map(({ id }) => id), ['new']);
  // 来源任务缺失时不算待验收，也不报错。
  const orphan = listRecentOutputs([{ id: 'x', taskId: 'missing', at: '2026-09-24T10:00:00' }], outputTasks, new Set());
  assert.deepEqual([orphan[0].awaitingAcceptance, orphan[0].taskTitle], [false, '']);
});

test('一句话意图：创建项目、取回成果、交代任务与讨论各自区分', () => {
  assert.deepEqual(parseAssistantIntent('把 ~/code/notes 作为项目'), { kind: 'project', path: '~/code/notes' });
  assert.equal(parseAssistantIntent('把昨天那份调研报告给我').kind, 'output');
  assert.equal(parseAssistantIntent('把这个整理成文档').kind, 'task');
  // 带“整理”的是交付意图，即使提到了成果也不是取回。
  assert.equal(parseAssistantIntent('把调研报告整理一下给我').kind, 'task');
  assert.equal(parseAssistantIntent('先把界面原型的核心体验走通').kind, 'chat');
});

test('取回成果按标题重合挑选，没有线索时给最近的一份', () => {
  const outputs = [
    { id: 'sdk', title: 'Coding Agent SDK 调研报告', at: '2026-09-23T19:10:00' },
    { id: 'mvp', title: 'MVP 交互原型说明', at: '2026-09-24T14:32:00' },
  ];
  assert.equal(matchOutput(outputs, '把昨天那份调研报告给我').id, 'sdk');
  assert.equal(matchOutput(outputs, '原型说明发我一下').id, 'mvp');
  assert.equal(matchOutput(outputs, '随便给我一份成果').id, 'mvp');
  assert.equal(matchOutput([], '报告给我'), null);
});
