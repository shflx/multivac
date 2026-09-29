import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assignSlotInScene,
  focusSessionInScene,
  placeInSlot,
  replaceInSlots,
  resizeParallelInScene,
  resizeSlots,
  resolvedScene,
  resolveSlots,
  switchViewModeInScene,
  type WorkspaceSceneState,
} from '../src/index.js';

/**
 * 工作区现场的栏位规则：界面操作与 Multivac 的工作区工具共用这一套。
 * 现场操作的输入是界面呈现的现场，输出再按会话列表补位（resolvedScene）即是界面与服务端保存的结果。
 */

test('栏位去掉已不在的会话与重复项，空出的栏按列表顺序补位', () => {
  assert.deepEqual(resolveSlots(['b', 'x', 'b'], ['a', 'b', 'c'], 3), ['b', 'a', 'c']);
  assert.deepEqual(resolveSlots([], ['a'], 2), ['a']);
  assert.deepEqual(resolveSlots(['a', 'b', 'c'], ['a', 'b', 'c'], 2), ['a', 'b']);
});

test('指定栏位：替换该栏原会话；已在另一栏时两栏互换', () => {
  assert.deepEqual(placeInSlot(['a', 'b'], 'c', 1), ['a', 'c']);
  assert.deepEqual(placeInSlot(['a', 'b', 'c'], 'c', 0), ['c', 'b', 'a']);
  assert.deepEqual(placeInSlot(['a', 'b'], 'a', 0), ['a', 'b']);
});

test('调小并排数时多出的会话退出显示，当前会话保留在最后一栏', () => {
  assert.deepEqual(resizeSlots(['a', 'b', 'c', 'd'], 2, 'd'), ['a', 'd']);
  assert.deepEqual(resizeSlots(['a', 'b', 'c'], 2, 'a'), ['a', 'b']);
  assert.deepEqual(resizeSlots(['a', 'b'], 4, 'b'), ['a', 'b']);
});

test('从列表聚焦栏位外的会话后缩小并排数，当前会话替换最后一栏', () => {
  const slots = ['a', 'b', 'c'];
  const resized = resizeSlots(slots, 2, 'd');
  assert.deepEqual(resized, ['a', 'd']);
  assert.deepEqual(resolveSlots(resized, ['d', 'c', 'b', 'a'], 2), ['a', 'd']);
  assert.deepEqual(slots, ['a', 'b', 'c']);
});

test('栏位有空位时优先放入当前会话，不留空洞或挤掉原栏位', () => {
  assert.deepEqual(resizeSlots(['a', 'b'], 4, 'd'), ['a', 'b', 'd']);
  assert.deepEqual(resizeSlots([], 2, 'd'), ['d']);
  assert.deepEqual(resizeSlots(['a', 'b'], 4, null), ['a', 'b']);
});

test('栈式深入与返回在原栏位替换会话', () => {
  assert.deepEqual(replaceInSlots(['a', 'b', 'c'], 'b', 'b1'), ['a', 'b1', 'c']);
  assert.deepEqual(replaceInSlots(['a', 'b'], 'x', 'y'), ['a', 'b']);
  assert.deepEqual(replaceInSlots(['a', 'b'], 'b', 'b'), ['a', 'b']);
});

test('返回已展示在前栏或后栏的父会话时只交换两栏，不触发压缩与补位', () => {
  for (const { slots, expected } of [
    { slots: ['parent', 'child', 'other'], expected: ['child', 'parent', 'other'] },
    { slots: ['other', 'child', 'parent'], expected: ['other', 'parent', 'child'] },
  ]) {
    const original = [...slots];
    const replaced = replaceInSlots(slots, 'child', 'parent');
    assert.deepEqual(replaced, expected);
    assert.deepEqual(resolveSlots(replaced, ['spare', 'child', 'other', 'parent'], 3), expected);
    assert.deepEqual(slots, original);
  }
});

test('呈现的现场：空栏按列表顺序补位，当前会话不在工作区中时取第一栏；应用别处的现场前据此算出将呈现的结果', () => {
  const members = ['c', 'b', 'a'];
  assert.deepEqual(resolvedScene({
    parallelCount: 3, slots: ['b', 'gone'], focusedSessionId: 'gone', viewMode: 'parallel', widths: { 3: [1, 1, 2] }, barVisible: false,
  }, members), {
    parallelCount: 3, slots: ['b', 'c', 'a'], focusedSessionId: 'b', viewMode: 'parallel', widths: { 3: [1, 1, 2] }, barVisible: false,
  });
  assert.equal(resolvedScene({
    parallelCount: 2, slots: [], focusedSessionId: 'a', viewMode: 'focus', widths: {}, barVisible: true,
  }, members).focusedSessionId, 'a');
  assert.equal(resolvedScene({
    parallelCount: 2, slots: [], focusedSessionId: null, viewMode: 'focus', widths: {}, barVisible: true,
  }, []).focusedSessionId, null);
});

const scene = (patch: Partial<WorkspaceSceneState>): WorkspaceSceneState => ({
  parallelCount: 3, slots: ['a', 'b', 'c'], focusedSessionId: 'a', viewMode: 'parallel', widths: {}, barVisible: true, ...patch,
});

test('现场操作：聚焦查看只改当前会话与视图，栏位不变；放进第 N 栏后成为当前会话并回到并排', () => {
  assert.deepEqual(focusSessionInScene(scene({}), 'd'), scene({ focusedSessionId: 'd', viewMode: 'focus' }));
  // 替换这一栏；已在另一栏时两栏互换。聚焦时放进栏位会切回并排。
  assert.deepEqual(assignSlotInScene(scene({ viewMode: 'focus' }), 'd', 1), scene({ slots: ['a', 'd', 'c'], focusedSessionId: 'd' }));
  assert.deepEqual(assignSlotInScene(scene({}), 'c', 0), scene({ slots: ['c', 'b', 'a'], focusedSessionId: 'c' }));
});

test('现场操作：调整并排数切回并排，当前会话始终保留在显示中；空出的栏按会话列表补位', () => {
  const members = ['d', 'c', 'b', 'a'];
  const narrowed = resizeParallelInScene(scene({ slots: ['a', 'b', 'c'], focusedSessionId: 'c', viewMode: 'focus' }), 2);
  assert.deepEqual(narrowed, scene({ parallelCount: 2, slots: ['a', 'c'], focusedSessionId: 'c' }));
  const widened = resolvedScene(resizeParallelInScene(narrowed, 4), members);
  assert.deepEqual(widened.slots, ['a', 'c', 'd', 'b']);
  assert.equal(widened.focusedSessionId, 'c');
});

test('现场操作：回到并排时当前会话不在栏位中则改为第一栏；切到聚焦保留当前会话', () => {
  assert.deepEqual(switchViewModeInScene(scene({ focusedSessionId: 'd', viewMode: 'focus' }), 'parallel'), scene({}));
  assert.deepEqual(switchViewModeInScene(scene({ focusedSessionId: 'b', viewMode: 'focus' }), 'parallel'), scene({ focusedSessionId: 'b' }));
  assert.deepEqual(switchViewModeInScene(scene({ focusedSessionId: 'b' }), 'focus'), scene({ focusedSessionId: 'b', viewMode: 'focus' }));
  assert.equal(switchViewModeInScene(scene({ slots: [], focusedSessionId: null, viewMode: 'focus' }), 'parallel').focusedSessionId, null);
});
