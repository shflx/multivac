import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync } from 'node:sqlite';
import type { NoteAccess } from '@multivac/contracts';
import { encryptNoteBytes, decryptNoteBytes, type NoteCiphertext } from '../modules/notes/note-crypto.js';
import { NotesError } from '../modules/notes/note.js';
import type { NoteSecurityService } from '../application/note-security-service.js';

export const NOTE_PROTECTION_MIGRATION = `
  CREATE TABLE IF NOT EXISTS app_note_protection (
    note_id TEXT PRIMARY KEY REFERENCES app_note(id),
    state TEXT NOT NULL CHECK(state IN ('encrypting','encrypted','decrypting'))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS app_note_protected_file (
    path TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES app_note(id), session_id TEXT NOT NULL,
    content TEXT NOT NULL, cleanup_pending INTEGER NOT NULL DEFAULT 1, restore_temp TEXT
  ) STRICT;
`;
interface Envelope { noteEncrypted: 1; payload: NoteCiphertext }

/** 只把请求所携带的资格传给当前调用链，不把已解封密钥当成全局读取许可。 */
const codecs = new WeakMap<DatabaseSync, NoteRecordCodec>();
export const noteCodecFor = (database: DatabaseSync) => codecs.get(database);

export class NoteRecordCodec {
  private readonly context = new AsyncLocalStorage<NoteAccess | ReadonlyMap<string, NoteAccess> | undefined>();
  private readonly writers = new Map<string, { key: Buffer; count: number }>();
  private security?: NoteSecurityService;
  private readonly converting = new AsyncLocalStorage<boolean>();
  constructor(readonly database: DatabaseSync) {
    codecs.set(database, this);
    database.function('note_command_error', (sessionId, commandId, value) => {
      if (value === null) return null;
      const owner = this.owner(String(sessionId));
      return owner && this.state(owner) ? this.encode(owner, 'command-error', String(commandId), value) : value;
    });
    database.function('note_event_json', (sessionId, sourceKey, stored) => {
      const owner = this.owner(String(sessionId));
      return owner && this.state(owner) ? JSON.stringify(this.decode(owner, 'event', String(sourceKey), stored)) : String(stored);
    });
  }
  bind(security: NoteSecurityService) { this.security = security; }
  run<T>(access: NoteAccess | undefined, operation: () => T): T { return this.context.run(access, operation); }
  conversion<T>(access: NoteAccess, operation: () => T): T { return this.converting.run(true, () => this.run(access, operation)); }
  runMany<T>(grants: ReadonlyMap<string, NoteAccess>, operation: () => T): T { return this.context.run(grants, operation); }
  access(noteId: string): NoteAccess | undefined { const value = this.context.getStore(); return value && 'token' in value ? value : value?.get(noteId); }
  authorizedNotes(): string[] {
    const grants = this.context.getStore();
    return grants && !('token' in grants) ? [...grants.keys()].filter(id => this.canRead(id)) : [];
  }
  canRead(noteId: string): boolean { try { this.assert(noteId); return true; } catch { return false; } }
  retainWriter(noteId: string): () => void {
    this.assert(noteId);
    let writer = this.writers.get(noteId);
    if (!writer) {
      if (!this.security) throw new NotesError('笔记已锁定。', 423);
      writer = { key: this.security.withDataKey(noteId, this.access(noteId), key => Buffer.from(key)), count: 0 };
      this.writers.set(noteId, writer);
    }
    writer.count++;
    let released = false;
    return () => {
      if (released) return; released = true;
      if (--writer.count === 0) { writer.key.fill(0); this.writers.delete(noteId); }
    };
  }
  state(noteId: string): 'encrypting' | 'encrypted' | 'decrypting' | undefined {
    return this.database.prepare('SELECT state FROM app_note_protection WHERE note_id=?').get(noteId)?.state as ReturnType<NoteRecordCodec['state']>;
  }
  owner(sessionId: string): string | undefined {
    return this.database.prepare('SELECT note_id FROM app_note_discussion WHERE session_id=?').get(sessionId)?.note_id as string | undefined;
  }
  assert(noteId: string): void {
    const state = this.state(noteId);
    if (state) {
      if (state !== 'encrypted' && !this.converting.getStore()) throw new NotesError('笔记转换尚未完成，请先恢复转换。', 409);
      if (!this.security) throw new NotesError('笔记已锁定。', 423);
      this.security.assertAccess(noteId, this.access(noteId));
    }
  }
  assertSession(sessionId: string) { const noteId = this.owner(sessionId); if (noteId) this.assert(noteId); }
  seal(noteId: string, kind: string, identity: string, bytes: Uint8Array): string {
    const writer = this.writers.get(noteId);
    if (writer) return JSON.stringify({ noteEncrypted: 1, payload: encryptNoteBytes(writer.key, bytes, { noteId, kind, identity }) } satisfies Envelope);
    this.assert(noteId);
    if (!this.security) throw new NotesError('笔记已锁定。', 423);
    const payload = this.security.withDataKey(noteId, this.access(noteId), key => encryptNoteBytes(key, bytes, { noteId, kind, identity }));
    return JSON.stringify({ noteEncrypted: 1, payload } satisfies Envelope);
  }
  open(noteId: string, kind: string, identity: string, stored: string): Buffer {
    this.assert(noteId);
    if (!this.security) throw new NotesError('笔记已锁定。', 423);
    let envelope: Envelope;
    try { envelope = JSON.parse(stored) as Envelope; } catch { throw new NotesError('加密记录格式无效。', 409); }
    if (envelope?.noteEncrypted !== 1) throw new NotesError('加密记录格式无效。', 409);
    return this.security.withDataKey(noteId, this.access(noteId), key => decryptNoteBytes(key, envelope.payload, { noteId, kind, identity }));
  }
  encode(noteId: string, kind: string, identity: string, value: unknown): string {
    return this.state(noteId) ? this.seal(noteId, kind, identity, Buffer.from(JSON.stringify(value))) : JSON.stringify(value);
  }
  decode<T>(noteId: string, kind: string, identity: string, stored: unknown): T {
    this.assert(noteId);
    const json = String(stored);
    return JSON.parse(this.state(noteId) ? this.open(noteId, kind, identity, json).toString('utf8') : json) as T;
  }
}
