import assert from 'node:assert/strict';
import test from 'node:test';
import {
  gridColumns,
  MIN_PANE_WIDTH,
  pairPercent,
  resizeColumns,
  resizePair,
} from '../src/features/workspace/pane-layout.js';
import {
  placeInSlot,
  replaceInSlots,
  resizeSlots,
  resolveSlots,
} from '../src/features/workspace/workspace-slots.js';

test('拖动分隔线只调整相邻两栏，两栏总宽与其他栏不变', () => {
  assert.deepEqual(resizePair([500, 500, 400], 0, 100), [600, 400, 400]);
  assert.deepEqual(resizePair([500, 500, 400], 1, -100), [500, 400, 500]);
});

test('相邻两栏都不小于最小宽度；两栏总宽不足两倍最小宽度时均分', () => {
  assert.deepEqual(resizePair([500, 500], 0, -900), [MIN_PANE_WIDTH, 1000 - MIN_PANE_WIDTH]);
  assert.deepEqual(resizePair([300, 300], 0, 100), [300, 300]);
  assert.deepEqual(resizePair([500, 500], 5, 100), [500, 500]);
});

test('已横向滚动时只调整左侧一栏，右侧各栏平移，且不小于最小宽度', () => {
  assert.deepEqual(resizeColumns([320, 320, 320, 320], 1, 80, true), [320, 400, 320, 320]);
  assert.deepEqual(resizeColumns([400, 320], 0, -200, true), [MIN_PANE_WIDTH, 320]);
});

test('列定义：未调整为等宽；放得下按比例铺满，放不下按像素排布', () => {
  assert.equal(gridColumns(3, undefined, 1200), 'minmax(320px, 1fr) minmax(320px, 1fr) minmax(320px, 1fr)');
  assert.equal(gridColumns(2, [600, 400], 1200), 'minmax(320px, 600fr) minmax(320px, 400fr)');
  assert.equal(gridColumns(2, [900, 400], 1200), '900px 400px');
  // 保存的列宽与栏数不一致（例如并排数刚调整）时回到等宽。
  assert.equal(gridColumns(2, [300, 300, 300], 1200), 'minmax(320px, 1fr) minmax(320px, 1fr)');
  assert.equal(pairPercent(undefined, 0), 50);
  assert.equal(pairPercent([600, 400, 500], 0), 60);
});

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

test('栈式深入与返回在原栏位替换会话', () => {
  assert.deepEqual(replaceInSlots(['a', 'b', 'c'], 'b', 'b1'), ['a', 'b1', 'c']);
  assert.deepEqual(replaceInSlots(['a', 'b'], 'x', 'y'), ['a', 'b']);
});
