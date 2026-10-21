import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { Extension, type JSONContent } from '@tiptap/core';
import { NoteImageUploads } from './note-image-uploads.js';
import { noteWithoutUploads, noteUploadCount, notePositionWithoutUploads } from './note-image-editing.js';
import { ImagePreview, type ImageSource } from '../assistant/image-gallery.js';
import { Plugin, EditorState, AllSelection, Selection } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import { Slice } from '@tiptap/pm/model';
import { Bold, Italic, Strikethrough, List, ListOrdered, Quote, Code, Undo2, Redo2, ImagePlus } from 'lucide-react';
import { NOTE_BODY_LIMIT, type NoteSelection } from '@multivac/contracts';
import { parseNoteMarkdown, updateNoteMarkdown, noteMarkdownSelection, type NoteMarkdown } from './note-markdown.js';

export function NoteRichText({ noteId, body, disabled, active = true, elementRef, imageInputRef, onUploadsChange, onReady, onChange, onSelection, onError, previewRoot }: {
  noteId: string; body: string; disabled: boolean; active?: boolean; elementRef: RefObject<HTMLDivElement | null>;
  imageInputRef?: RefObject<((files: File[]) => void) | null>; onUploadsChange?(count: number): void; previewRoot?: HTMLElement | null;
  onReady(editor: Editor | null): void; onChange(body: string): void; onSelection(selection: NoteSelection | null): void; onError(message: string): void;
}) {
  const props = useRef({ body, disabled, onChange, onSelection, onError, onUploadsChange });
  props.current = { body, disabled, onChange, onSelection, onError, onUploadsChange };
  const [preview, setPreview] = useState<ImageSource | null>(null);
  const [images] = useState(() => new NoteImageUploads(noteId, () => !props.current.disabled, setPreview, message => props.current.onError(message)));
  const source = useRef<NoteMarkdown | null>(null);
  const pending = useRef(new WeakMap<Transaction, NoteMarkdown>());
  const editor = useEditor({
    extensions: [...images.extensions(), Extension.create({
      name: 'noteSourceProtection',
      addKeyboardShortcuts() {
        const collapse = (end: boolean) => {
          if (!(this.editor.state.selection instanceof AllSelection)) return false;
          return this.editor.commands.command(({ tr }) => {
            tr.setSelection(end ? Selection.atEnd(tr.doc) : Selection.atStart(tr.doc));
            return true;
          });
        };
        const move = (end: boolean) => this.editor.commands.command(({ tr }) => {
          tr.setSelection(end ? Selection.atEnd(tr.doc) : Selection.atStart(tr.doc)).scrollIntoView();
          return true;
        });
        return { ArrowLeft: () => collapse(false), ArrowRight: () => collapse(true), 'Mod-Home': () => move(false), 'Mod-End': () => move(true) };
      },
      addProseMirrorPlugins() {
        const owner = this.editor;
        return [new Plugin({
          filterTransaction(transaction) {
            if (!transaction.docChanged || !source.current) return true;
            if (props.current.disabled) return false;
            try {
              const pasted = transaction.getMeta('note-markdown-paste') as NoteMarkdown | undefined;
              const doc = noteWithoutUploads(transaction.doc);
              const next = pasted?.doc.eq(doc) ? pasted : updateNoteMarkdown(source.current, doc, content => owner.markdown!.serialize(content));
              if (next.source.length > NOTE_BODY_LIMIT) { props.current.onError(`正文不能超过 ${NOTE_BODY_LIMIT.toLocaleString()} 个字符，刚才的修改未写入。`); return false; }
              pending.current.set(transaction, next);
              return true;
            } catch {
              props.current.onError('这次正文修改未能转换为 Markdown，原内容已保留。');
              return false;
            }
          },
        })];
      },
    })],
    editable: !disabled,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: 'note-rich-editor markdown-body', role: 'textbox', 'aria-label': '笔记正文', 'aria-multiline': 'true', 'aria-readonly': disabled ? 'true' : 'false', spellcheck: 'false', 'data-placeholder': '从这里开始记录…' },
      clipboardTextSerializer(slice, view) {
        const node = slice.content.firstChild;
        let plain = slice.content.childCount === 1 && node?.type.name === 'paragraph';
        node?.forEach(child => { if (!child.isText || child.marks.length) plain = false; });
        if (plain) return slice.content.textBetween(0, slice.content.size, '\n\n');
        const owner = (view.dom as HTMLElement & { editor: Editor }).editor;
        return owner.markdown!.serialize({ type: 'doc', content: (slice.content.toJSON() ?? []) as JSONContent[] });
      },
      handlePaste(view, event) {
        if (props.current.disabled) return true;
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length) { images.insert(files); return true; }
        const value = event.clipboardData?.getData('text/plain');
        if (!value) return !!event.clipboardData?.getData('text/html');
        // 只解析纯文本 Markdown；粘贴不执行 HTML，也不自动加载外部图片。
        const parsed = parseNoteMarkdown(value, view.state.schema);
        view.dispatch(view.state.tr.replaceSelection(Slice.maxOpen(parsed.doc.content)).setMeta('note-markdown-paste', parsed).scrollIntoView());
        return true;
      },
      handleDrop(view, event, _slice, moved) {
        if (moved || !event.dataTransfer?.files.length) return false;
        const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        if (position !== undefined) images.insert(Array.from(event.dataTransfer.files), position);
        return true;
      },
    },
    onUpdate({ editor, transaction, appendedTransactions }) {
      const doc = noteWithoutUploads(editor.state.doc);
      const applied = [transaction, ...appendedTransactions].map(item => pending.current.get(item)).findLast(item => item?.doc.eq(doc));
      const next = applied ?? updateNoteMarkdown(source.current!, doc, content => editor.markdown!.serialize(content));
      source.current = next;
      props.current.onUploadsChange?.(noteUploadCount(editor.state.doc));
      props.current.onChange(next.source);
      const { from, to } = editor.state.selection;
      props.current.onSelection(noteMarkdownSelection(next, notePositionWithoutUploads(editor.state.doc, from), notePositionWithoutUploads(editor.state.doc, to)));
    },
    onSelectionUpdate({ editor }) {
      const { from, to } = editor.state.selection;
      props.current.onSelection(source.current ? noteMarkdownSelection(source.current, notePositionWithoutUploads(editor.state.doc, from), notePositionWithoutUploads(editor.state.doc, to)) : null);
    },
  });
  useLayoutEffect(() => {
    if (!editor || source.current?.source === body) return;
    const parsed = parseNoteMarkdown(body, editor.schema);
    source.current = parsed;
    // 服务端版本、历史恢复或草稿载入建立新基线；撤销不能穿过基线回到旧服务端内容。
    editor.view.updateState(EditorState.create({ doc: parsed.doc, plugins: editor.state.plugins }));
    editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false));
    props.current.onSelection(null);
    props.current.onUploadsChange?.(0);
  }, [editor, body]);
  useLayoutEffect(() => {
    if (!editor) return;
    images.attach(editor);
    if (imageInputRef) imageInputRef.current = files => images.insert(files);
    elementRef.current = editor.view.dom as HTMLDivElement;
    onReady(editor);
    return () => { images.dispose(); if (imageInputRef) imageInputRef.current = null; elementRef.current = null; onReady(null); };
  }, [editor, elementRef, onReady, images, imageInputRef]);
  useLayoutEffect(() => { editor?.setEditable(!disabled, false); }, [editor, disabled]);
  useLayoutEffect(() => { if (!active) setPreview(null); }, [active]);
  return <><EditorContent editor={editor} />{preview && active && <ImagePreview sources={[preview]} start={0} close={() => setPreview(null)} portalRoot={previewRoot ?? null} />}</>;
}

