import type { DatabaseSync } from 'node:sqlite';
import type { ReadingCollectionItem, ReadingCollectionTarget } from '@multivac/contracts';
import { ReadingError, readingHash } from '../modules/reading/book-import.js';

export const READING_COLLECTION_MIGRATION = `
  CREATE TABLE IF NOT EXISTS reading_collection_target (id TEXT PRIMARY KEY, record_json TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS reading_collection_item (id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES reading_collection_target(id), identity TEXT UNIQUE NOT NULL, record_json TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS reading_collection_command (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL) STRICT;
  INSERT OR IGNORE INTO reading_collection_target VALUES ('reading-inbox', json_object('id','reading-inbox','title','收集箱','createdAt',strftime('%Y-%m-%dT%H:%M:%fZ','now')));
`;
export class SqliteReadingCollectionRepository {
  constructor(private readonly database: DatabaseSync) {}
  targets(): ReadingCollectionTarget[] { return this.database.prepare('SELECT record_json FROM reading_collection_target ORDER BY rowid').all().map(row => JSON.parse(String(row.record_json))); }
  items(targetId: string): ReadingCollectionItem[] {
    if (!this.targets().some(t => t.id === targetId)) throw new ReadingError('笔记接收目标不存在。', 404);
    return this.database.prepare('SELECT record_json FROM reading_collection_item WHERE target_id=? ORDER BY rowid DESC').all(targetId).map(row => JSON.parse(String(row.record_json)));
  }
  receipt(commandId: string, fingerprint: string): ReadingCollectionItem | ReadingCollectionTarget | null {
    const row = this.database.prepare('SELECT fingerprint,result_json FROM reading_collection_command WHERE command_id=?').get(commandId);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new ReadingError('收集命令参数冲突。', 409);
    return JSON.parse(String(row.result_json));
  }
  private transaction<T>(run: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.database.exec('COMMIT'); return result; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  createTarget(commandId: string, title: string): ReadingCollectionTarget {
    const fingerprint = readingHash(JSON.stringify(['target', title]));
    return this.transaction(() => {
      const receipt = this.receipt(commandId, fingerprint); if (receipt) return receipt as ReadingCollectionTarget;
      if (!title.trim()) throw new ReadingError('目标名称不能为空。');
      if (this.targets().length >= 20) throw new ReadingError('最多创建 20 个接收目标。', 409);
      const target = { id: `target-${readingHash(commandId)}`, title: title.trim(), createdAt: new Date().toISOString() };
      this.database.prepare('INSERT INTO reading_collection_target VALUES (?,?)').run(target.id, JSON.stringify(target));
      this.database.prepare('INSERT INTO reading_collection_command VALUES (?,?,?)').run(commandId, fingerprint, JSON.stringify(target));
      return target;
    });
  }
  collect(item: ReadingCollectionItem, identity: string, commandId: string, fingerprint: string): { item: ReadingCollectionItem; changed: boolean } {
    return this.transaction(() => {
      const receipt = this.receipt(commandId, fingerprint); if (receipt) return { item: receipt as ReadingCollectionItem, changed: false };
      if (!this.targets().some(t => t.id === item.targetId)) throw new ReadingError('接收目标已失效。', 404);
      const existing = this.database.prepare('SELECT record_json FROM reading_collection_item WHERE identity=?').get(identity);
      const count = Number(this.database.prepare('SELECT COUNT(*) AS count FROM reading_collection_item').get()!.count);
      if (!existing && count >= 2000) throw new ReadingError('最多收集 2000 条笔记。', 409);
      const saved = existing ? JSON.parse(String(existing.record_json)) as ReadingCollectionItem : item;
      if (!existing) this.database.prepare('INSERT INTO reading_collection_item VALUES (?,?,?,?)').run(saved.id, saved.targetId, identity, JSON.stringify(saved));
      this.database.prepare('INSERT INTO reading_collection_command VALUES (?,?,?)').run(commandId, fingerprint, JSON.stringify(saved));
      return { item: saved, changed: !existing };
    });
  }
}
