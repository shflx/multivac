import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampSplit,
  DEFAULT_SPLIT,
  MIN_PANE_WIDTH,
  resizeSplit,
  splitPercent,
} from '../src/features/workspace/pane-layout.js';

test('拖动分隔线按像素位移调整左栏占比，总宽不变', () => {
  assert.equal(resizeSplit(0.5, 1000, 100), 0.6);
  assert.equal(resizeSplit(0.5, 1000, -100), 0.4);
});

test('两栏都不小于最小宽度；总宽不足时均分', () => {
  const minimum = MIN_PANE_WIDTH / 1000;
  assert.equal(resizeSplit(0.5, 1000, -900), minimum);
  assert.equal(resizeSplit(0.5, 1000, 900), 1 - minimum);
  assert.equal(resizeSplit(0.3, 500, 0), 0.5);
  assert.equal(clampSplit(0.9, 600), 0.5);
});

test('非法输入回退为合法占比', () => {
  assert.equal(clampSplit(Number.NaN, 1000), DEFAULT_SPLIT);
  assert.equal(clampSplit(1.5, 0), 1);
  assert.equal(resizeSplit(0.5, 0, 50), 0.5);
  assert.equal(splitPercent(0.555), 56);
});
