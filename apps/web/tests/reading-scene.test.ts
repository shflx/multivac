import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyReading, navigateReading, openReading, readingStorageKey, restoreReading } from '../src/features/workspace/reading-scene.js';

test('历史保存位置，导航不回滚最近文件、目录偏好；新打开清空前进', () => {
  let scene = openReading(emptyReading('/root'), 'a.md', { line: 12 });
  scene = { ...scene, position: { ...scene.position, scrollTop: 123, scrollLeft: 45, positioned: true, query: '原文' } };
  scene = openReading(scene, 'b.ts');
  scene = { ...scene, expandedDirs: ['docs'], directoryOpen: false };
  const previous = navigateReading(scene, 'previous');
  assert.equal(previous.position.path, 'a.md'); assert.equal(previous.position.scrollTop, 123); assert.equal(previous.position.query, '原文');
  assert.deepEqual(previous.recent, ['b.ts', 'a.md']); assert.deepEqual(previous.expandedDirs, ['docs']); assert.equal(previous.directoryOpen, false);
  const forward = navigateReading(previous, 'forward'); assert.equal(forward.position.path, 'b.ts');
  const opened = openReading(previous, 'c.txt'); assert.equal(opened.future.length, 0);
  assert.deepEqual(openReading(opened, 'c.txt').recent, opened.recent);
});

test('本机恢复按工作区、会话和原根目录隔离，损坏或越界记录拒绝', () => {
  assert.notEqual(readingStorageKey('recent', 'a'), readingStorageKey('default', 'a'));
  assert.notEqual(readingStorageKey('default', 'a'), readingStorageKey('default', 'b'));
  const scene = openReading(emptyReading('/old'), 'notes.txt');
  assert.deepEqual(restoreReading(JSON.stringify(scene), '/old'), scene);
  for (const raw of ['{', JSON.stringify({ ...scene, version: 2 }), JSON.stringify({ ...scene, position: { ...scene.position, path: '../secret' } }), JSON.stringify({ ...scene, recent: Array(21).fill('x') })]) assert.deepEqual(restoreReading(raw, '/old'), emptyReading('/old'));
  const moved = restoreReading(JSON.stringify(scene), '/new');
  assert.equal(moved.position.path, null); assert.match(moved.notice!, /工作目录已变化/);
});
