const nonnegative = (value) => Number.isFinite(value) && value >= 0 ? value : 0;

/** 容器偏好与临时浮层分开保存，窄布局只临时隐藏另一侧。 */
export function normalizeReadingView(input, legacy = {}) {
  const value = input && typeof input === 'object' ? input : {};
  return {
    navigation: { open: Boolean(value.navigation?.open), tab: ['toc', 'bookmarks', 'shelf'].includes(value.navigation?.tab) ? value.navigation.tab : 'toc' },
    right: { open: value.right ? Boolean(value.right.open) : Boolean(legacy.companionOpen), tab: value.right?.tab === 'notes' ? 'notes' : 'companion' },
    activeSide: value.activeSide === 'left' ? 'left' : 'right',
    compactPane: ['reader', 'navigation', 'right'].includes(value.compactPane) ? value.compactPane : legacy.pane === 'companion' ? 'right' : 'reader',
    navigationScroll: { toc: nonnegative(value.navigationScroll?.toc), bookmarks: nonnegative(value.navigationScroll?.bookmarks), shelf: nonnegative(value.navigationScroll?.shelf) },
    notesScroll: nonnegative(value.notesScroll),
    notesExpanded: Array.isArray(value.notesExpanded) ? value.notesExpanded.filter((id) => typeof id === 'string') : [],
    quickNoteOpen: Boolean(value.quickNoteOpen),
    bookmarkEditingId: typeof value.bookmarkEditingId === 'string' ? value.bookmarkEditingId : null,
  };
}

export function readingPanelLayout(view, width, narrow = false) {
  const compact = narrow || width < 680;
  if (compact) return { compact, left: view.navigation.open && view.compactPane === 'navigation', right: view.right.open && view.compactPane === 'right', reader: view.compactPane === 'reader' || (view.compactPane === 'navigation' ? !view.navigation.open : !view.right.open) };
  const both = width >= 1000;
  const left = view.navigation.open && (both || !view.right.open || view.activeSide === 'left');
  const right = view.right.open && (both || !view.navigation.open || view.activeSide === 'right');
  return { compact, left, right, reader: true };
}

export function toggleReadingNavigation(view, tab, visible) {
  const open = !(visible && view.navigation.tab === tab);
  return { ...view, navigation: { open, tab }, activeSide: 'left', compactPane: open ? 'navigation' : 'reader' };
}

export function openReadingRight(view, tab = 'companion') {
  return { ...view, right: { open: true, tab }, activeSide: 'right', compactPane: 'right' };
}

export function toggleReadingRight(view, tab, visible) {
  return visible && view.right.tab === tab ? { ...view, right: { ...view.right, open: false }, compactPane: 'reader' } : openReadingRight(view, tab);
}

export function hasUnsavedReadingNote(state) {
  const draft = state.noteDraft;
  if (!draft) return false;
  const saved = state.notes.find((note) => note.id === draft.id);
  return !saved || saved.body !== draft.body || saved.origin !== draft.origin || JSON.stringify(saved.reference) !== JSON.stringify(draft.reference) || JSON.stringify(saved.discussion || null) !== JSON.stringify(draft.discussion || null);
}

/** 查看已保存的未修改副本可以直接切换；实际未保存的内容须显式处理。 */
export function requestReadingNote(state, candidate) {
  if (hasUnsavedReadingNote(state)) return state;
  return { ...state, noteDraft: candidate };
}


export function saveReadingNote(state, id, nextDraft = null, at = new Date().toISOString()) {
  const draft = state.noteDraft;
  if (!draft?.body.trim()) return state;
  const note = { ...draft, id: draft.id || id, body: draft.body.trim(), updatedAt: at };
  return { ...state, notes: state.notes.some((item) => item.id === note.id) ? state.notes.map((item) => item.id === note.id ? note : item) : [...state.notes, note], noteDraft: nextDraft };
}

export function activateReadingDiscussion(state, id) {
  const all = [...state.stack, ...state.archived];
  const path = [];
  let level = all.find((item) => item.id === id);
  while (level && !path.some((item) => item.id === level.id)) {
    path.unshift(level);
    if (level.id === 'root') break;
    level = all.find((item) => item.id === (level.parentId || 'root'));
  }
  if (path[0]?.id !== 'root') return state;
  return { ...state, stack: path, archived: all.filter((item) => !path.some((active) => active.id === item.id)) };
}

/** 浮层只受锚点和容器边界约束，完全不参与正文的宽高测量。 */
export function readingFloatingPosition(anchor, size, bounds) {
  const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));
  const left = clamp(anchor.left, bounds.left + 8, bounds.right - size.width - 8);
  const below = anchor.bottom + 8;
  const top = clamp(below + size.height <= bounds.bottom - 8 ? below : anchor.top - size.height - 8, bounds.top + 8, bounds.bottom - size.height - 8);
  return { left: left - bounds.left, top: top - bounds.top };
}
