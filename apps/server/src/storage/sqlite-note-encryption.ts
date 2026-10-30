import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { NoteAccess } from '@multivac/contracts';
import { NotesError } from '../modules/notes/note.js';
import type { NoteRecordCodec } from './note-record-codec.js';
import type { NoteEncryption } from '../modules/notes/encryption.js';
import type { NoteSecurityService } from '../application/note-security-service.js';
import type { NotesService } from '../application/notes-service.js';
import { runInTransaction } from './sqlite-transaction.js';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type FaultStage = 'before-commit' | 'after-commit' | 'before-cleanup' | 'after-cleanup' | 'restore-written';
interface FileSnapshot { path: string; sessionId: string; bytes: Buffer }

/** SQLite 记录与图片共用事务，Pi 文件使用先保存密文、再清理旧副本的恢复协议。 */
export class SqliteNoteEncryption implements NoteEncryption {
  constructor(readonly codec: NoteRecordCodec, private readonly security: NoteSecurityService, private readonly notes: NotesService,
    private readonly lifecycle: { check(noteId: string): void; release(noteId: string): void },
    private readonly sessionRoot: string, private readonly fault?: (stage: FaultStage) => void, private readonly imageRoot = join(dirname(sessionRoot), 'images')) {}

  status(noteId: string): ReturnType<NoteEncryption['status']> {
    const state = this.codec.state(noteId) ?? 'plain';
    // 取消加密后保留逐篇密钥，供各窗口恢复旧密文草稿；再次加密沿用它，因此需要密码。
    return state === 'plain' && this.security.hasDataKey(noteId) ? { state, needsPassword: true } : { state };
  }
  private file(path: string): Buffer {
    const full = resolve(path), root = [this.sessionRoot, this.imageRoot].map(value => resolve(value)).find(value => full.startsWith(value + sep));
    if (!root) throw new NotesError('讨论文件不在当前实例会话目录，无法安全转换。', 409);
    if (!realpathSync(dirname(full)).startsWith(realpathSync(root) + sep) && realpathSync(dirname(full)) !== realpathSync(root)) throw new NotesError('讨论文件路径越出会话目录。', 409);
    const stat = lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw new NotesError('讨论文件类型或大小不支持转换。', 409);
    return readFileSync(full);
  }
  private sessions(noteId: string): string[] {
    return this.codec.database.prepare('SELECT session_id FROM app_note_discussion WHERE note_id=?').all(noteId).map(row => String(row.session_id));
  }
  private inventory(noteId: string): FileSnapshot[] {
    const database = this.codec.database;
    return this.sessions(noteId).flatMap(sessionId => {
      if (database.prepare('SELECT 1 FROM context_compaction WHERE session_id=? AND active=1').get(sessionId)) throw new NotesError('讨论上下文压缩尚未结束，请先完成对账。', 409);
      const binding = database.prepare('SELECT runtime_session_ref FROM assistant_session_binding WHERE assistant_id=?').get(sessionId);
      const images = database.prepare('SELECT id FROM image_attachment WHERE session_id=?').all(sessionId).map(row => {
        const id = String(row.id); if (!/^[a-f0-9]{64}$/u.test(id)) throw new NotesError('讨论图片身份无效，不能转换。', 409);
        const path = join(this.imageRoot, id); return { path, sessionId, bytes: this.file(path) };
      });
      if (!binding) return images;
      const path = String(binding.runtime_session_ref);
      const bytes = this.file(path);
      try { for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) JSON.parse(line); }
      catch { throw new NotesError('讨论文件不完整，不能确认转换。', 409); }
      return [...images, { path, sessionId, bytes }];
    });
  }
  private transform(noteId: string, encrypted: boolean): void {
    const database = this.codec.database;
    const change = (table: string, column: string, kind: string, key: string, where: string, args: string[], binary = false) => {
      for (const row of database.prepare(`SELECT rowid AS row_key,${key} AS identity,${column} AS stored FROM ${table} WHERE ${where}`).all(...args)) {
        const identity = String(row.identity);
        const bytes = binary ? Buffer.from(row.stored as Uint8Array) : Buffer.from(String(row.stored));
        const next = encrypted ? Buffer.from(this.codec.seal(noteId, kind, identity, bytes)) : this.codec.open(noteId, kind, identity, bytes.toString('utf8'));
        // 切换引用前实际解密核对，禁止仅凭加密函数返回成功就清除唯一明文副本。
        if (encrypted && !this.codec.open(noteId, kind, identity, next.toString('utf8')).equals(bytes)) throw new NotesError('加密结果校验失败。', 409);
        database.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`).run(binary ? next : next.toString('utf8'), row.row_key!);
      }
    };
    for (const [table, column, kind, key, owner] of [
      ['app_note', 'record_json', 'note', 'id', 'id'],
      ['app_note_version', 'record_json', 'version', 'revision', 'note_id'],
      ['app_note_summary', 'summary_json', 'summary', 'id', 'id'],
      ['app_note_version_summary', 'summary_json', 'version-summary', 'revision', 'note_id'],
      ['app_note_command', 'result_json', 'command', 'command_id', 'note_id'],
      ['app_note_discussion', 'record_json', 'discussion', 'session_id', 'note_id'],
      ['app_note_context', 'record_json', 'context', 'id', 'note_id'],
      ['app_note_suggestion', 'record_json', 'suggestion', 'id', 'note_id'],
      ['app_note_image', 'metadata', 'image-metadata', 'id', 'note_id'],
    ] as const) change(table, column, kind, key, `${owner}=?`, [noteId]);
    change('app_note_image', 'content', 'image', 'id', 'note_id=?', [noteId], true);
    for (const sessionId of this.sessions(noteId)) {
      change('assistant_session_registry', 'title', 'session-title', 'session_id', 'session_id=?', [sessionId]);
      change('assistant_page_state', 'draft', 'page-draft', 'assistant_id', 'assistant_id=?', [sessionId]);
      // 字符串列的 JSON 编码与通用 JSON 记录不同，统一在原始字节转换前后处理。
      if (encrypted) {
        const title = database.prepare('SELECT title FROM assistant_session_registry WHERE session_id=?').get(sessionId)!;
        const plain = this.codec.open(noteId, 'session-title', sessionId, String(title.title)).toString();
        database.prepare('UPDATE assistant_session_registry SET title=? WHERE session_id=?').run(this.codec.encode(noteId, 'session-title', sessionId, plain), sessionId);
        const page = database.prepare('SELECT draft FROM assistant_page_state WHERE assistant_id=?').get(sessionId);
        if (page) {
          const draft = this.codec.open(noteId, 'page-draft', sessionId, String(page.draft)).toString();
          database.prepare('UPDATE assistant_page_state SET draft=? WHERE assistant_id=?').run(this.codec.encode(noteId, 'page-draft', sessionId, draft), sessionId);
        }
      } else {
        const title = database.prepare('SELECT title FROM assistant_session_registry WHERE session_id=?').get(sessionId)!;
        database.prepare('UPDATE assistant_session_registry SET title=? WHERE session_id=?').run(JSON.parse(String(title.title)), sessionId);
        const page = database.prepare('SELECT draft FROM assistant_page_state WHERE assistant_id=?').get(sessionId);
        if (page) database.prepare('UPDATE assistant_page_state SET draft=? WHERE assistant_id=?').run(JSON.parse(String(page.draft)), sessionId);
      }
      change('assistant_page_state', 'quote_json', 'page-quote', 'assistant_id', 'assistant_id=? AND quote_json IS NOT NULL', [sessionId]);
      change('assistant_event_projection', 'payload_json', 'event', 'source_key', 'assistant_id=?', [sessionId]);
      change('image_attachment', 'metadata', 'discussion-image', 'id', 'session_id=?', [sessionId]);
      change('message_image_source', 'sources', 'message-images', "runtime_session_id || ':' || entry_id", 'session_id=?', [sessionId]);
      change('assistant_message_file_source', 'references_json', 'message-files', "runtime_session_id || ':' || runtime_entry_id", 'session_id=?', [sessionId]);
      change('context_compaction', 'record_json', 'compaction', 'operation_id', 'session_id=?', [sessionId]);
      change('assistant_command_receipt', 'error_message', 'command-error', 'command_id', 'assistant_id=? AND error_message IS NOT NULL', [sessionId]);
      for (const row of database.prepare('SELECT command_id,error_message FROM assistant_command_receipt WHERE assistant_id=? AND error_message IS NOT NULL').all(sessionId)) {
        const id = String(row.command_id);
        const value = encrypted ? this.codec.open(noteId, 'command-error', id, String(row.error_message)).toString() : JSON.parse(String(row.error_message));
        database.prepare('UPDATE assistant_command_receipt SET error_message=? WHERE command_id=?').run(encrypted ? this.codec.encode(noteId, 'command-error', id, value) : value, id);
      }
      if (database.prepare('SELECT origin_json FROM assistant_session_registry WHERE session_id=? AND origin_json IS NOT NULL').get(sessionId)) throw new NotesError('讨论存在无法核对的通用来源引用，转换已回滚。', 409);
    }
  }
  private associateCommands(noteId: string): void {
    const owns = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') return false;
      if (Array.isArray(value)) return value.some(owns);
      const record = value as Record<string, unknown>;
      return record.noteId === noteId || record.id === noteId && 'body' in record || Object.values(record).some(owns);
    };
    for (const row of this.codec.database.prepare('SELECT command_id,result_json FROM app_note_command WHERE note_id IS NULL').all()) {
      if (owns(JSON.parse(String(row.result_json)))) this.codec.database.prepare('UPDATE app_note_command SET note_id=? WHERE command_id=?').run(noteId, row.command_id!);
    }
  }
  encrypt(noteId: string, expectedRevision: number, access: NoteAccess): void {
    return this.codec.conversion(access, () => {
      this.security.assertAccess(noteId, access);
      const state = this.codec.state(noteId);
      if (state === 'encrypting') { this.recover(noteId, access); return; }
      if (state) throw new NotesError('笔记已加密或有待恢复转换。', 409);
      this.lifecycle.check(noteId);
      if (this.notes.get(noteId).revision !== expectedRevision) throw new NotesError('笔记已变化，请先保存并核对最新版本。', 409);
      const files = this.inventory(noteId);
      this.lifecycle.release(noteId);
      const database = this.codec.database;
      database.exec('PRAGMA secure_delete=ON');
      runInTransaction(database, () => {
        this.security.createDataKey(noteId, access);
        database.prepare("INSERT INTO app_note_protection VALUES (?,'encrypting')").run(noteId);
        this.associateCommands(noteId);
        this.transform(noteId, true);
        for (const file of files) {
          if (!this.file(file.path).equals(file.bytes)) throw new NotesError('讨论文件在转换时变化，请重新核对。', 409);
          const content = this.codec.seal(noteId, 'managed-file', JSON.stringify([file.sessionId, file.path]), file.bytes);
          if (!this.codec.open(noteId, 'managed-file', JSON.stringify([file.sessionId, file.path]), content).equals(file.bytes)) throw new NotesError('讨论密文校验失败。', 409);
          database.prepare('INSERT INTO app_note_protected_file(path,note_id,session_id,content,cleanup_pending) VALUES (?,?,?,?,1)').run(file.path, noteId, file.sessionId, content);
        }
        this.fault?.('before-commit');
      });
      this.fault?.('after-commit');
      this.recover(noteId, access);
    });
  }
  encryptNew(noteId: string, expectedRevision: number, window: string): NoteAccess {
    if (this.codec.state(noteId)) throw new NotesError('笔记已加密或有待恢复转换，请输入笔记密码。', 409);
    const access = this.security.beginEncryption(noteId, window);
    try { this.encrypt(noteId, expectedRevision, access); }
    catch (error) {
      // 未提交的转换不留下凭证；已提交但清理未完成时保留凭证，供页面继续恢复。
      if (!this.codec.state(noteId)) this.security.lock(noteId, access);
      throw error;
    }
    return access;
  }
  recover(noteId: string, access: NoteAccess): void {
    this.codec.conversion(access, () => {
      this.security.assertAccess(noteId, access);
      const database = this.codec.database, state = this.codec.state(noteId);
      if (state === 'encrypting') {
        for (const row of database.prepare('SELECT path,session_id,content FROM app_note_protected_file WHERE note_id=? AND cleanup_pending=1').all(noteId)) {
          const path = String(row.path), bytes = this.codec.open(noteId, 'managed-file', JSON.stringify([String(row.session_id), path]), String(row.content));
          this.fault?.('before-cleanup');
          if (existsSync(path)) {
            if (digest(this.file(path)) !== digest(bytes)) throw new NotesError('旧讨论文件已变化，保留副本等待人工核对。', 409);
            unlinkSync(path);
            const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
          }
          database.prepare('UPDATE app_note_protected_file SET cleanup_pending=0 WHERE path=?').run(path);
          this.fault?.('after-cleanup');
        }
        const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (Number(checkpoint?.busy) !== 0) throw new NotesError('数据库日志仍在使用中，请稍后恢复转换。', 409);
        database.prepare("UPDATE app_note_protection SET state='encrypted' WHERE note_id=?").run(noteId);
      } else if (state === 'decrypting') {
        // 先可靠写回普通会话文件，最后一次事务才恢复普通数据库记录。
        for (const row of database.prepare('SELECT path,session_id,content,restore_temp FROM app_note_protected_file WHERE note_id=?').all(noteId)) {
          const path = String(row.path), bytes = this.codec.open(noteId, 'managed-file', JSON.stringify([String(row.session_id), path]), String(row.content));
          this.fault?.('before-cleanup');
          if (existsSync(path)) { if (!this.file(path).equals(bytes)) throw new NotesError('普通讨论文件与原密文不一致，保留副本等待核对。', 409); }
          else {
            const temporary = row.restore_temp ? String(row.restore_temp) : `${path}.restoring-${randomBytes(16).toString('hex')}`;
            if (!row.restore_temp) database.prepare('UPDATE app_note_protected_file SET restore_temp=? WHERE path=?').run(temporary, path);
            if (existsSync(temporary)) {
              const partial = this.file(temporary);
              if (partial.length > bytes.length || !bytes.subarray(0, partial.length).equals(partial)) throw new NotesError('恢复临时文件与原密文不一致，请人工核对。', 409);
              unlinkSync(temporary);
            }
            const file = openSync(temporary, 'wx', 0o600); try { writeFileSync(file, bytes); fsyncSync(file); } finally { closeSync(file); }
            this.fault?.('restore-written');
            renameSync(temporary, path);
            const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
          }
          this.fault?.('after-cleanup');
        }
        runInTransaction(database, () => {
          this.transform(noteId, false);
          database.prepare('DELETE FROM app_note_protected_file WHERE note_id=?').run(noteId);
          database.prepare('DELETE FROM app_note_protection WHERE note_id=?').run(noteId);
          this.fault?.('before-commit');
        });
      }
      this.notes.changed(noteId);
    });
  }
  decrypt(noteId: string, expectedRevision: number, access: NoteAccess): void {
    this.codec.conversion(access, () => {
      this.security.assertAccess(noteId, access);
      if (this.codec.state(noteId) === 'decrypting') { this.recover(noteId, access); return; }
      if (this.codec.state(noteId) !== 'encrypted') throw new NotesError('请先完成待恢复的加密转换。', 409);
      this.lifecycle.check(noteId);
      if (this.notes.get(noteId).revision !== expectedRevision) throw new NotesError('笔记版本已变化，请核对后重试。', 409);
      this.lifecycle.release(noteId);
      this.codec.database.prepare("UPDATE app_note_protection SET state='decrypting' WHERE note_id=?").run(noteId);
      this.fault?.('after-commit');
      this.recover(noteId, access);
    });
  }
}
