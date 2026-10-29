import { protectedNote } from '../../data/note-access.js';
import { noteVaultStorage, protectionMarker } from './note-vault.js';
import { type Note, type UpdateNote, NoteSchema, UpdateNoteSchema } from '@multivac/contracts';
import { Check } from 'typebox/value';
import { newCommandId } from '../../data/command-id.js';

export interface NoteDraft {
  base: Note; title: string; body: string; edit: number; pending: UpdateNote | null;
}
export function initialNoteDraft(note: Note): NoteDraft {
  return { base: note, title: note.title, body: note.body, edit: 0, pending: null };
}
export function noteDirty(draft: NoteDraft): boolean { return draft.title !== draft.base.title || draft.body !== draft.base.body; }
export function noteSaved(draft: NoteDraft, saved: Note, request: UpdateNote): NoteDraft {
  if (saved.id !== draft.base.id || draft.pending?.commandId !== request.commandId) return draft;
  return { ...draft, base: saved.revision >= draft.base.revision ? saved : draft.base, pending: null };
}
export function noteRefreshed(draft: NoteDraft, note: Note): NoteDraft {
  if (draft.base.id !== note.id || note.revision <= draft.base.revision) return draft;
  return !noteDirty(draft) && !draft.pending ? initialNoteDraft(note) : draft;
}

/** 每次挂载复制到新的持久键，避免复制标签页的 sessionStorage 让两个窗口写同一草稿。 */
export class NoteDraftStorage {
  private readonly key = `multivac:note-draft:${newCommandId()}`;
  private readonly pointer: string;
  private claimed = false;
  constructor(readonly noteId: string) { this.pointer = `multivac:note-draft-pointer:${noteId}`; }
  private get local() { return protectedNote(this.noteId) ? noteVaultStorage(this.noteId, 'local') : localStorage; }
  private get session() { return protectedNote(this.noteId) ? noteVaultStorage(this.noteId, 'session') : sessionStorage; }
  load(note: Note): NoteDraft {
    const previous = this.session.getItem(this.pointer);
    if (!previous) return initialNoteDraft(note);
    const raw = this.local.getItem(previous);
    if (!raw) throw new Error('本机草稿记录不可用，请核对浏览器存储，避免覆盖原输入。');
    const draft = JSON.parse(raw) as NoteDraft;
    if (!Check(NoteSchema, draft.base) || draft.base.id !== note.id || typeof draft.title !== 'string' || typeof draft.body !== 'string' || !Number.isInteger(draft.edit) || draft.pending !== null && !Check(UpdateNoteSchema, draft.pending)) throw new Error('本机草稿无法读取，原记录已保留。');
    return noteRefreshed(draft, note);
  }
  save(draft: NoteDraft) {
    if (localStorage.getItem(protectionMarker(this.noteId)) && !protectedNote(this.noteId)) throw new Error('笔记正在转换或已加密，请重新打开此笔记。');
    if (localStorage.getItem(`multivac:note-deleted:${this.noteId}`) === '1') return;
    if (draft.base.id !== this.noteId) throw new Error('草稿笔记身份不一致。');
    const previous = this.session.getItem(this.pointer);
    this.local.setItem(this.key, JSON.stringify(draft));
    if (this.claimed && previous && previous !== this.key) return;
    this.session.setItem(this.pointer, this.key);
    this.claimed = true;
    // 密文包属于当前挂载的副本，旧包仍保留；新包不再累积已迁移的正文副本。
    if (protectedNote(this.noteId) && previous && previous !== this.key) this.local.removeItem(previous);
    // 只清理本控制器已经写过的记录；旧窗口/旧挂载的键可能仍供其他窗口恢复。
    if (previous === this.key && !noteDirty(draft) && !draft.pending) {
      this.session.removeItem(this.pointer); this.local.removeItem(this.key);
    }
  }
}


/** 删除身份不可复用；清理本浏览器中该笔记各次挂载留下的正文草稿。 */
export function clearDeletedNoteStorage(noteId: string) {
  // 已发出的保存可能迟到；所有窗口的旧控制器都不得重新写回正文草稿。
  localStorage.setItem(`multivac:note-deleted:${noteId}`, '1');
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
  for (const key of keys) {
    if (!key?.startsWith('multivac:note-draft:')) continue;
    let draft: NoteDraft;
    try { draft = JSON.parse(localStorage.getItem(key) ?? 'null') as NoteDraft; } catch { continue; }
    if (draft?.base?.id === noteId) localStorage.removeItem(key);
  }
  for (const prefix of ['note-draft-pointer', 'note-delete', 'note-view', 'note-assistant']) sessionStorage.removeItem(`multivac:${prefix}:${noteId}`);
}
