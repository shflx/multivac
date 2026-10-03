import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReadingScene } from '../src/features/reading/reading-scene.js';
import { readingPanelLayout } from '../src/features/reading/reading-scene.js';

test('宽屏双侧、较窄桌面最后操作侧与手机正文切换保留原偏好', () => {
  const scene = { navigation: true, right: { open: true, tab: 'notes' }, lastSide: 'left', pane: 'reader' } as ReadingScene;
  assert.deepEqual(readingPanelLayout(scene, 1200, false), { compact: false, left: true, right: true, reader: true });
  assert.deepEqual(readingPanelLayout(scene, 800, false), { compact: false, left: true, right: false, reader: true });
  assert.deepEqual(readingPanelLayout({ ...scene, lastSide: 'right' }, 800, false), { compact: false, left: false, right: true, reader: true });
  assert.deepEqual(readingPanelLayout(scene, 390, true), { compact: true, left: false, right: false, reader: true });
  assert.deepEqual(readingPanelLayout({ ...scene, pane: 'right' }, 390, true), { compact: true, left: false, right: true, reader: false });
  assert.deepEqual(readingPanelLayout(scene, 1200, false), { compact: false, left: true, right: true, reader: true });
  assert.equal(scene.navigation, true); assert.equal(scene.right.open, true);
});
