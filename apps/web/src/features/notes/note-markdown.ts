import type { JSONContent } from '@tiptap/core';
import { Fragment, type Node as DocumentNode, type Schema } from '@tiptap/pm/model';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { decodeString } from 'micromark-util-decode-string';
import type { Nodes } from 'mdast';
import type { NoteSelection } from '@multivac/contracts';

type Character = { start: number; end: number };
type SourceBlock = { start: number; end: number; node: DocumentNode; characters: Map<number, Character> };
export interface NoteMarkdown {
  source: string;
  doc: DocumentNode;
  blocks: SourceBlock[];
}

/** 原文是持久化与引用的依据；AST 位置和编辑器位置都按 UTF-16 记录。 */
export function parseNoteMarkdown(source: string, schema: Schema): NoteMarkdown {
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const characters: Character[] = [];
  const definitions = new Map(tree.children.filter(node => node.type === 'definition').map(node => [node.identifier, node]));
  const bounds = (node: Nodes) => ({ start: node.position?.start.offset ?? 0, end: node.position?.end.offset ?? source.length });
  function text(value: string, node: Nodes, literal = false): JSONContent[] {
    if (!value) return [];
    const { start, end } = bounds(node);
    let cursor = start;
    if (node.type === 'inlineCode') {
      cursor += /^`+/.exec(source.slice(start, end))?.[0].length ?? 0;
      if (source[cursor] === ' ' && source.slice(cursor, end).startsWith(` ${value} `)) cursor++;
    }
    if (node.type === 'code') {
      const fence = /^[ \t]*(?:`{3,}|~{3,})[^\r\n]*(?:\r\n|\n|\r)/.exec(source.slice(start, end));
      if (fence) cursor += fence[0].length;
    }
    let visible = 0;
    while (visible < value.length) {
      // 转义、实体与 CRLF 只占一个可见字符；选区仍指向完整原文字符。
      const remaining = source.slice(cursor, end);
      const escaped = literal ? undefined : /^(?:\\[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]|&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][\da-zA-Z]+);)/.exec(remaining)?.[0];
      const raw = escaped ?? (/^\r\n/.test(remaining) ? '\r\n' : source[cursor] ?? '');
      const decoded = escaped ? decodeString(escaped) : raw === '\r\n' ? '\n' : raw;
      const expected = node.type === 'inlineCode' ? decoded.replace(/[\r\n]/g, ' ') : decoded;
      if (expected && value.startsWith(expected, visible)) {
        for (let unit = 0; unit < expected.length; unit++) characters.push({ start: cursor, end: cursor + raw.length });
        visible += expected.length; cursor += raw.length;
      } else {
        // 容器缩进及代码围栏不属于正文；只在当前 AST 节点的边界内寻找。
        const found = source.indexOf(value[visible]!, cursor);
        if (found < 0 || found >= end) { characters.push({ start: cursor, end: cursor }); visible++; }
        else { characters.push({ start: found, end: found + 1 }); cursor = found + 1; visible++; }
      }
    }
    return [{ type: 'text', text: value }];
  }
  function children(node: Nodes): JSONContent[] { return 'children' in node ? node.children.flatMap(child => convert(child, ['paragraph', 'heading', 'strong', 'emphasis', 'delete', 'link', 'linkReference', 'tableCell'].includes(node.type))) : []; }
  function marked(node: Nodes, type: string, attrs?: Record<string, unknown>): JSONContent[] {
    return children(node).map(child => ({ ...child, marks: [...(child.marks ?? []), { type, ...(attrs ? { attrs } : {}) }] }));
  }
  function convert(node: Nodes, inline = false): JSONContent[] {
    const block = (type: string, attrs?: Record<string, unknown>) => [{ type, ...(attrs ? { attrs } : {}), content: children(node) }];
    switch (node.type) {
      case 'paragraph': return node.children.length === 1 && node.children[0]?.type === 'text' && node.children[0].value === '\u00a0' ? [{ type: 'paragraph' }] : block('paragraph');
      case 'heading': return block('heading', { level: node.depth });
      case 'blockquote': return block('blockquote');
      case 'text': return text(node.value, node);
      case 'strong': return marked(node, 'bold');
      case 'emphasis': return marked(node, 'italic');
      case 'delete': return marked(node, 'strike');
      case 'inlineCode': return text(node.value, node, true).map(child => ({ ...child, marks: [{ type: 'code' }] }));
      case 'code': return [{ type: 'codeBlock', attrs: { language: node.lang ?? null }, content: text(node.value, node, true) }];
      case 'break': return [{ type: 'hardBreak' }];
      case 'thematicBreak': return [{ type: 'horizontalRule' }];
      case 'link': return marked(node, 'link', { href: node.url, title: node.title ?? null });
      case 'linkReference': {
        const definition = definitions.get(node.identifier);
        return definition ? marked(node, 'link', { href: definition.url, title: definition.title ?? null }) : children(node);
      }
      case 'image': return [{ type: 'noteImage', attrs: { src: node.url, alt: node.alt ?? '', title: node.title ?? null } }];
      case 'imageReference': {
        const definition = definitions.get(node.identifier);
        return [{ type: 'noteImage', attrs: { src: definition?.url ?? '', alt: node.alt ?? '', title: definition?.title ?? null } }];
      }
      case 'list': {
        // 同一 Markdown 列表允许普通项和任务项混排；按连续类型分组，保留原文总边界。
        const groups: JSONContent[] = [];
        for (const item of node.children) {
          const task = item.checked !== null && item.checked !== undefined;
          const type = node.ordered ? 'orderedList' : task ? 'taskList' : 'bulletList';
          let group = groups.at(-1);
          if (group?.type !== type) { group = { type, ...(node.ordered ? { attrs: { start: (node.start ?? 1) + groups.reduce((count, entry) => count + (entry.content?.length ?? 0), 0) } } : {}), content: [] }; groups.push(group); }
          group.content!.push({ type: task && !node.ordered ? 'taskItem' : 'listItem', ...(task && !node.ordered ? { attrs: { checked: item.checked } } : {}), content: item.children.length ? children(item) : [{ type: 'paragraph' }] });
        }
        return groups;
      }
      case 'table': return [{ type: 'table', content: node.children.map((row, index) => ({ type: 'tableRow', content: row.children.map((cell, column) => ({ type: index === 0 ? 'tableHeader' : 'tableCell', attrs: { align: node.align?.[column] ?? null }, content: [{ type: 'paragraph', content: children(cell) }] })) })) }];
      // 未建模的 HTML、脚注与定义按原文保留，不交给浏览器执行，也不因编辑其他段落而丢失。
      default: return [{ type: inline ? 'noteRawInline' : 'noteRawBlock', attrs: { source: source.slice(bounds(node).start, bounds(node).end) } }];
    }
  }
  const blocks: SourceBlock[] = [];
  const content: JSONContent[] = [];
  for (const node of tree.children) {
    const converted = convert(node).map(json => schema.nodes[json.type!]?.isInline ? { type: 'paragraph', content: [json] } : json);
    for (const json of converted) { content.push(json); blocks.push({ ...bounds(node), node: schema.nodeFromJSON(json), characters: new Map() }); }
  }
  const doc = schema.nodeFromJSON({ type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] });
  if (!blocks.length) blocks.push({ start: source.length, end: source.length, node: doc.firstChild!, characters: new Map() });
  let index = 0;
  for (const block of blocks) {
    block.node.descendants((node, position) => {
      if (!node.isText) return;
      for (let unit = 0; unit < node.nodeSize; unit++) {
        const character = characters[index++];
        if (character) block.characters.set(position + unit + 1, { start: character.start - block.start, end: character.end - block.start });
      }
    });
  }
  return { source, doc, blocks };
}

