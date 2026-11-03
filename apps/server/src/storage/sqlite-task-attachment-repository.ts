import { runInTransaction } from './sqlite-transaction.js';
import type { DatabaseSync } from 'node:sqlite';
import type { TaskAttachment } from '@multivac/contracts';
import type { SessionAttachmentDraft, TaskAttachmentRepository } from '../modules/tasks/task-attachment.js';
export const TASK_ATTACHMENT_MIGRATION = `
CREATE TABLE IF NOT EXISTS task_attachment (id TEXT PRIMARY KEY, task_id TEXT, draft_id TEXT, metadata TEXT NOT NULL, storage_key TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS task_attachment_task ON task_attachment(task_id);
CREATE INDEX IF NOT EXISTS task_attachment_draft_idx ON task_attachment(draft_id);
CREATE TABLE IF NOT EXISTS task_attachment_draft (id TEXT PRIMARY KEY, task_id TEXT NOT NULL) STRICT;
`;
export const SESSION_ATTACHMENT_MIGRATION = `
CREATE TABLE IF NOT EXISTS session_attachment_draft (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at TEXT NOT NULL, command_id TEXT) STRICT;
`;
export const SESSION_ATTACHMENT_CLEANUP_MIGRATION = `
CREATE TABLE IF NOT EXISTS session_attachment_expiry (id TEXT PRIMARY KEY) STRICT;
CREATE INDEX IF NOT EXISTS session_attachment_draft_age ON session_attachment_draft(created_at);
`;
export class SqliteTaskAttachmentRepository implements TaskAttachmentRepository {
  constructor(private readonly db: DatabaseSync) {}
  expiredSessionDrafts(before: string): SessionAttachmentDraft[] {
    return (this.db.prepare('SELECT id FROM session_attachment_draft WHERE created_at <= ? AND id NOT IN (SELECT id FROM task_attachment_draft) ORDER BY created_at LIMIT 100').all(before) as { id: string }[]).map(row => this.sessionDraft(row.id)!);
  }
  sessionDraftExpired(id: string) { return !!this.db.prepare('SELECT 1 FROM session_attachment_expiry WHERE id=?').get(id); }
  purgeSessionDraft(id: string) {
    runInTransaction(this.db, () => {
      if (this.draftOwner(id)) throw new Error('已领用草稿不能清理。');
      this.db.prepare('INSERT OR IGNORE INTO session_attachment_expiry VALUES (?)').run(id);
      this.db.prepare('DELETE FROM task_attachment WHERE draft_id=? AND task_id IS NULL').run(id);
      this.db.prepare('DELETE FROM session_attachment_draft WHERE id=?').run(id);
    });
  }
  sessionDraft(id: string): SessionAttachmentDraft | undefined {
    const row = this.db.prepare('SELECT * FROM session_attachment_draft WHERE id=?').get(id) as { id: string; session_id: string; created_at: string; command_id: string | null } | undefined;
    return row ? { id: row.id, sessionId: row.session_id, createdAt: row.created_at, commandId: row.command_id } : undefined;
  }
  createSessionDraft(draft: SessionAttachmentDraft) { this.db.prepare('INSERT INTO session_attachment_draft VALUES (?,?,?,NULL)').run(draft.id, draft.sessionId, draft.createdAt); }
  sendSessionDraft(id: string, commandId: string) { this.db.prepare('UPDATE session_attachment_draft SET command_id=? WHERE id=?').run(commandId, id); }
  isStorageKey(key: string) { return !!this.db.prepare('SELECT 1 FROM task_attachment WHERE storage_key=?').get(key); }
  storageKey(id: string) { return (this.db.prepare('SELECT storage_key FROM task_attachment WHERE id=?').get(id) as { storage_key: string } | undefined)?.storage_key; }
  get(id: string): TaskAttachment | undefined {
    const row = this.db.prepare('SELECT metadata FROM task_attachment WHERE id=?').get(id) as { metadata: string } | undefined;
    return row ? JSON.parse(row.metadata) : undefined;
  }
  private query(column: 'task_id' | 'draft_id', id: string): TaskAttachment[] {
    return (this.db.prepare(`SELECT metadata FROM task_attachment WHERE ${column}=? ORDER BY rowid`).all(id) as { metadata: string }[]).map(row => JSON.parse(row.metadata));
  }
  list(id: string) { return this.query('task_id', id); }
  draft(id: string) { return this.query('draft_id', id); }
  draftOwner(id: string) { return (this.db.prepare('SELECT task_id FROM task_attachment_draft WHERE id=?').get(id) as { task_id: string } | undefined)?.task_id; }
  claim(draftId: string, taskId: string) {
    this.db.prepare('INSERT INTO task_attachment_draft VALUES (?,?)').run(draftId, taskId);
    for (const item of this.draft(draftId)) this.db.prepare('UPDATE task_attachment SET task_id=?,metadata=? WHERE id=?').run(taskId, JSON.stringify({ ...item, taskId }), item.id);
  }
  insert(item: TaskAttachment, draftId: string | null, storageKey: string) { this.db.prepare('INSERT INTO task_attachment VALUES (?,?,?,?,?,?)').run(item.id, item.taskId, draftId, JSON.stringify(item), storageKey, item.bytes); }
  remove(id: string, at: string) { const item = this.get(id)!; this.db.prepare('UPDATE task_attachment SET metadata=? WHERE id=?').run(JSON.stringify({ ...item, removedAt: at }), id); }
  totalBytes(taskId?: string): number {
    const row = taskId === undefined ? this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS total FROM task_attachment').get() : this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS total FROM task_attachment WHERE task_id=?').get(taskId);
    return (row as { total: number }).total;
  }
}
