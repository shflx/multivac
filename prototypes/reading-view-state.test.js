import test from 'node:test';
import assert from 'node:assert/strict';
import { activateReadingDiscussion, normalizeReadingView, openReadingRight, readingFloatingPosition, readingPanelLayout, requestReadingNote, saveReadingNote, toggleReadingNavigation, toggleReadingRight } from './reading-view-state.js';
import { blankReadingState, firstPosition, makeReference, normalizeReadingState } from './reading-state.js';

const book = { id: 'book', title: '示例', chapters: [{ id: 'ch', title: '第一章', paragraphs: ['正文位置保持稳定。'], keywords: [] }] };
const start = firstPosition(book);
const reference = makeReference(book, start, { ...start, offset: 5 }, 1);

test('旧阅读现场迁移到互相独立的导航、右栏与卡片偏好，保留草稿和历史', () => {
  const old = { ...blankReadingState(book), view: undefined, companionOpen: true, pane: 'companion', bookmarks: [{ id: 'b', reference, remark: '备注' }], noteDraft: { reference, body: '旧草稿' }, notes: [{ id: 'n', reference, body: '旧笔记' }] };
  const restored = normalizeReadingState(book, old);
  assert.equal(restored.view.right.open, true);
  assert.equal(restored.view.compactPane, 'right');
  assert.equal(restored.bookmarks[0].remark, '备注');
  assert.equal(restored.noteDraft.body, '旧草稿');
  assert.equal(restored.notes[0].body, '旧笔记');
  assert.doesNotThrow(() => normalizeReadingState(book, { view: null }));
});

test('导航入口再次点击收起；隐藏的另一侧重新打开而不是误关闭', () => {
  let view = toggleReadingNavigation(normalizeReadingView(), 'toc', false);
  assert.equal(view.navigation.open, true);
  view = toggleReadingNavigation(view, 'bookmarks', true);
  assert.equal(view.navigation.open, true);
  assert.equal(view.navigation.tab, 'bookmarks');
  view = toggleReadingNavigation(view, 'bookmarks', true);
  assert.equal(view.navigation.open, false);
  view = openReadingRight(view, 'notes');
  view = toggleReadingNavigation(view, 'toc', false);
  assert.equal(view.right.open, true);
  const small = readingPanelLayout(view, 820);
  assert.equal(small.left, true);
  assert.equal(small.right, false);
  view = toggleReadingRight(view, 'notes', small.right);
  assert.equal(view.right.open, true);
  assert.equal(readingPanelLayout(view, 820).left, false);
});

test('按实际容器宽度折叠另一侧，不清除展开偏好，宽度恢复后同时显示', () => {
  const view = { ...normalizeReadingView(), navigation: { open: true, tab: 'toc' }, right: { open: true, tab: 'notes' }, activeSide: 'left' };
  const before = JSON.stringify(view);
  assert.deepEqual(readingPanelLayout(view, 1200), { compact: false, left: true, right: true, reader: true });
  assert.deepEqual(readingPanelLayout(view, 760), { compact: false, left: true, right: false, reader: true });
  assert.equal(JSON.stringify(view), before);
  assert.equal(readingPanelLayout(view, 1200).right, true);
  const mobile = toggleReadingNavigation(view, 'bookmarks', false);
  assert.deepEqual(readingPanelLayout(mobile, 390), { compact: true, left: true, right: false, reader: false });
  assert.deepEqual(readingPanelLayout({ ...mobile, compactPane: 'reader' }, 390), { compact: true, left: false, right: false, reader: true });
});

