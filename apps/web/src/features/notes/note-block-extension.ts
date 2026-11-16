import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { NoteBlockDrag } from './note-block-drag.js';
import type { NoteBlockAction } from './note-block-commands.js';
import { loadNoteBlockFolds, noteBlockFoldsKey, noteBlockPreview, reconcileNoteBlockFolds } from './note-block-folding.js';
import { loadNoteBlocks, noteBlocks, noteBlocksKey } from './note-blocks.js';

interface BlockDisplay { enabled: boolean; folded: Set<string> }
// 控件消费按钮交互；拖放仍交给编辑器处理块排序和图片上传。
const stopBlockControlEvent = (event: Event) => !['dragover', 'drop', 'dragend'].includes(event.type);

/** 菜单在正文滚动区内选择空间较充足的一侧，长菜单自身滚动。 */
function fitBlockMenu(trigger: HTMLElement, items: HTMLElement) {
  const regions = ['.note-document-scroll', '.notes-detail'].map(selector => trigger.closest(selector)?.getBoundingClientRect());
  const top = Math.max(0, ...regions.map(rect => rect?.top ?? 0)) + 8;
  const bottom = Math.min(window.innerHeight, ...regions.map(rect => rect?.bottom ?? window.innerHeight)) - 8;
  const anchor = trigger.getBoundingClientRect();
  const below = Math.max(0, bottom - anchor.bottom - 4), above = Math.max(0, anchor.top - top - 4);
  const upward = below < items.scrollHeight && above > below;
  const height = Math.min(items.scrollHeight + 2, upward ? above : below);
  // 浮层脱离正文滚动溢出，按实际 fixed 包含块原点换算坐标，不随容器样式猜测偏移。
  items.style.position = 'fixed';
  items.style.top = '0'; items.style.left = '0';
  items.style.right = 'auto'; items.style.bottom = 'auto';
  const origin = items.getBoundingClientRect();
  items.style.top = `${(upward ? anchor.top - 4 - height : anchor.bottom + 4) - origin.top}px`;
  items.style.left = `${Math.max(8, Math.min(anchor.right - origin.width, window.innerWidth - origin.width - 8)) - origin.left}px`;
  items.style.maxHeight = `${height}px`;
  items.style.overflowY = 'auto';
}
export const noteBlocksPlugin = new PluginKey<BlockDisplay>('noteBlocks');
export function toggleNoteBlocks(editor: Editor, noteId: string): boolean {
  const enabled = !noteBlocksPlugin.getState(editor.state)?.enabled;
  editor.view.dispatch(editor.state.tr.setMeta(noteBlocksPlugin, enabled).setMeta('addToHistory', false));
  try { localStorage.setItem(noteBlocksKey(noteId), String(enabled)); return true; } catch { return false; }
}

