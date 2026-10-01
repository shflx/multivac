import { test } from 'node:test';
import assert from 'node:assert/strict';
import { railIsCrowded } from '../src/features/workspace/rail-layout.js';

test('停靠阈值按实际可用宽度与呈现栏数计算，助手并排占用由容器宽度扣除', () => {
  for (const count of [1, 2, 3, 4]) {
    assert.equal(railIsCrowded(240 + 360 * count, count), false);
    assert.equal(railIsCrowded(239 + 360 * count, count), true);
  }
  assert.equal(railIsCrowded(1440, 3), false);
  assert.equal(railIsCrowded(1440 - 360, 3), true);
});
