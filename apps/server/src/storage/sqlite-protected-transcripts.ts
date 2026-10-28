import type { NoteRecordCodec } from './note-record-codec.js';
import type { ProtectedTranscriptStore } from '../modules/notes/protected-transcript.js';
import { NotesError } from '../modules/notes/note.js';
import { createHash } from 'node:crypto';

export class SqliteProtectedTranscripts implements ProtectedTranscriptStore {
  constructor(private readonly codec: NoteRecordCodec) {}
  forSession(sessionId: string) { const owner = this.codec.owner(sessionId); return !!owner && !!this.codec.state(owner); }
  has(path: string) { return !!this.codec.database.prepare('SELECT path FROM app_note_protected_file WHERE path=?').get(path); }
  private row(path: string) {
    const row = this.codec.database.prepare('SELECT note_id,session_id,content FROM app_note_protected_file WHERE path=?').get(path);
    if (!row) throw new NotesError('受保护讨论记录不存在。', 404);
    return { noteId: String(row.note_id), sessionId: String(row.session_id), content: String(row.content) };
  }
  readBytes(path: string) { const row = this.row(path); return this.codec.open(row.noteId, 'managed-file', JSON.stringify([row.sessionId, path]), row.content); }
  read(path: string) { return this.readBytes(path).toString('utf8'); }
  create(sessionId: string, path: string, content: string) { this.createBytes(sessionId, path, Buffer.from(content)); }
  createBytes(sessionId: string, path: string, content: Buffer) {
    const noteId = this.codec.owner(sessionId);
    if (!noteId || !this.codec.state(noteId)) throw new NotesError('讨论没有受保护的笔记归属。', 409);
    this.codec.database.prepare('INSERT INTO app_note_protected_file(path,note_id,session_id,content,cleanup_pending) VALUES (?,?,?,?,0)')
      .run(path, noteId, sessionId, this.codec.seal(noteId, 'managed-file', JSON.stringify([sessionId, path]), content));
  }
  write(path: string, content: string) {
    const row = this.row(path);
    this.codec.database.prepare('UPDATE app_note_protected_file SET content=? WHERE path=?').run(this.codec.seal(row.noteId, 'managed-file', JSON.stringify([row.sessionId, path]), Buffer.from(content)), path);
  }
  remove(path: string) { const row = this.row(path); this.codec.assert(row.noteId); this.codec.database.prepare('DELETE FROM app_note_protected_file WHERE path=?').run(path); }
  version(path: string) { const row = this.row(path); this.codec.assert(row.noteId); return createHash('sha256').update(row.content).digest('hex'); }
}
