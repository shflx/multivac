import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageFileReferences } from '../src/application/message-file-sources.js';

test('正文、行内代码和 Markdown 支持两种范围分隔符，并按消息位置区分重复显示文字', () => {
  const text = 'src/path.ts:24–27 与 `:205–218`，src/path.ts:42-48。\n\n[源码](a.ts:3-6) [源码](b.ts#L12-L20) [章节](docs/a.md#章节)';
  const refs = messageFileReferences(text, '/workspace');
  assert.deepEqual(refs.map(({ path, line, endLine, section }) => [path, line, endLine, section]), [
    ['src/path.ts', 24, 27, undefined], ['src/path.ts', 205, 218, undefined], ['src/path.ts', 42, 48, undefined],
    ['a.ts', 3, 6, undefined], ['b.ts', 12, 20, undefined], ['docs/a.md', undefined, undefined, '章节'],
  ]);
  assert.deepEqual(refs.map(r => text.slice(r.startOffset, r.endOffset)), ['src/path.ts:24–27', ':205–218', 'src/path.ts:42-48', '[源码](a.ts:3-6)', '[源码](b.ts#L12-L20)', '[章节](docs/a.md#章节)']);
});

test('省略路径只继承局部唯一的明确前置文件，段落与列表项互相隔离', () => {
  const text = ':1–2\n\na.ts 和 :3–4\n\n:5–6\n\n- b.ts 和 `:7-8`\n- :9–10\n\na.ts 和 b.ts 和 :11–12\n\n[a](a.ts) 和 `:13–14`\n\n- c.ts\n\n  同一列表项 :15–16\n\n- :17–18';
  const refs = messageFileReferences(text, '/workspace');
  assert.deepEqual(refs.filter(r => r.line).map(r => [r.path, r.line, r.endLine]), [['a.ts', 3, 4], ['b.ts', 7, 8], ['a.ts', 13, 14], ['c.ts', 15, 16]]);
});

test('URL、时间、代码块、非法范围与越界路径不生成可操作引用', () => {
  for (const text of [
    'https://example.com/a.ts:12–20 www.example.com/a.ts mailto:a.ts 12:30 :205–218 1.5',
    '```ts\na.ts:12–20\n```',
    'a.ts:0 a.ts:4-2 a.ts:20001 a.ts:2-20001 a.ts:2–0 a.ts:99999999999999999 a.ts:1.5 a.ts:2-3.5',
    '../a.ts:4 /etc/a.ts:2 [越界](%2e%2e/a.ts:2) [非法](a.ts#L0) [非法](a.ts:4–2)',
  ]) assert.deepEqual(messageFileReferences(text, '/workspace'), [], text);
  for (const text of ['a.ts ../b.ts :12', 'a.ts [非法](b.ts:0) :12', '# a.ts\n\n# :12']) assert.deepEqual(messageFileReferences(text, '/workspace').filter(r => r.line), []);
});

test('相同 href 保留独立区间，图片来源与章节不改为正文引用', () => {
  const text = '[相同](a.ts:12) [相同](a.ts:12) ![a.ts:9](image.png)';
  const refs = messageFileReferences(text, '/workspace', true);
  assert.equal(refs.length, 3);
  assert.notEqual(refs[0]?.startOffset, refs[1]?.startOffset);
  assert.equal(refs[2]?.kind, 'image');
  assert.equal(refs[2]?.line, undefined);
});
