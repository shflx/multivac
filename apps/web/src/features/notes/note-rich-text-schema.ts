import { Node, mergeAttributes } from '@tiptap/core';
import { ListItem } from '@tiptap/extension-list';
import { StarterKit } from '@tiptap/starter-kit';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Markdown } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { toggleNoteTextMark } from './note-text-formatting.js';

const NoteStarterKit = StarterKit.extend({
  addExtensions() {
    return (this.parent?.() ?? []).map(extension => {
      // 显式换行在段尾及空段落中也能回读；不依赖下一行必须有文字。
      if (extension.name === 'hardBreak') return extension.extend({ renderMarkdown: () => '<br />' });
      if (extension.name === 'bold' || extension.name === 'italic') {
        const name = extension.name;
        return extension.extend({ addCommands() {
          return { ...this.parent?.(), [name === 'bold' ? 'toggleBold' : 'toggleItalic']: () => toggleNoteTextMark(name) };
        } });
      }
      return extension;
    });
  },
});

const NoteImageUpload = Node.create({
  name: 'noteImageUpload', group: 'inline', inline: true, atom: true,
  addAttributes: () => ({ id: { default: '' }, alt: { default: '' } }),
  parseHTML: () => [],
  renderHTML: () => ['span', { 'data-note-upload': '', class: 'note-image-placeholder' }, '图片上传中…'],
  renderMarkdown: () => '',
});
const NoteImage = Node.create({
  name: 'noteImage', group: 'inline', inline: true, atom: true,
  addAttributes: () => ({ src: { default: '' }, alt: { default: '' }, title: { default: null } }),
  parseHTML: () => [{ tag: 'span[data-note-image]' }],
  renderHTML: ({ node }) => ['span', { 'data-note-image': '', class: 'note-image-placeholder', role: 'img', 'aria-label': `图片：${String(node.attrs.alt)}` }, `图片 · ${String(node.attrs.alt || '未命名')}`],
  renderMarkdown: node => `![${String(node.attrs?.alt ?? '').replace(/[\\\[\]]/g, '\\$&')}](${String(node.attrs?.src ?? '').replace(/[()\s]/g, character => encodeURIComponent(character))}${node.attrs?.title ? ` "${String(node.attrs.title).replace(/["\\]/g, '\\$&')}"` : ''})`,
});
function rawMarkdown(inline: boolean) {
  return Node.create({
    name: inline ? 'noteRawInline' : 'noteRawBlock', group: inline ? 'inline' : 'block', inline, atom: true,
    addAttributes: () => ({ source: { default: '' } }),
    parseHTML: () => [{ tag: inline ? 'span[data-note-raw]' : 'pre[data-note-raw]' }],
    renderHTML: ({ node, HTMLAttributes }) => [inline ? 'span' : 'pre', mergeAttributes(HTMLAttributes, { 'data-note-raw': '', class: 'note-raw-markdown', title: '保留的 Markdown 原文' }), String(node.attrs.source)],
    renderMarkdown: node => String(node.attrs?.source ?? ''),
  });
}
export const noteRichTextExtensions = [
  NoteStarterKit.configure({ paragraph: false, codeBlock: false, listItem: false, underline: false, trailingNode: false, link: { openOnClick: false, autolink: false, linkOnPaste: false, HTMLAttributes: { target: null, rel: 'noopener noreferrer' } } }),
  Paragraph.extend({ renderMarkdown: (node, helpers) => {
    if (!node.content?.length) return '&nbsp;';
    // 文本节点中的块级符号尚未触发输入规则时，必须作为字面文字保存。
    let text = helpers.renderChildren(node.content)
      .replace(/^([ \t]{0,3})(#{1,6}|[>+\-])(?=[ \t]|$)/gm, '$1\\$2')
      .replace(/^([ \t]{0,3}\d{1,9})([.)])(?=[ \t]|$)/gm, '$1\\$2')
      .replace(/^([ \t]{0,3})(=+|-+)(?=[ \t]*$)/gm, '$1\\$2');
    const spaces = (value: string) => value.replace(/ /g, '&#32;').replace(/\t/g, '&#9;');
    text = text.replace(/^[ \t]+/, spaces);
    const trailing = /[ \t]+$/.exec(text);
    if (trailing && trailing.index + trailing[0].length === text.length) text = text.slice(0, trailing.index) + spaces(trailing[0]);
    return text;
  } }),
  CodeBlock.extend({ renderMarkdown: (node, helpers) => {
    const code = helpers.renderChildren(node.content ?? []);
    const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map(run => run.length));
    const fence = '`'.repeat(longest + 1);
    return `${fence}${String(node.attrs?.language ?? '').replace(/[\r\n`]/g, '')}\n${code}\n${fence}`;
  } }),
  ListItem.extend({ content: 'block+' }),
  Markdown, TableKit.configure({ table: { resizable: false } }), TaskList, TaskItem.extend({ content: 'block+' }).configure({ nested: true }), NoteImage, NoteImageUpload, rawMarkdown(false), rawMarkdown(true),
];
