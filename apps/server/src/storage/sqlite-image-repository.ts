import type { DatabaseSync } from 'node:sqlite';
import type { ImageAttachment } from '@multivac/contracts';

export class SqliteImageRepository {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS image_attachment (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, metadata TEXT NOT NULL,
      created_at INTEGER NOT NULL, retained INTEGER NOT NULL DEFAULT 0
    )`);
  }
  get(id: string): ImageAttachment | undefined {
    const row = this.db.prepare('SELECT metadata FROM image_attachment WHERE id = ?').get(id) as { metadata: string } | undefined;
    return row ? JSON.parse(row.metadata) as ImageAttachment : undefined;
  }
  insert(image: ImageAttachment): void {
    this.db.prepare('INSERT OR IGNORE INTO image_attachment VALUES (?, ?, ?, ?, 0)').run(image.id, image.sessionId, JSON.stringify(image), Date.now());
  }
  retain(ids: readonly string[]): void {
    for (const id of ids) this.db.prepare('UPDATE image_attachment SET retained = 1 WHERE id = ?').run(id);
  }
  drafts(sessionId: string): ImageAttachment[] {
    return (this.db.prepare('SELECT metadata FROM image_attachment WHERE session_id = ? AND retained = 0').all(sessionId) as { metadata: string }[]).map(row => JSON.parse(row.metadata) as ImageAttachment);
  }
  expired(before: number): string[] {
    return (this.db.prepare('SELECT id FROM image_attachment WHERE retained = 0 AND created_at < ? LIMIT 100').all(before) as { id: string }[]).map(row => row.id);
  }
  removeDraft(id: string): boolean {
    return this.db.prepare('DELETE FROM image_attachment WHERE id = ? AND retained = 0').run(id).changes > 0;
  }
}
