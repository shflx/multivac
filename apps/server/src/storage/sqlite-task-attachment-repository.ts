import type { DatabaseSync } from 'node:sqlite';
import type { TaskAttachment } from '@multivac/contracts';
import type { TaskAttachmentRepository } from '../modules/tasks/task-attachment.js';
export const TASK_ATTACHMENT_MIGRATION = `
CREATE TABLE task_attachment (id TEXT PRIMARY KEY, task_id TEXT, draft_id TEXT, metadata TEXT NOT NULL, storage_key TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL) STRICT;
CREATE INDEX task_attachment_task ON task_attachment(task_id);
CREATE INDEX task_attachment_draft_idx ON task_attachment(draft_id);
CREATE TABLE task_attachment_draft (id TEXT PRIMARY KEY, task_id TEXT NOT NULL) STRICT;
`;
export class SqliteTaskAttachmentRepository implements TaskAttachmentRepository {
  constructor(private readonly db: DatabaseSync) {}
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
