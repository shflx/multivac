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
  load(note: Note): NoteDraft {
    const previous = sessionStorage.getItem(this.pointer);
    if (!previous) return initialNoteDraft(note);
    const raw = localStorage.getItem(previous);
    if (!raw) throw new Error('本机草稿记录不可用，请核对浏览器存储，避免覆盖原输入。');
    const draft = JSON.parse(raw) as NoteDraft;
    if (!Check(NoteSchema, draft.base) || draft.base.id !== note.id || typeof draft.title !== 'string' || typeof draft.body !== 'string' || !Number.isInteger(draft.edit) || draft.pending !== null && !Check(UpdateNoteSchema, draft.pending)) throw new Error('本机草稿无法读取，原记录已保留。');
    return noteRefreshed(draft, note);
  }
  save(draft: NoteDraft) {
    if (draft.base.id !== this.noteId) throw new Error('草稿笔记身份不一致。');
    const previous = sessionStorage.getItem(this.pointer);
    localStorage.setItem(this.key, JSON.stringify(draft));
    if (this.claimed && previous && previous !== this.key) return;
    sessionStorage.setItem(this.pointer, this.key);
    this.claimed = true;
    // 只清理本控制器已经写过的记录；旧窗口/旧挂载的键可能仍供其他窗口恢复。
    if (previous === this.key && !noteDirty(draft) && !draft.pending) {
      sessionStorage.removeItem(this.pointer); localStorage.removeItem(this.key);
    }
  }
}