export function noteBlockExtension(noteId: string, run: (action: NoteBlockAction | 'move', index: number, destination?: number) => boolean, blocked: () => boolean, preferenceError: (message: string) => void) {
  return Extension.create({
    name: 'noteBlocks',
    addKeyboardShortcuts() {
      const current = () => noteBlocks(this.editor.state.doc).find(block => this.editor.state.selection.from >= block.from && this.editor.state.selection.from <= block.to);
      const action = (name: NoteBlockAction) => {
        const block = current();
        return !!noteBlocksPlugin.getState(this.editor.state)?.enabled && !!block && run(name, block.index);
      };
      return {
        'Mod-f': () => { if (noteBlocksPlugin.getState(this.editor.state)?.enabled) this.editor.view.dispatch(this.editor.state.tr.setMeta('note-block-unfold', 'all').setMeta('addToHistory', false)); return false; },
        'Mod-Shift-Enter': () => action('split'),
        'Alt-ArrowUp': () => action('up'),
        'Alt-ArrowDown': () => action('down'),
        Backspace: () => {
          const { selection } = this.editor.state, block = current();
          if (!noteBlocksPlugin.getState(this.editor.state)?.enabled || !block?.index || !selection.empty) return false;
          const { $from } = selection;
          const firstChildPath = Array.from({ length: Math.max(0, $from.depth - 1) }, (_, i) => $from.index(i + 1)).every(index => index === 0);
          if ($from.depth < 1 || $from.parentOffset !== 0 || $from.before(1) !== block.from || !firstChildPath) return false;
          // 已命中块首合并，即使保存或上传保护拒绝，也不能回退到默认删除边界。
          run('merge', block.index);
          return true;
        },
      };
    },
    addProseMirrorPlugins() {
      const owner = this.editor;
      const drag = new NoteBlockDrag(() => blocked() || !noteBlocksPlugin.getState(owner.state)?.enabled, (index, target) => run('move', index, target));
      let cached: { state: EditorState; folded: Set<string>; blocked: boolean; decorations: DecorationSet } | undefined;
      return [new Plugin<BlockDisplay>({
        key: noteBlocksPlugin,
        state: {
          init: (_config, state) => ({ enabled: loadNoteBlocks(noteId), folded: reconcileNoteBlockFolds(loadNoteBlockFolds(noteId), state.doc) }),
          apply: (tr, display) => {
            const mode = tr.getMeta(noteBlocksPlugin) as unknown;
            let folded = display.folded;
            const toggle = tr.getMeta('note-block-fold') as string | undefined;
            if (toggle) { folded = new Set(folded); if (folded.has(toggle)) folded.delete(toggle); else folded.add(toggle); }
            const unfold = tr.getMeta('note-block-unfold') as number | 'all' | undefined;
            if (unfold === 'all') folded = new Set();
            else if (typeof unfold === 'number') folded = new Set([...folded].filter(key => !key.startsWith(`${unfold}:`)));
            if (tr.docChanged || tr.selectionSet) folded = reconcileNoteBlockFolds(folded, tr.doc, tr.selection);
            return { enabled: typeof mode === 'boolean' ? mode : display.enabled, folded };
          },
        },
        view: view => {
          const refit = () => {
            for (const menu of view.dom.querySelectorAll<HTMLDetailsElement>('.note-block-menu[open]')) {
              fitBlockMenu(menu.querySelector('summary')!, menu.querySelector<HTMLElement>('.note-block-menu-items')!);
            }
          };
          const document = view.dom.ownerDocument;
          document.addEventListener('scroll', refit, true);
          window.addEventListener('resize', refit);
          return {
            update(view, previous) {
              if (noteBlocksPlugin.getState(previous)?.folded === noteBlocksPlugin.getState(view.state)?.folded) return;
              try { localStorage.setItem(noteBlockFoldsKey(noteId), JSON.stringify([...noteBlocksPlugin.getState(view.state)!.folded])); }
              catch { preferenceError('折叠显示已更新，但本机折叠设置未能保存。'); }
            },
            destroy: () => {
              drag.clear();
              document.removeEventListener('scroll', refit, true);
              window.removeEventListener('resize', refit);
            },
          };
        },
        props: {
          handleDOMEvents: {
            pointerover: (view, event) => {
              const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-note-block], .note-block-chrome') : null;
              const index = target?.dataset.noteBlock ?? target?.dataset.block;
              for (const chrome of view.dom.querySelectorAll<HTMLElement>('.note-block-chrome')) chrome.toggleAttribute('data-hovered', chrome.dataset.block === index);
              return false;
            },
            pointerleave: view => { for (const chrome of view.dom.querySelectorAll('.note-block-chrome')) chrome.removeAttribute('data-hovered'); return false; },
            beforematch: (view, event) => {
              const element = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-note-block]') : null;
              if (element) view.dispatch(view.state.tr.setMeta('note-block-unfold', Number(element.dataset.noteBlock)).setMeta('addToHistory', false));
              return false;
            },
            dragover: (view, event) => drag.over(view, event),
            drop: (view, event) => drag.drop(view, event),
            dragend: () => { drag.clear(); return false; },
          },
          decorations(state) {
            const display = noteBlocksPlugin.getState(state);
            if (!display?.enabled) return DecorationSet.empty;
            const unavailable = !owner.isEditable || blocked();
            if (cached && cached.state.doc === state.doc && cached.state.selection.eq(state.selection) && cached.blocked === unavailable && cached.folded === display.folded) return cached.decorations;
            const decorations: Decoration[] = [];
            const blocks = noteBlocks(state.doc);
            for (const block of blocks) {
              const preview = noteBlockPreview(block), folded = display.folded.has(preview.key);
              decorations.push(Decoration.widget(block.from, view => {
                const chrome = document.createElement('span'); chrome.className = 'note-block-chrome'; chrome.contentEditable = 'false';
                chrome.dataset.block = String(block.index);
                const menu = document.createElement('details'); menu.className = 'note-block-menu'; menu.name = `note-block-menu-${noteId}`;
                const trigger = document.createElement('summary'); trigger.addEventListener('mousedown', event => event.preventDefault()); trigger.textContent = '···'; trigger.title = '块操作'; trigger.setAttribute('aria-label', `块 ${block.index + 1} 操作`);
                // 保留正文选区，同时让 Escape 和 Tab 从实际打开的菜单开始。
                trigger.addEventListener('click', () => trigger.focus({ preventScroll: true }));
                const items = document.createElement('span'); items.className = 'note-block-menu-items'; items.setAttribute('role', 'group'); items.setAttribute('aria-label', '块操作');
                const actions: [NoteBlockAction, string][] = [['insert', '在下方插入块'], ['split', '在光标处拆分'], ['merge', '与上一块合并'], ['up', '上移'], ['down', '下移'], ['copy', '复制块'], ['delete', '删除块']];
                for (const [action, label] of actions) {
                  const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
                  button.disabled = !view.editable || blocked() || (action === 'merge' || action === 'up') && block.index === 0 || action === 'down' && block.index === blocks.length - 1 || action === 'split' && (state.selection.from < block.from || state.selection.to > block.to || !state.selection.empty);
                  button.addEventListener('mousedown', event => event.preventDefault());
                  button.addEventListener('click', () => { menu.open = false; run(action, block.index); });
                  items.append(button);
                }
                menu.addEventListener('toggle', () => { if (menu.open) fitBlockMenu(trigger, items); });
                menu.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menu.open = false; trigger.focus(); } });
                const handle = document.createElement('button'); handle.type = 'button'; handle.className = 'note-block-drag'; handle.textContent = '⠿'; handle.setAttribute('aria-label', `拖动块 ${block.index + 1}`); handle.title = '拖动排序；也可用菜单上移、下移'; handle.draggable = true; handle.disabled = !view.editable || blocked();
                handle.addEventListener('dragstart', event => drag.start(view, block.index, event));
                handle.addEventListener('dragend', () => drag.clear());
                const fold = document.createElement('button'); fold.type = 'button'; fold.className = 'note-block-fold'; fold.textContent = folded ? '›' : '⌄'; fold.setAttribute('aria-label', `${folded ? '展开' : '折叠'}块 ${block.index + 1}`); fold.setAttribute('aria-expanded', String(!folded)); fold.title = folded ? '展开块' : '折叠块'; fold.disabled = !block.nodes.length;
                fold.addEventListener('mousedown', event => event.preventDefault());
                fold.addEventListener('click', () => { view.dispatch(view.state.tr.setMeta('note-block-fold', preview.key).setMeta('addToHistory', false)); });
                menu.append(trigger, items); chrome.append(handle, fold, menu); return chrome;
              }, { side: -1, stopEvent: stopBlockControlEvent }));
              if (block.index < blocks.length - 1) decorations.push(Decoration.widget(block.to, view => {
                const gap = document.createElement('span'); gap.className = 'note-block-insert'; gap.contentEditable = 'false';
                const button = document.createElement('button'); button.type = 'button'; button.textContent = '+ 插入块'; button.setAttribute('aria-label', `在块 ${block.index + 1} 后插入`); button.disabled = !view.editable || blocked();
                button.addEventListener('mousedown', event => event.preventDefault()); button.addEventListener('click', () => run('insert', block.index)); gap.append(button); return gap;
              }, { side: -1, stopEvent: stopBlockControlEvent }));
              if (folded) decorations.push(Decoration.widget(block.from, () => {
                const summary = document.createElement('button'); summary.type = 'button'; summary.className = 'note-block-folded'; summary.dataset.noteBlock = String(block.index);
                const first = document.createElement('span'); first.className = 'note-block-preview'; first.textContent = preview.first;
                const rest = document.createElement('small'); rest.textContent = `已折叠 · 还有 ${preview.remaining} 行`;
                summary.append(first, rest); summary.setAttribute('aria-label', `展开块 ${block.index + 1}：${preview.first}`);
                summary.addEventListener('mousedown', event => event.preventDefault());
                summary.addEventListener('click', () => owner.view.dispatch(owner.state.tr.setMeta('note-block-unfold', block.index).setMeta('addToHistory', false)));
                return summary;
              }, { side: -1, stopEvent: stopBlockControlEvent }));
              const focused = state.selection.from >= block.from && state.selection.from <= block.to;
              block.nodes.forEach(({ node, pos }, index) => decorations.push(Decoration.node(pos, pos + node.nodeSize, {
                class: ['note-block-node', index === 0 ? 'note-block-first' : '', index === block.nodes.length - 1 ? 'note-block-last' : '', focused ? 'note-block-focused' : ''].filter(Boolean).join(' '),
                'data-note-block': String(block.index), ...(folded ? { hidden: 'until-found', class: 'note-block-hidden' } : {}),
              })));
              if (!block.nodes.length) decorations.push(Decoration.widget(block.from, view => {
                const placeholder = document.createElement('button');
                placeholder.type = 'button'; placeholder.className = 'note-block-empty';
                placeholder.textContent = '空块 · 点击开始输入'; placeholder.disabled = !view.editable || blocked();
                placeholder.setAttribute('data-note-block', String(block.index));
                placeholder.addEventListener('mousedown', event => event.preventDefault());
                placeholder.addEventListener('click', () => run('activate', block.index));
                return placeholder;
              }, { side: -1, stopEvent: stopBlockControlEvent }));
              if (block.index < blocks.length - 1) decorations.push(Decoration.node(block.to, block.to + 1, { class: 'note-block-boundary' }));
            }
            const result = DecorationSet.create(state.doc, decorations);
            cached = { state, folded: display.folded, blocked: unavailable, decorations: result };
            return result;
          },
        },
      })];
    },
  });
}