function characterAt(markdown: NoteMarkdown, position: number): Character | undefined {
  let offset = 0;
  for (const block of markdown.blocks) {
    if (position >= offset && position < offset + block.node.nodeSize) {
      const character = block.characters.get(position - offset);
      return character && { start: character.start + block.start, end: character.end + block.start };
    }
    offset += block.node.nodeSize;
  }
  return undefined;
}

export function noteMarkdownSelection(markdown: NoteMarkdown, from: number, to: number): NoteSelection | null {
  if (from === to) return null;
  if (from === 0 && to === markdown.doc.content.size) return markdown.source.length > 0 && markdown.source.length <= 16000 ? { start: 0, end: markdown.source.length, text: markdown.source } : null;
  const first = characterAt(markdown, from), last = characterAt(markdown, to - 1);
  if (!first || !last || last.end <= first.start || last.end - first.start > 16000) return null;
  return { start: first.start, end: last.end, text: markdown.source.slice(first.start, last.end) };
}

function markdownJson(node: DocumentNode): JSONContent {
  const json = node.toJSON() as JSONContent;
  // 空标题也需要显式 content，序列化时保留刚输入的标题结构。
  if (node.isTextblock || node.childCount) {
    json.content = [];
    node.forEach(child => json.content!.push(markdownJson(child)));
  }
  return json;
}