test('卡片收起和翻页不更改草稿；新引用不能覆盖现有记录，显式保存后才接收新引用', () => {
  const candidate = { body: '新引用', reference: { ...reference, pageNumber: 8 }, origin: 'companion' };
  const state = { ...blankReadingState(book), noteDraft: { body: '原草稿', reference, origin: 'user' } };
  assert.equal(requestReadingNote(state, candidate), state);
  assert.equal(requestReadingNote({ ...state, view: { ...state.view, quickNoteOpen: false } }, candidate).noteDraft.reference, reference);
  const saved = saveReadingNote(state, 'n1', candidate, '2026-01-01');
  assert.equal(saved.notes[0].body, '原草稿');
  assert.equal(saved.noteDraft, candidate);
  assert.deepEqual(saved.position, state.position);
  assert.equal(saveReadingNote({ ...state, noteDraft: { body: ' ' } }, 'n2').notes.length, 0);
});

test('同一处可保存多条笔记，编辑原记录不会创建重复项', () => {
  const first = saveReadingNote({ ...blankReadingState(book), noteDraft: { body: '第一条', reference } }, 'one');
  const second = saveReadingNote({ ...first, noteDraft: { body: '第二条', reference } }, 'two');
  assert.equal(second.notes.length, 2);
  const edited = saveReadingNote({ ...second, noteDraft: { ...second.notes[0], body: '修改第一条' } }, 'unused');
  assert.equal(edited.notes.length, 2);
  assert.equal(edited.notes[0].body, '修改第一条');
});

test('视图切换与刷新保留笔记展开/滚动、书伴消息位置和回答来源', () => {
  const state = { ...blankReadingState(book), view: { ...normalizeReadingView(), notesScroll: 246, notesExpanded: ['n'], quickNoteOpen: true }, notes: [{ id: 'n', body: '来自回答', reference, origin: 'companion', discussion: { levelId: 'root', messageId: 'm' } }], stack: [{ ...blankReadingState(book).stack[0], scrollTop: 372, draft: '未发送' }] };
  const restored = normalizeReadingState(book, JSON.parse(JSON.stringify(state)));
  assert.equal(restored.view.notesScroll, 246);
  assert.deepEqual(restored.view.notesExpanded, ['n']);
  assert.equal(restored.stack[0].scrollTop, 372);
  assert.equal(restored.stack[0].draft, '未发送');
  assert.equal(restored.notes[0].discussion.messageId, 'm');
  assert.equal(restored.view.quickNoteOpen, true);
});

test('从回答笔记返回原讨论路径，同时保存另一条已打开讨论及其草稿', () => {
  const root = { id: 'root', thread: [] };
  const first = { id: 'first', parentId: 'root', draft: '原讨论草稿', thread: [] };
  const child = { id: 'child', parentId: 'first', thread: [] };
  const other = { id: 'other', parentId: 'root', draft: '另一个草稿', thread: [] };
  const result = activateReadingDiscussion({ stack: [root, other], archived: [first, child] }, 'child');
  assert.deepEqual(result.stack.map((level) => level.id), ['root', 'first', 'child']);
  assert.equal(result.archived[0].draft, '另一个草稿');
  const missing = { stack: [root], archived: [] };
  assert.equal(activateReadingDiscussion(missing, 'missing'), missing);
});

test('长选区与边缘锚点的浮层限制在阅读容器内，不涉及正文测量尺寸', () => {
  const bounds = { left: 200, right: 900, top: 56, bottom: 600 };
  const edge = readingFloatingPosition({ left: 880, top: 560, bottom: 590 }, { width: 280, height: 150 }, bounds);
  assert.deepEqual(edge, { left: 412, top: 346 });
  const long = readingFloatingPosition({ left: 150, top: 70, bottom: 580 }, { width: 350, height: 100 }, bounds);
  assert.deepEqual(long, { left: 8, top: 8 });
});


test('同处笔记的未修改查看副本可直接切换，修改后则保护未保存内容', () => {
  const one = { id: 'one', body: '第一条', reference, origin: 'user' };
  const two = { id: 'two', body: '第二条', reference, origin: 'user' };
  const saved = { ...blankReadingState(book), notes: [one, two], noteDraft: { ...one } };
  assert.equal(requestReadingNote(saved, two).noteDraft, two);
  const dirty = { ...saved, noteDraft: { ...one, body: '修改后尚未保存' } };
  assert.equal(requestReadingNote(dirty, two), dirty);
});
