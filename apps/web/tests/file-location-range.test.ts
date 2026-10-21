import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileLineRangeError, fileLocationElement } from '../src/features/workspace/file-preview.js';
import { emptyReading, navigateReading, openReading, restoreReading } from '../src/features/workspace/reading-scene.js';
import { messageFileReferences } from '../../server/src/application/message-file-sources.js';

test('解析的endLine贯穿打开、同文件多处、跨文件、历史与刷新恢复', () => {
  const refs = messageFileReferences('a.ts:24–27 和 `:205–218`\n\nb.ts:4-6', '/workspace');
  let scene = emptyReading('/workspace');
  for (const ref of refs) {
    assert.equal(fileLineRangeError('line\n'.repeat(250), ref), null);
    scene = openReading(scene, ref.path, { line: ref.line, endLine: ref.endLine });
    scene = { ...scene, position: { ...scene.position, positioned: true, scrollTop: ref.line! * 20 } };
  }
  assert.equal(scene.position.path, 'b.ts');
  scene = restoreReading(JSON.stringify(scene), '/workspace');
  scene = navigateReading(scene, 'previous');
  assert.deepEqual([scene.position.path, scene.position.line, scene.position.endLine, scene.position.scrollTop], ['a.ts', 205, 218, 4100]);
  scene = navigateReading(scene, 'previous');
  assert.deepEqual([scene.position.line, scene.position.endLine], [24, 27]);
  scene = navigateReading(scene, 'forward');
  assert.deepEqual([scene.position.line, scene.position.endLine], [205, 218]);
  assert.equal(scene.position.positioned, true);
});

test('非法或超出实际正文范围不夹取到替代行，单行/文件末行与CRLF可定位', () => {
  const text = 'first\r\nsecond\r\nthird';
  for (const target of [{ line: 0 }, { line: -1 }, { line: 1.5 }, { line: NaN }, { endLine: 2 }, { line: 2, endLine: 1 }, { line: 1, endLine: 0 }, { line: 20001 }, { line: 1, endLine: Infinity }, { line: 1, section: '冲突' }]) assert.match(fileLineRangeError(text, target)!, /无效/);
  for (const target of [{ line: 4 }, { line: 2, endLine: 4 }]) assert.match(fileLineRangeError(text, target)!, /实际共 3 行/);
  for (const target of [{ line: 3 }, { line: 1, endLine: 3 }, {}, { section: '章节' }]) assert.equal(fileLineRangeError(text, target), null);
});

test('定位精确匹配行号，缺少目标行或章节时不回退', () => {
  const element = { dataset: { line: '12' } } as unknown as HTMLElement;
  const heading = { textContent: '章节' } as unknown as HTMLElement;
  const host = {
    querySelector: (selector: string) => selector === '[data-line="12"]' ? element : null,
    querySelectorAll: () => [heading],
  } as unknown as HTMLElement;
  assert.equal(fileLocationElement(host, { line: 12 }), element);
  assert.equal(fileLocationElement(host, { line: 13 }), null);
  assert.equal(fileLocationElement(host, { line: 0 }), null);
  assert.equal(fileLocationElement(host, { section: '章节' }), heading);
  assert.equal(fileLocationElement(host, { section: '删除的章节' }), null);
});

test('历史达到上限后，同文件新目标仍清除旧滚动状态并保留完整范围', () => {
  let scene = emptyReading('/workspace');
  for (let line = 1; line <= 45; line++) {
    scene = openReading(scene, 'a.ts', { line, endLine: line + 2 });
    scene = { ...scene, position: { ...scene.position, positioned: true, scrollTop: 900 } };
  }
  assert.equal(scene.history.length, 40);
  scene = openReading(scene, 'a.ts', { line: 45, endLine: 47 });
  assert.equal(scene.position.positioned, false);
  assert.equal(scene.position.scrollTop, 0);
  assert.equal(scene.position.endLine, 47);
  assert.equal(navigateReading(scene, 'previous').position.scrollTop, 900);
});
