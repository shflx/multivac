import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { closeHistory } from '@tiptap/pm/history';
import { loadNoteBlocks, noteBlocks, noteBlocksKey } from './note-blocks.js';

export const noteBlocksPlugin = new PluginKey<boolean>('noteBlocks');
export function toggleNoteBlocks(editor: Editor, noteId: string): boolean {
  const enabled = !noteBlocksPlugin.getState(editor.state);
  editor.view.dispatch(editor.state.tr.setMeta(noteBlocksPlugin, enabled).setMeta('addToHistory', false));
  try { localStorage.setItem(noteBlocksKey(noteId), String(enabled)); return true; } catch { return false; }
}

export function noteBlockExtension(noteId: string) {
  return Extension.create({
    name: 'noteBlocks',
    addProseMirrorPlugins() {
      return [new Plugin<boolean>({
        key: noteBlocksPlugin,
        state: {
          init: () => loadNoteBlocks(noteId),
          apply: (tr, enabled) => typeof tr.getMeta(noteBlocksPlugin) === 'boolean' ? tr.getMeta(noteBlocksPlugin) as boolean : enabled,
        },
        props: {
          decorations(state) {
            if (!noteBlocksPlugin.getState(state)) return DecorationSet.empty;
            const decorations: Decoration[] = [];
            const blocks = noteBlocks(state.doc);
            for (const block of blocks) {
              const focused = state.selection.from >= block.from && state.selection.from <= block.to;
              block.nodes.forEach(({ node, pos }, index) => decorations.push(Decoration.node(pos, pos + node.nodeSize, {
                class: ['note-block-node', index === 0 ? 'note-block-first' : '', index === block.nodes.length - 1 ? 'note-block-last' : '', focused ? 'note-block-focused' : ''].filter(Boolean).join(' '),
                'data-note-block': String(block.index),
              })));
              if (!block.nodes.length) decorations.push(Decoration.widget(block.from, view => {
                const placeholder = document.createElement('button');
                placeholder.type = 'button'; placeholder.className = 'note-block-empty';
                placeholder.textContent = '空块 · 点击开始输入'; placeholder.disabled = !view.editable;
                placeholder.setAttribute('data-note-block', String(block.index));
                placeholder.addEventListener('click', () => {
                  if (!view.editable) return;
                  const tr = closeHistory(view.state.tr).insert(block.from, view.state.schema.nodes.paragraph!.create());
                  view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(block.from + 1))).scrollIntoView()); view.focus();
                });
                return placeholder;
              }, { side: -1, stopEvent: () => true }));
              if (block.index < blocks.length - 1) decorations.push(Decoration.node(block.to, block.to + 1, { class: 'note-block-boundary' }));
            }
            return DecorationSet.create(state.doc, decorations);
          },
        },
      })];
    },
  });
}
