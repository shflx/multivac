import { noteCodecFor } from './note-record-codec.js';
import type { DatabaseSync } from 'node:sqlite';
import type { ImageAttachment, MessageImageReference } from '@multivac/contracts';
import type { ImageRepository } from '../modules/sessions/image-attachment.js';


export class SqliteImageRepository implements ImageRepository {
  constructor(private readonly db: DatabaseSync) {}
  get(id: string): ImageAttachment | undefined {
    const row = this.db.prepare('SELECT session_id,metadata FROM image_attachment WHERE id = ?').get(id) as { session_id: string; metadata: string } | undefined;
    if (!row) return undefined;
    const codec = noteCodecFor(this.db), owner = codec?.owner(row.session_id);
    return owner && codec ? codec.decode(owner, 'discussion-image', id, row.metadata) : JSON.parse(row.metadata) as ImageAttachment;
  }
  private encode(sessionId: string, kind: string, identity: string, value: unknown): string {
    const codec = noteCodecFor(this.db), owner = codec?.owner(sessionId);
    return owner && codec ? codec.encode(owner, kind, identity, value) : JSON.stringify(value);
  }
  insert(image: ImageAttachment): void {
    this.db.prepare('INSERT OR IGNORE INTO image_attachment VALUES (?, ?, ?, ?, 0)').run(image.id, image.sessionId, this.encode(image.sessionId, 'discussion-image', image.id, image), Date.now());
  }
  retain(ids: readonly string[]): void {
    for (const id of ids) this.db.prepare('UPDATE image_attachment SET retained = 1 WHERE id = ?').run(id);
  }
  drafts(sessionId: string): ImageAttachment[] {
    return (this.db.prepare('SELECT id FROM image_attachment WHERE session_id = ? AND retained = 0').all(sessionId) as { id: string }[]).map(row => this.get(row.id)!);
  }
  expired(before: number): string[] {
    return (this.db.prepare('SELECT id FROM image_attachment WHERE retained = 0 AND created_at < ? AND session_id NOT IN (SELECT d.session_id FROM app_note_discussion d JOIN app_note_protection p ON p.note_id=d.note_id) LIMIT 100').all(before) as { id: string }[]).map(row => row.id);
  }
  removeDraft(id: string): boolean {
    return this.db.prepare('DELETE FROM image_attachment WHERE id = ? AND retained = 0').run(id).changes > 0;
  }
  sources(sessionId: string, runtimeSessionId: string, entryId: string): MessageImageReference[] | undefined {
    const row = this.db.prepare('SELECT sources FROM message_image_source WHERE session_id = ? AND runtime_session_id = ? AND entry_id = ?').get(sessionId, runtimeSessionId, entryId) as { sources: string } | undefined;
    if (!row) return undefined;
    const codec = noteCodecFor(this.db), owner = codec?.owner(sessionId);
    return owner && codec ? codec.decode(owner, 'message-images', `${runtimeSessionId}:${entryId}`, row.sources) : JSON.parse(row.sources) as MessageImageReference[];
  }
  saveSources(sessionId: string, runtimeSessionId: string, entryId: string, sources: MessageImageReference[]): void {
    this.db.prepare('INSERT OR IGNORE INTO message_image_source VALUES (?, ?, ?, ?)').run(sessionId, runtimeSessionId, entryId, this.encode(sessionId, 'message-images', `${runtimeSessionId}:${entryId}`, sources));
  }
}
