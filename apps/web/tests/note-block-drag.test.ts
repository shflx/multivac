import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteBlockDropIndex } from '../src/features/notes/note-block-drag.js';

test('拖动插入边界转换为移动后序号，自身两侧无操作', () => {
  assert.equal(noteBlockDropIndex(2, 0, 3), 0);
  assert.equal(noteBlockDropIndex(0, 3, 3), 2);
  assert.equal(noteBlockDropIndex(1, 1, 3), null);
  assert.equal(noteBlockDropIndex(1, 2, 3), null);
  assert.equal(noteBlockDropIndex(3, 0, 3), null);
  assert.equal(noteBlockDropIndex(0, 4, 3), null);
});
