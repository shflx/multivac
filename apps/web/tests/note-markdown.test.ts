import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { EditorState } from '@tiptap/pm/state';
import { noteRichTextExtensions } from '../src/features/notes/note-rich-text-schema.js';
import { parseNoteMarkdown, updateNoteMarkdown, noteMarkdownSelection } from '../src/features/notes/note-markdown.js';

const schema = getSchema(noteRichTextExtensions);
const manager = new MarkdownManager({ extensions: noteRichTextExtensions });
const parse = (source: string) => parseNoteMarkdown(source, schema);
const serialize = (content: Parameters<MarkdownManager['serialize']>[0]) => manager.serialize(content);

test('渲染 GFM 结构，读取不改写空白、原文和不支持的语法', () => {
  const source = '\n# 标题  \n\n**粗体**与*斜体*，~~删除~~、`代码`、[链接](https://example.com)。\n\n- [ ] 待办\n- [x] 完成\n\n| 列一 | 列二 |\n| --- | --- |\n| A | B |\n\n```ts\nconst x = 1;\n```\n\n![图片](https://example.com/a.png)\n\n<script>alert(1)</script>\n\n[^a]: 脚注\n';
  const parsed = parse(source);
  assert.equal(parsed.source, source);
  assert.equal(parsed.doc.firstChild?.type.name, 'heading');
  const types: string[] = [];
  parsed.doc.descendants(node => { types.push(node.type.name); });
  for (const type of ['taskList', 'table', 'codeBlock', 'noteImage', 'noteRawBlock']) assert.ok(types.includes(type), type);
  assert.ok(parsed.doc.toJSON());
  assert.equal(updateNoteMarkdown(parsed, parsed.doc, serialize).source, source);
});

test('可见选区映射到 UTF-16 原文，包含格式、转义、实体和 emoji', () => {
  const source = '# 标题\n\n**粗体🙂** 与 \\*字符 &amp; [链接](https://example.com)';
  const parsed = parse(source);
  let bold = 0, star = 0, entity = 0, link = 0;
  parsed.doc.descendants((node, position) => {
    if (!node.isText) return;
    if (node.text === '粗体🙂') bold = position;
    if (node.text?.includes('*字符')) star = position + node.text.indexOf('*字符');
    if (node.text?.includes('&')) entity = position + node.text.indexOf('&');
    if (node.text === '链接') link = position;
  });
  assert.deepEqual(noteMarkdownSelection(parsed, bold, bold + 4), { start: source.indexOf('粗体'), end: source.indexOf('粗体') + 4, text: '粗体🙂' });
  assert.equal(noteMarkdownSelection(parsed, star, star + 1)?.text, '\\*');
  assert.equal(noteMarkdownSelection(parsed, entity, entity + 1)?.text, '&amp;');
  assert.equal(noteMarkdownSelection(parsed, link, link + 2)?.text, '链接');
  assert.equal(noteMarkdownSelection(parsed, bold, link + 2)?.text, source.slice(source.indexOf('粗体'), source.indexOf('链接') + 2));
});

test('普通输入保留当前段落的原有空白与其余段落，格式命令只改目标段', () => {
  const source = '# 标题\n\n正文  保留空白。  \n下一行。\n\n\n末段 \n';
  const parsed = parse(source);
  let position = 0;
  parsed.doc.descendants((node, offset) => { if (node.isText && node.text?.startsWith('正文')) position = offset + 2; });
  const changed = EditorState.create({ doc: parsed.doc }).tr.insertText('新增', position);
  const updated = updateNoteMarkdown(parsed, changed.doc, serialize);
  assert.equal(updated.source, source.replace('正文', '正文新增'));
  const marked = EditorState.create({ doc: updated.doc }).tr.addMark(position, position + 2, schema.marks.bold!.create());
  const formatted = updateNoteMarkdown(updated, marked.doc, serialize);
  assert.ok(formatted.source.startsWith('# 标题\n\n'));
  assert.ok(formatted.source.endsWith('\n\n\n末段 \n'));
  assert.match(formatted.source, /\*\*新增\*\*/);
  assert.ok(formatted.doc.eq(marked.doc));
});

