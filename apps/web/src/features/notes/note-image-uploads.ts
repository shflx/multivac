import type { Editor, Node } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Fragment, Slice } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { NOTE_IMAGE_LIMITS, noteImageContentUrl } from '@multivac/contracts';
import { uploadNoteImage } from '../../data/note-images-api.js';
import { newCommandId } from '../../data/command-id.js';
import { noteRichTextExtensions } from './note-rich-text-schema.js';
import { noteUploadPosition, resolveNoteUpload } from './note-image-editing.js';
import type { ImageSource } from '../assistant/image-gallery.js';

type Upload = { file?: File; imageId?: string; error?: string; controller?: AbortController; listeners: Set<() => void> };

/** 每个编辑器拥有自己的上传账本，回执只替换同一编辑器内仍存在的原占位。 */
export class NoteImageUploads {
  editor: Editor | null = null;
  private readonly jobs = new Map<string, Upload>();
  private disposed = false;
  constructor(private readonly noteId: string, private readonly editable: () => boolean, private readonly preview: (source: ImageSource) => void, private readonly error: (message: string) => void) {}

  attach(editor: Editor): void { this.editor = editor; this.disposed = false; }

  extensions() {
    const host = this;
    return noteRichTextExtensions.map(extension => {
      if (extension.name === 'noteImage') return (extension as Node).extend({
        addNodeView() {
          return ({ node }) => {
            const dom = document.createElement('span');
            dom.className = 'note-image'; dom.contentEditable = 'false';
            const url = noteImageContentUrl(host.noteId, String(node.attrs.src));
            if (!url) {
              dom.className = 'note-image-placeholder'; dom.textContent = `图片 · ${String(node.attrs.alt || '外部来源')}（保留原文，不自动加载）`;
              return { dom };
            }
            const button = document.createElement('button'); button.type = 'button';
            button.setAttribute('aria-label', `查看图片 ${String(node.attrs.alt || '笔记图片')}`);
            const image = document.createElement('img'); image.alt = String(node.attrs.alt || '笔记图片');
            image.referrerPolicy = 'no-referrer'; image.draggable = false;
            const status = document.createElement('span'); status.setAttribute('role', 'status');
            const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试加载'; retry.hidden = true;
            const load = () => { retry.hidden = true; button.disabled = true; status.textContent = '图片加载中…'; image.src = url; };
            image.onload = () => { button.disabled = false; status.textContent = ''; };
            image.onerror = () => { retry.hidden = false; status.textContent = '图片加载失败'; };
            retry.onclick = load;
            button.onclick = () => { button.focus({ preventScroll: true }); host.preview({ url, alt: image.alt }); };
            button.append(image); dom.append(button, status, retry); load();
            return { dom, stopEvent: event => event.target instanceof Element && !!event.target.closest('button'), ignoreMutation: () => true };
          };
        },
      });
      if (extension.name === 'noteImageUpload') return (extension as Node).extend({
        addNodeView() {
          return ({ node, getPos, editor }) => {
            const id = String(node.attrs.id);
            const dom = document.createElement('span'); dom.className = 'note-image-upload'; dom.contentEditable = 'false';
            const label = document.createElement('span'); label.setAttribute('role', 'status');
            const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试上传';
            const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除图片';
            const job = host.jobs.get(id);
            const render = () => {
              label.textContent = `${String(node.attrs.alt || '图片')} · ${job?.error || (job?.imageId ? '上传完成' : job?.controller ? '上传中…' : job?.file ? '等待上传' : '请重新选择图片')}`;
              retry.hidden = !job?.file || !!job.controller; retry.disabled = !host.editable();
              remove.disabled = !host.editable();
            };
            retry.onclick = () => { if (host.editable()) void host.start(id); };
            remove.onclick = () => { const position = getPos(); if (host.editable() && typeof position === 'number') editor.view.dispatch(closeHistory(editor.state.tr).delete(position, position + 1)); };
            dom.append(label, retry, remove); job?.listeners.add(render); render();
            return { dom, stopEvent: () => true, ignoreMutation: () => true, destroy: () => { job?.listeners.delete(render); } };
          };
        },
        addProseMirrorPlugins() {
          return [new Plugin({
            appendTransaction(_transactions, _oldState, state) {
              const transaction = state.tr;
              state.doc.descendants(node => {
                if (node.type.name !== 'noteImageUpload') return;
                const id = String(node.attrs.id), imageId = host.jobs.get(id)?.imageId;
                if (imageId) resolveNoteUpload(transaction, id, imageId);
              });
              return transaction.docChanged ? transaction : null;
            },
          })];
        },
      });
      return extension;
    });
  }

  insert(files: File[], position?: number): void {
    const editor = this.editor;
    if (!editor || this.disposed || !this.editable() || !files.length) return;
    const accepted = files.filter(file => {
      if (!file.size || file.size > NOTE_IMAGE_LIMITS.bytes) { this.error(`${file.name}：单图须为 1 字节至 10 MiB。`); return false; }
      return true;
    });
    if (accepted.length > NOTE_IMAGE_LIMITS.count) { this.error('一次最多插入 200 张图片。'); return; }
    const held = [...this.jobs.values()].filter(job => job.file);
    if (held.length + accepted.length > NOTE_IMAGE_LIMITS.count || held.reduce((sum, job) => sum + job.file!.size, 0) + accepted.reduce((sum, file) => sum + file.size, 0) > NOTE_IMAGE_LIMITS.totalBytes) {
      this.error('待处理图片最多 200 张、总计 100 MiB，请先完成或重新打开笔记再上传。'); return;
    }
    const ids = accepted.map(file => {
      const id = newCommandId(); this.jobs.set(id, { file, listeners: new Set() }); return id;
    });
    const transaction = closeHistory(editor.state.tr);
    const nodes = ids.map((id, index) => editor.schema.nodes.noteImageUpload!.create({ id, alt: accepted[index]!.name || '截图' }));
    if (!nodes.length) return;
    const content = Fragment.fromArray(nodes);
    if (position === undefined) transaction.replaceSelection(new Slice(content, 0, 0));
    else transaction.insert(position, content);
    editor.view.dispatch(transaction.scrollIntoView());
    editor.view.dispatch(closeHistory(editor.state.tr).setMeta('addToHistory', false));
    // 单批顺序上传，避免大批图片同时解码占满内存；各项独立成功或失败。
    void (async () => { for (const id of ids) { if (this.disposed) break; await this.start(id); } })();
  }
  private async start(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job?.file || job.controller || this.disposed || !this.editable()) return;
    if (!this.editor || noteUploadPosition(this.editor.state.doc, id) === null) return;
    const controller = new AbortController(); job.controller = controller; delete job.error;
    job.listeners.forEach(listener => listener());
    try {
      const image = await uploadNoteImage(this.noteId, job.file, controller.signal);
      if (this.disposed || job.controller !== controller) return;
      job.imageId = image.id; delete job.file;
      const editor = this.editor;
      if (editor && this.editable()) {
        const transaction = editor.state.tr;
        if (resolveNoteUpload(transaction, id, image.id)) editor.view.dispatch(transaction);
      }
    } catch (error) { if (!this.disposed && job.controller === controller) job.error = (error as Error).message; }
    finally { if (job.controller === controller) { delete job.controller; job.listeners.forEach(listener => listener()); } }
  }
  dispose(): void {
    this.disposed = true; this.editor = null;
    for (const job of this.jobs.values()) { job.controller?.abort(); job.listeners.clear(); }
    this.jobs.clear();
  }
}
