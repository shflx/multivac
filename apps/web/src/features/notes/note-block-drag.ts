import type { Node as DocumentNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { noteBlocks } from './note-blocks.js';

export function noteBlockDropIndex(source: number, boundary: number, count: number): number | null {
  if (source < 0 || source >= count || boundary < 0 || boundary > count) return null;
  const target = boundary > source ? boundary - 1 : boundary;
  return target === source ? null : target;
}

/** 只认当前编辑器内由块手柄开始的拖动，不接管文件或正文选区拖放。 */
export class NoteBlockDrag {
  private source: { index: number; doc: DocumentNode } | null = null;
  private boundary: number | null = null;
  private line: HTMLDivElement | null = null;
  constructor(private readonly blocked: () => boolean, private readonly move: (index: number, target: number) => boolean) {}

  start(view: EditorView, index: number, event: DragEvent) {
    if (!view.editable || this.blocked() || !event.dataTransfer || matchMedia('(pointer: coarse)').matches) { event.preventDefault(); return; }
    this.source = { index, doc: view.state.doc };
    event.dataTransfer.setData('application/x-multivac-note-block', String(index)); event.dataTransfer.effectAllowed = 'move';
  }
  over(view: EditorView, event: DragEvent): boolean {
    if (!this.source || event.dataTransfer?.files.length || !view.editable || this.blocked() || view.state.doc !== this.source.doc) { this.clear(); return false; }
    const blocks = noteBlocks(view.state.doc);
    const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
    if (at === undefined) return false;
    const block = blocks.find(block => at >= block.from && at <= block.to) ?? blocks.find(block => at < block.from) ?? blocks.at(-1)!;
    const first = view.dom.querySelector<HTMLElement>(`[data-note-block="${block.index}"]`);
    const all = view.dom.querySelectorAll<HTMLElement>(`[data-note-block="${block.index}"]`);
    const last = all.item(all.length - 1);
    if (!first || !last) return false;
    const top = first.getBoundingClientRect(), bottom = last.getBoundingClientRect();
    const after = event.clientY >= (top.top + bottom.bottom) / 2;
    this.boundary = block.index + (after ? 1 : 0);
    if (!this.line) { this.line = document.createElement('div'); this.line.className = 'note-block-drop-line'; this.line.setAttribute('aria-hidden', 'true'); view.dom.parentElement!.append(this.line); }
    Object.assign(this.line.style, { left: `${top.left}px`, width: `${top.width}px`, top: `${after ? bottom.bottom + 8 : top.top - 8}px` });
    event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; return true;
  }
  drop(view: EditorView, event: DragEvent): boolean {
    const source = this.source, boundary = this.boundary;
    const accepted = !!source && !event.dataTransfer?.files.length;
    this.clear();
    if (!accepted || !source) return false;
    event.preventDefault();
    if (!view.editable || this.blocked() || source.doc !== view.state.doc || boundary === null) return true;
    const target = noteBlockDropIndex(source.index, boundary, noteBlocks(view.state.doc).length);
    if (target !== null) this.move(source.index, target);
    return true;
  }
  clear() { this.source = null; this.boundary = null; this.line?.remove(); this.line = null; }
}