test('结构输入和撤销能往返，末尾空段落不丢失，混排列表不复制原文', () => {
  let parsed = parse('第一段');
  const old = parsed;
  const split = EditorState.create({ doc: parsed.doc }).tr.split(parsed.doc.content.size - 1);
  parsed = updateNoteMarkdown(parsed, split.doc, serialize);
  assert.ok(parse(parsed.source).doc.eq(split.doc));
  const typed = EditorState.create({ doc: parsed.doc }).tr.insertText('第二段', parsed.doc.content.size - 1);
  parsed = updateNoteMarkdown(parsed, typed.doc, serialize);
  assert.ok(parse(parsed.source).doc.eq(typed.doc));
  assert.ok(parse(updateNoteMarkdown(parsed, old.doc, serialize).source).doc.eq(old.doc));
  const list = parse('- 普通\n- [ ] 待办\n- [x] 完成\n\n末段保持。');
  let task = 0;
  list.doc.descendants((node, offset) => { if (node.type.name === 'taskItem' && !node.attrs.checked) task = offset; });
  const checked = EditorState.create({ doc: list.doc }).tr.setNodeMarkup(task, undefined, { checked: true });
  const next = updateNoteMarkdown(list, checked.doc, serialize);
  assert.equal((next.source.match(/普通/g) ?? []).length, 1);
  assert.equal((next.source.match(/待办/g) ?? []).length, 1);
  assert.ok(next.source.endsWith('末段保持。'));
});

test('增量编辑重用未变化段落的映射，后续引用仍指向新原文', () => {
  const source = Array.from({ length: 100 }, (_, index) => `第${index}段，**文字🙂**。`).join('\n\n');
  const original = parse(source);
  const changed = EditorState.create({ doc: original.doc }).tr.insertText('新增内容', 2);
  const updated = updateNoteMarkdown(original, changed.doc, serialize);
  assert.equal(updated.blocks[99]!.characters, original.blocks[99]!.characters);
  let position = 0;
  updated.doc.descendants((node, offset) => { if (node.isText && node.text === '文字🙂') position = offset; });
  const picked = noteMarkdownSelection(updated, position, position + 4)!;
  assert.equal(picked.text, '文字🙂');
  assert.equal(updated.source.slice(picked.start, picked.end), picked.text);
  assert.equal(picked.start, updated.source.lastIndexOf('文字🙂'));
});

test('编辑含围栏字符的代码与带对齐的表格不丢结构，清空正文为空字符串', () => {
  const original = parse('~~~~ts\nconst fence = "```";\n~~~~\n\n| 左 | 右 |\n| :--- | ---: |\n| A | B |');
  let code = 0;
  original.doc.descendants((node, position) => { if (node.isText && node.text?.startsWith('const')) code = position; });
  const changed = EditorState.create({ doc: original.doc }).tr.insertText('\n新行', code + 'const fence = "```";'.length);
  const updated = updateNoteMarkdown(original, changed.doc, serialize);
  assert.ok(parse(updated.source).doc.eq(changed.doc));
  assert.ok(updated.source.includes('````ts'));
  assert.ok(updated.source.endsWith('| 左 | 右 |\n| :--- | ---: |\n| A | B |'));
  const empty = schema.node('doc', null, [schema.node('paragraph')]);
  assert.equal(updateNoteMarkdown(updated, empty, serialize).source, '');
});

test('行内 HTML、脚注、空列表项和列表内标题保持合法结构及原文', () => {
  for (const source of ['正文 <b>文本</b> 与脚注[^a]。\n\n[^a]: 说明', '- # 列表内标题\n- ', '- [ ] # 任务内标题\n- [x] ']) {
    const original = parse(source);
    original.doc.check();
    assert.equal(original.source, source);
  }
});

test('空标题结构可保存并继续输入，不被当作空正文删除', () => {
  const original = parse('');
  const heading = EditorState.create({ doc: original.doc }).tr.setNodeMarkup(0, schema.nodes.heading, { level: 2 });
  const updated = updateNoteMarkdown(original, heading.doc, serialize);
  assert.equal(updated.source, '## ');
  const typed = EditorState.create({ doc: updated.doc }).tr.insertText('灵感', 1);
  assert.equal(updateNoteMarkdown(updated, typed.doc, serialize).source, '## 灵感');
});

test('尚未触发格式规则的字面符号与首尾空白可无损编辑保存', () => {
  for (const value of ['#', '##', ' ', '  首尾空白  ', '> 普通文字', '1. 普通文字', '---', '\t缩进']) {
    const original = parse('');
    const doc = schema.node('doc', null, [schema.node('paragraph', null, schema.text(value))]);
    const saved = updateNoteMarkdown(original, doc, serialize);
    assert.ok(parse(saved.source).doc.eq(doc), JSON.stringify(value));
  }
});
