import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionFileReference } from '@multivac/contracts';
import { MarkdownBody } from '../src/features/assistant/markdown-body.js';
import { messageFileReferences } from '../../server/src/application/message-file-sources.js';

const render = (text: string, references: SessionFileReference[] = messageFileReferences(text, '/workspace')) => renderToStaticMarkup(
  <MarkdownBody text={text} identity="test" fileReferences={references} onOpenFileReference={() => {}} />,
);

test('真实Markdown渲染保留原文、行内code样式和唯一入口，使用完整路径与范围提示', () => {
  const html = render('src/path.ts:24–27 和 `:205–218`，`src/next.ts:4-6`。');
  assert.equal((html.match(/<button /g) ?? []).length, 3);
  assert.ok(html.includes('title="/workspace/src/path.ts:24–27"'));
  assert.ok(html.includes('title="/workspace/src/path.ts:205–218"'));
  assert.match(html, /<code><button[^>]*>:205–218<\/button><\/code>/);
  assert.ok(html.includes('>src/path.ts:24–27</button>'));
  assert.ok(!html.includes('<em>'));
});

test('重复Markdown标签与相同href按区间定位，兼容旧冻结链接及章节', () => {
  const text = '[源码](a.ts:2–4) [源码](b.ts#L8-L9) [章节](docs/a.md#阅读现场)';
  const html = render(text);
  assert.equal((html.match(/<button /g) ?? []).length, 3);
  for (const target of ['/workspace/a.ts:2–4', '/workspace/b.ts:8–9', '/workspace/docs/a.md#阅读现场']) assert.ok(html.includes(`title="${target}"`));
  const old: SessionFileReference = { root: '/old', path: 'a.ts', href: 'a.ts#L2', line: 2 };
  assert.ok(render('[旧链接](a.ts#L2)', [old]).includes('title="/old/a.ts:2"'));
  assert.equal((render('a.ts:2 a.ts:2').match(/<button /g) ?? []).length, 2);
});

test('无冻结来源与不支持浏览保留普通文字，错误区间不绑定同名路径', () => {
  assert.ok(!render('a.ts:2 和 `:4`', []).includes('<button'));
  const text = 'a.ts:2 a.ts:2';
  const refs = messageFileReferences(text, '/workspace');
  assert.equal((render(text, [refs[1]!]).match(/<button /g) ?? []).length, 1);
  assert.ok(!render('b.ts:2', [refs[0]!]).includes('<button'));
  const html = renderToStaticMarkup(<MarkdownBody text={text} identity="no-browser" fileReferences={refs} />);
  assert.ok(!html.includes('<button'));
});

test('图片、外部链接、章节锚点、代码块与复制数据源保持原行为', () => {
  const text = '[网页](https://example.com) [章节](#章节) ![图片](https://example.com/a.png)\n\n```ts\nconst path = "a.ts:3";\n```';
  const html = render(text);
  assert.ok(html.includes('href="https://example.com"'));
  assert.ok(html.includes(`href="#${encodeURI('章节')}"`));
  assert.ok(html.includes('加载外部图片'));
  assert.ok(html.includes('aria-label="复制代码"'));
  assert.ok(!html.includes('打开原文'));
  assert.equal(html, render(text, []));
});