export function NoteRichTextTools({ editor, disabled = false, onImages }: { editor: Editor | null; disabled?: boolean; onImages?(files: File[]): void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const state = useEditorState({ editor, selector: ({ editor }) => editor ? {
    bold: editor.isActive('bold'), italic: editor.isActive('italic'), strike: editor.isActive('strike'), code: editor.isActive('code'),
    bullet: editor.isActive('bulletList'), ordered: editor.isActive('orderedList'), quote: editor.isActive('blockquote'),
    heading: editor.isActive('heading') ? String(editor.getAttributes('heading').level) : '0',
    undo: editor.can().undo(), redo: editor.can().redo(), editable: editor.isEditable,
  } : null });
  const buttons = [
    { label: '粗体', icon: Bold, active: state?.bold, run: () => editor?.chain().focus().toggleBold().run() },
    { label: '斜体', icon: Italic, active: state?.italic, run: () => editor?.chain().focus().toggleItalic().run() },
    { label: '删除线', icon: Strikethrough, active: state?.strike, run: () => editor?.chain().focus().toggleStrike().run() },
    { label: '行内代码', icon: Code, active: state?.code, run: () => editor?.chain().focus().toggleCode().run() },
    { label: '无序列表', icon: List, active: state?.bullet, run: () => editor?.chain().focus().toggleBulletList().run() },
    { label: '有序列表', icon: ListOrdered, active: state?.ordered, run: () => editor?.chain().focus().toggleOrderedList().run() },
    { label: '引用段落', icon: Quote, active: state?.quote, run: () => editor?.chain().focus().toggleBlockquote().run() },
  ];
  return <div className="note-format-tools" role="group" aria-label="正文格式">
    <select aria-label="段落样式" disabled={disabled || !state?.editable} value={state?.heading ?? '0'} onChange={event => {
      const level = Number(event.target.value);
      if (level === 0) editor?.chain().focus().setParagraph().run();
      else editor?.chain().focus().setHeading({ level: level as 1 | 2 | 3 }).run();
    }}><option value="0">正文</option>{[1, 2, 3, 4, 5, 6].map(level => <option key={level} value={String(level)}>标题 {level}</option>)}</select>
    {onImages && <><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden aria-label="选择笔记图片" onChange={event => { onImages(Array.from(event.target.files ?? [])); event.target.value = ''; }} /><button type="button" aria-label="插入图片" title="插入图片" disabled={disabled || !state?.editable} onMouseDown={event => event.preventDefault()} onClick={() => fileInput.current?.click()}><ImagePlus size={15} aria-hidden="true" /></button></>}
    {buttons.map(button => <button key={button.label} type="button" aria-label={button.label} title={button.label} aria-pressed={!!button.active} disabled={disabled || !state?.editable} onMouseDown={event => event.preventDefault()} onClick={button.run}><button.icon size={15} aria-hidden="true" /></button>)}
    <button type="button" aria-label="撤销正文修改" title="撤销（Ctrl/⌘+Z）" disabled={disabled || !state?.editable || !state.undo} onMouseDown={event => event.preventDefault()} onClick={() => editor?.chain().focus().undo().run()}><Undo2 size={15} aria-hidden="true" /></button>
    <button type="button" aria-label="重做正文修改" title="重做" disabled={disabled || !state?.editable || !state.redo} onMouseDown={event => event.preventDefault()} onClick={() => editor?.chain().focus().redo().run()}><Redo2 size={15} aria-hidden="true" /></button>
  </div>;
}