/** 普通输入只替换原文字段；结构或格式变化只序列化受影响的顶层段落。 */
export function updateNoteMarkdown(previous: NoteMarkdown, doc: DocumentNode, serialize: (content: JSONContent) => string): NoteMarkdown {
  const start = previous.doc.content.findDiffStart(doc.content);
  if (start === null) return { ...previous, doc };
  let prefix = 0, suffix = 0;
  while (prefix < previous.doc.childCount && prefix < doc.childCount && previous.doc.child(prefix).eq(doc.child(prefix))) prefix++;
  while (suffix < previous.doc.childCount - prefix && suffix < doc.childCount - prefix && previous.doc.child(previous.doc.childCount - suffix - 1).eq(doc.child(doc.childCount - suffix - 1))) suffix++;
  // 混排列表在编辑器中分组，但共享一个原文区间；必须一起序列化，避免重复原列表。
  while (prefix > 0 && previous.blocks[prefix]?.start === previous.blocks[prefix - 1]?.start) prefix--;
  while (suffix > 0 && previous.blocks[previous.blocks.length - suffix]?.start === previous.blocks[previous.blocks.length - suffix - 1]?.start) suffix--;
  const nodes: DocumentNode[] = [];
  for (let index = prefix; index < doc.childCount - suffix; index++) nodes.push(doc.child(index));
  const left = previous.blocks[prefix]?.start ?? previous.source.length;
  const right = Math.max(left, previous.blocks[previous.blocks.length - suffix - 1]?.end ?? left);
  const before = previous.source.slice(0, left), after = previous.source.slice(right);
  function patch(replacement: string): NoteMarkdown | null {
    const inserted = (replacement && prefix > 0 && !before.endsWith('\n\n') ? '\n\n' : '') + replacement + (replacement && suffix > 0 && !after.startsWith('\n\n') ? '\n\n' : '');
    const parsed = nodes.length ? parseNoteMarkdown(inserted, doc.type.schema) : null;
    if (parsed && !parsed.doc.content.eq(Fragment.fromArray(nodes))) return null;
    const delta = inserted.length - (right - left);
    const blocks = [
      ...previous.blocks.slice(0, prefix),
      ...(parsed?.blocks ?? []).map(block => ({ ...block, start: block.start + left, end: block.end + left })),
      ...previous.blocks.slice(previous.blocks.length - suffix).map(block => ({ ...block, start: block.start + delta, end: block.end + delta })),
    ];
    return { source: before + inserted + after, doc, blocks };
  }
  const ends = previous.doc.content.findDiffEnd(doc.content);
  if (ends) {
    const oldEnd = Math.max(start, ends.a), newEnd = Math.max(start, ends.b);
    const first = characterAt(previous, start), last = characterAt(previous, oldEnd - 1);
    const oldPosition = previous.doc.resolve(start), newPosition = doc.resolve(start);
    const inserted = doc.textBetween(start, newEnd);
    const textOnly = oldPosition.parent.isTextblock && oldPosition.sameParent(previous.doc.resolve(oldEnd)) && newPosition.parent.type === oldPosition.parent.type
      && newPosition.sameParent(doc.resolve(newEnd)) && !/[\\`*_[\]<>~&|\r\n]/.test(inserted)
      && doc.slice(start, newEnd).content.childCount <= 1 && (newEnd === start || doc.nodeAt(start)?.isText);
    if (textOnly) {
      const from = first?.start ?? characterAt(previous, start - 1)?.end;
      const to = oldEnd === start ? from : last?.end;
      if (from !== undefined && to !== undefined) {
        const result = patch(previous.source.slice(left, from) + inserted + previous.source.slice(to, right));
        if (result) return result;
      }
    }
  }
  const content = nodes.map(markdownJson);
  const blank = content.length && content.every(node => node.type === 'paragraph' && !node.content?.length);
  const replacement = blank ? (doc.childCount === 1 ? '' : content.map(() => '&nbsp;').join('\n\n')) : serialize({ type: 'doc', content });
  const result = patch(replacement);
  if (!result) throw new Error('正文格式不能无损保存为 Markdown。');
  return result;
}
