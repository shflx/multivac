import type { NoteEditError } from './note-edit-protection.js';

export function NoteSaveErrorNotice({ message, canRetry, busy, onRetry }: { message: string; canRetry: boolean; busy: boolean; onRetry(): void }) {
  return message && <div className="notes-error" role="alert">{message}{canRetry && <button type="button" disabled={busy} onClick={onRetry}>重试保存</button>}</div>;
}

export function NoteEditErrorNotice({ error, disabled, onReturn }: { error: NoteEditError | null; disabled: boolean; onReturn(): void }) {
  return error && <div className="notes-error" role="alert">{error.message}<button type="button" disabled={disabled} onClick={onReturn}>返回编辑</button></div>;
}
