import type { Editor } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import { Selection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { canSplit } from '@tiptap/pm/transform';
import { closeHistory } from '@tiptap/pm/history';
import { noteBlocks } from './note-blocks.js';
import { parseNoteMarkdown, updateNoteMarkdown, type NoteMarkdown } from './note-markdown.js';
import { NoteBlockSourceStep } from './note-block-source-step.js';
import { noteUploadCount } from './note-image-editing.js';

export type NoteBlockAction = 'activate' | 'insert' | 'split' | 'merge' | 'up' | 'down' | 'copy' | 'delete';

/** 原文按顶层分割线切片，块内空白与未编辑的 Markdown 不经过重新序列化。 */
function sourceBlocks(markdown: NoteMarkdown) {
  const rules = markdown.blocks.filter(block => block.node.type.name === 'horizontalRule');
  return { rules, parts: Array.from({ length: rules.length + 1 }, (_, index) => ({
    from: index ? rules[index - 1]!.end : 0,
    to: rules[index]?.start ?? markdown.source.length,
  })) };
}

export function noteBlockTransaction(state: EditorState, markdown: NoteMarkdown, action: NoteBlockAction | 'move', index: number, serialize: Parameters<typeof updateNoteMarkdown>[2], destination?: number): Transaction | null {
  // 未完成图片有额外的编辑器占位，先完成上传再整理，避免复制上传身份。
  if (noteUploadCount(state.doc) || !markdown.doc.eq(state.doc)) return null;
  const blocks = noteBlocks(state.doc), block = blocks[index];
  if (!block) return null;
  const { rules, parts } = sourceBlocks(markdown), part = parts[index]!;
  let nextSource = markdown.source, focus = block.from;
  const expected = blocks.map(block => block.nodes.map(({ node }) => node));
  const replace = (from: number, to: number, value: string) => markdown.source.slice(0, from) + value + markdown.source.slice(to);
  let tr = closeHistory(state.tr);
  if (action === 'split') {
    const { $from, empty } = state.selection;
    if (!empty || $from.pos < block.from || $from.pos > block.to || !$from.parent.isTextblock || !canSplit(state.doc, $from.pos, $from.depth)) return null;
    tr.split($from.pos, $from.depth);
    const boundary = $from.before(1) + tr.doc.nodeAt($from.before(1))!.nodeSize;
    tr.insert(boundary, state.schema.nodes.horizontalRule!.create());
    const next = updateNoteMarkdown(markdown, tr.doc, serialize);
    nextSource = next.source; focus = boundary + 1;
  } else if (action === 'activate') {
    if (block.nodes.length) return null;
    nextSource = replace(part.from, part.to, '\n\n&nbsp;\n\n');
    expected[index] = [state.schema.nodes.paragraph!.create()];
  } else if (action === 'merge') {
    const rule = rules[index - 1]; if (!rule) return null;
    // 保留两块内容的原文，只移除中间分割线。
    nextSource = replace(rule.start, rule.end, '\n\n'); focus = block.from - 1;
    expected[index - 1]!.push(...expected[index]!); expected.splice(index, 1);
  } else if (action === 'insert' || action === 'copy') {
    const content = action === 'copy' ? markdown.source.slice(part.from, part.to) : '\n\n&nbsp;\n\n';
    nextSource = replace(part.to, part.to, `\n\n---\n\n${content}`); focus = block.to + 1;
    expected.splice(index + 1, 0, action === 'copy' ? [...expected[index]!] : [state.schema.nodes.paragraph!.create()]);
  } else if (action === 'delete') {
    if (blocks.length === 1) { nextSource = ''; focus = 0; expected[0] = [state.schema.nodes.paragraph!.create()]; }
    else if (index === 0) { nextSource = replace(part.from, rules[0]!.end, ''); focus = 0; }
    else { nextSource = replace(rules[index - 1]!.start, part.to, ''); focus = blocks[index - 1]!.from; }
    if (blocks.length > 1) expected.splice(index, 1);
  } else {
    const target = action === 'up' ? index - 1 : action === 'down' ? index + 1 : destination;
    if (target === undefined || target < 0 || target >= blocks.length || target === index) return null;
    const order = parts.map((_, i) => i); order.splice(index, 1); order.splice(target, 0, index);
    // 分隔线沿用原位置的写法，块内容以原文切片移动。
    nextSource = order.map((original, i) => {
      let content = markdown.source.slice(parts[original]!.from, parts[original]!.to);
      if (original !== i) {
        if (i > 0 && !/^[ \t\r]*\n[ \t\r]*\n/.test(content)) content = '\n\n' + content;
        if (i < rules.length && !/\n[ \t\r]*\n[ \t\r]*$/.test(content)) content += '\n\n';
      }
      return content + (rules[i] ? markdown.source.slice(rules[i]!.start, rules[i]!.end) : '');
    }).join('');
    expected.splice(target, 0, expected.splice(index, 1)[0]!);
    const parsed = parseNoteMarkdown(nextSource, state.schema); focus = noteBlocks(parsed.doc)[target]?.from ?? 0;
  }
  const next = parseNoteMarkdown(nextSource, state.schema);
  if (action !== 'split') {
    const content = expected.flatMap((nodes, i) => i ? [state.schema.nodes.horizontalRule!.create(), ...nodes] : nodes);
    const intended = state.schema.nodes.doc!.create(null, content.length ? content : state.schema.nodes.paragraph!.create());
    if (action === 'merge') {
      // 合并后相邻列表可以按普通 Markdown 合为一个列表；只核对未参与合并的块。
      const merged = noteBlocks(next.doc);
      const same = (left: number, right: number) => Fragment.fromArray(blocks[left]!.nodes.map(({ node }) => node)).eq(Fragment.fromArray(merged[right]!.nodes.map(({ node }) => node)));
      if (merged.length !== blocks.length - 1 || blocks.some((_, i) => i < index - 1 ? !same(i, i) : i > index ? !same(i, i - 1) : false)) throw new Error('块边界无法无损保存');
    } else if (!next.doc.eq(intended)) throw new Error('块边界无法无损保存');
  }
  if (action !== 'split') {
    // 只替换实际变化的文档范围，保留无关节点和 ProseMirror 的位置映射。
    const start = state.doc.content.findDiffStart(next.doc.content);
    const end = state.doc.content.findDiffEnd(next.doc.content);
    if (start !== null && end) {
      const overlap = start - Math.min(end.a, end.b);
      tr.replace(start, end.a + Math.max(0, overlap), next.doc.slice(start, end.b + Math.max(0, overlap)));
    } else if (nextSource === markdown.source) return null;
  }
  if (!tr.doc.eq(next.doc)) return null;
  tr.step(new NoteBlockSourceStep(markdown.source, nextSource));
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(focus, tr.doc.content.size)), 1));
  return tr.scrollIntoView();
}

export function runNoteBlockAction(editor: Editor, markdown: NoteMarkdown | null, action: NoteBlockAction | 'move', index: number, blocked: boolean, destination?: number): boolean {
  if (!editor.isEditable || blocked || !markdown) return false;
  const tr = noteBlockTransaction(editor.state, markdown, action, index, content => editor.markdown!.serialize(content), destination);
  if (!tr) return false;
  const before = editor.state;
  editor.view.dispatch(tr);
  if (editor.state === before) return false;
  editor.view.dispatch(closeHistory(editor.state.tr).setMeta('addToHistory', false));
  editor.view.focus(); return true;
}
