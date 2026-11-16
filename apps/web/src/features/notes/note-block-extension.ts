import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { NoteBlockAction } from './note-block-commands.js';
import { loadNoteBlocks, noteBlocks, noteBlocksKey } from './note-blocks.js';

export const noteBlocksPlugin = new PluginKey<boolean>('noteBlocks');
export function toggleNoteBlocks(editor: Editor, noteId: string): boolean {
  const enabled = !noteBlocksPlugin.getState(editor.state);
  editor.view.dispatch(editor.state.tr.setMeta(noteBlocksPlugin, enabled).setMeta('addToHistory', false));
  try { localStorage.setItem(noteBlocksKey(noteId), String(enabled)); return true; } catch { return false; }
}

export function noteBlockExtension(noteId: string, run: (action: NoteBlockAction, index: number) => boolean, blocked: () => boolean) {
  return Extension.create({
    name: 'noteBlocks',
    addKeyboardShortcuts() {
      const current = () => noteBlocks(this.editor.state.doc).find(block => this.editor.state.selection.from >= block.from && this.editor.state.selection.from <= block.to);
      const action = (name: NoteBlockAction) => {
        const block = current();
        return !!noteBlocksPlugin.getState(this.editor.state) && !!block && run(name, block.index);
      };
      return {
        'Mod-Shift-Enter': () => action('split'),
        'Alt-ArrowUp': () => action('up'),
        'Alt-ArrowDown': () => action('down'),
        Backspace: () => {
          const { selection } = this.editor.state, block = current();
          if (!noteBlocksPlugin.getState(this.editor.state) || !block?.index || !selection.empty || selection.from !== block.from + 1) return false;
          return run('merge', block.index);
        },
      };
    },
    addProseMirrorPlugins() {
      const owner = this.editor;
      let cached: { state: EditorState; blocked: boolean; decorations: DecorationSet } | undefined;
      return [new Plugin<boolean>({
        key: noteBlocksPlugin,
        state: {
          init: () => loadNoteBlocks(noteId),
          apply: (tr, enabled) => typeof tr.getMeta(noteBlocksPlugin) === 'boolean' ? tr.getMeta(noteBlocksPlugin) as boolean : enabled,
        },
        props: {
          decorations(state) {
            if (!noteBlocksPlugin.getState(state)) return DecorationSet.empty;
            const unavailable = !owner.isEditable || blocked();
            if (cached && cached.state.doc === state.doc && cached.state.selection.eq(state.selection) && cached.blocked === unavailable) return cached.decorations;
            const decorations: Decoration[] = [];
            const blocks = noteBlocks(state.doc);
            for (const block of blocks) {
              decorations.push(Decoration.widget(block.from, view => {
                const chrome = document.createElement('span'); chrome.className = 'note-block-chrome'; chrome.contentEditable = 'false';
                chrome.dataset.block = String(block.index);
                const menu = document.createElement('details'); menu.className = 'note-block-menu';
                const trigger = document.createElement('summary'); trigger.addEventListener('mousedown', event => event.preventDefault()); trigger.textContent = '···'; trigger.setAttribute('aria-label', `块 ${block.index + 1} 操作`);
                const items = document.createElement('span'); items.className = 'note-block-menu-items'; items.setAttribute('role', 'group'); items.setAttribute('aria-label', '块操作');
                const actions: [NoteBlockAction, string][] = [['insert', '在下方插入块'], ['split', '在光标处拆分'], ['merge', '与上一块合并'], ['up', '上移'], ['down', '下移'], ['copy', '复制块'], ['delete', '删除块']];
                for (const [action, label] of actions) {
                  const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
                  button.disabled = !view.editable || blocked() || (action === 'merge' || action === 'up') && block.index === 0 || action === 'down' && block.index === blocks.length - 1 || action === 'split' && (state.selection.from < block.from || state.selection.to > block.to || !state.selection.empty);
                  button.addEventListener('mousedown', event => event.preventDefault());
                  button.addEventListener('click', () => { menu.open = false; run(action, block.index); });
                  items.append(button);
                }
                menu.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menu.open = false; trigger.focus(); } });
                menu.append(trigger, items); chrome.append(menu); return chrome;
              }, { side: -1, stopEvent: () => true }));
              if (block.index < blocks.length - 1) decorations.push(Decoration.widget(block.to, view => {
                const gap = document.createElement('span'); gap.className = 'note-block-insert'; gap.contentEditable = 'false';
                const button = document.createElement('button'); button.type = 'button'; button.textContent = '+ 插入块'; button.setAttribute('aria-label', `在块 ${block.index + 1} 后插入`); button.disabled = !view.editable || blocked();
                button.addEventListener('mousedown', event => event.preventDefault()); button.addEventListener('click', () => run('insert', block.index)); gap.append(button); return gap;
              }, { side: -1, stopEvent: () => true }));
              const focused = state.selection.from >= block.from && state.selection.from <= block.to;
              block.nodes.forEach(({ node, pos }, index) => decorations.push(Decoration.node(pos, pos + node.nodeSize, {
                class: ['note-block-node', index === 0 ? 'note-block-first' : '', index === block.nodes.length - 1 ? 'note-block-last' : '', focused ? 'note-block-focused' : ''].filter(Boolean).join(' '),
                'data-note-block': String(block.index),
              })));
              if (!block.nodes.length) decorations.push(Decoration.widget(block.from, view => {
                const placeholder = document.createElement('button');
                placeholder.type = 'button'; placeholder.className = 'note-block-empty';
                placeholder.textContent = '空块 · 点击开始输入'; placeholder.disabled = !view.editable || blocked();
                placeholder.setAttribute('data-note-block', String(block.index));
                placeholder.addEventListener('mousedown', event => event.preventDefault());
                placeholder.addEventListener('click', () => run('activate', block.index));
                return placeholder;
              }, { side: -1, stopEvent: () => true }));
              if (block.index < blocks.length - 1) decorations.push(Decoration.node(block.to, block.to + 1, { class: 'note-block-boundary' }));
            }
            const result = DecorationSet.create(state.doc, decorations);
            cached = { state, blocked: unavailable, decorations: result };
            return result;
          },
        },
      })];
    },
  });
}
