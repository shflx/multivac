import type { DatabaseSync } from 'node:sqlite';
import type { SessionFileReference } from '@multivac/contracts';
import { SessionFileReferenceSchema } from '@multivac/contracts';
import { Check } from 'typebox/value';
import { Type } from 'typebox';
import type { MessageFileSourceRepository } from '../application/message-file-sources.js';

/**
 * 消息附带文件来源的 SQLite 实现：按会话、执行器会话与消息条目首写保存，内容损坏时按空列表读取。
 * 表结构与迁移由 SqliteAssistantStore 维护。
 */
export class SqliteMessageFileSourceRepository implements MessageFileSourceRepository {
  constructor(private readonly database: DatabaseSync) {}

  get(sessionId: string, runtimeSessionId: string, entryId: string): SessionFileReference[] | null {
    const row = this.database.prepare('SELECT references_json FROM assistant_message_file_source WHERE session_id = ? AND runtime_session_id = ? AND runtime_entry_id = ?').get(sessionId, runtimeSessionId, entryId) as { references_json: string } | undefined;
    if (!row) return null;
    try { const value: unknown = JSON.parse(row.references_json); return Check(Type.Array(SessionFileReferenceSchema, { maxItems: 20 }), value) ? value : []; }
    catch { return []; }
  }

  putIfAbsent(sessionId: string, runtimeSessionId: string, entryId: string, references: SessionFileReference[]): void {
    this.database.prepare('INSERT OR IGNORE INTO assistant_message_file_source (session_id, runtime_session_id, runtime_entry_id, references_json) VALUES (?, ?, ?, ?)').run(sessionId, runtimeSessionId, entryId, JSON.stringify(references));
  }
}
