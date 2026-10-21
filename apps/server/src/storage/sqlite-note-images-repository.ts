import type { DatabaseSync } from 'node:sqlite';
import { NOTE_IMAGE_LIMITS, noteImageReferences, type NoteImage } from '@multivac/contracts';
import { NotesError } from '../modules/notes/note.js';
import type { NoteImagesRepository } from '../modules/notes/note-image.js';
import { runInTransaction } from './sqlite-transaction.js';

export const NOTE_IMAGES_MIGRATION = `
  CREATE TABLE IF NOT EXISTS app_note_image (
    id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES app_note(id),
    metadata TEXT NOT NULL, content BLOB NOT NULL, created_at INTEGER NOT NULL, retained INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE INDEX IF NOT EXISTS app_note_image_owner ON app_note_image(note_id);
`;

/** 附件内容和元数据一次提交；不参与会话附件清理，也不按正文移除立即回收。 */
export class SqliteNoteImagesRepository implements NoteImagesRepository {
  constructor(private readonly db: DatabaseSync) {}

  private requireNote(noteId: string): void {
    const row = this.db.prepare("SELECT id FROM app_note WHERE id=? AND json_extract(record_json,'$.deleted') IS NOT 1").get(noteId);
    if (!row) throw new NotesError('笔记不存在或已删除。', 404);
  }
  get(noteId: string, id: string): NoteImage {
    this.requireNote(noteId);
    const row = this.db.prepare('SELECT metadata,retained FROM app_note_image WHERE id=? AND note_id=?').get(id, noteId);
    if (!row) throw new NotesError('图片不存在或不属于此笔记。', 404);
    return { ...JSON.parse(String(row.metadata)) as NoteImage, retained: row.retained === 1 };
  }
  read(noteId: string, id: string): { image: NoteImage; data: Buffer } {
    const image = this.get(noteId, id);
    const row = this.db.prepare('SELECT content FROM app_note_image WHERE id=? AND note_id=?').get(id, noteId)!;
    return { image, data: Buffer.from(row.content as Uint8Array) };
  }
  insert(image: NoteImage, data: Buffer): NoteImage {
    return runInTransaction(this.db, () => {
      // 解码之后重新核对墓碑；笔记删除期间的迟到上传不能登记附件。
      this.requireNote(image.noteId);
      const existing = this.db.prepare('SELECT id FROM app_note_image WHERE id=? AND note_id=?').get(image.id, image.noteId);
      if (existing) return this.get(image.noteId, image.id);
      const budget = this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(length(content)),0) AS bytes FROM app_note_image WHERE note_id=?').get(image.noteId)!;
      if (Number(budget.count) >= NOTE_IMAGE_LIMITS.count || Number(budget.bytes) + data.length > NOTE_IMAGE_LIMITS.totalBytes) throw new NotesError('每篇笔记最多 200 张图片，总大小不超过 100 MiB（含保留的上传）。', 413);
      this.db.prepare('INSERT INTO app_note_image(id,note_id,metadata,content,created_at) VALUES (?,?,?,?,?)').run(image.id, image.noteId, JSON.stringify(image), data, Date.now());
      return image;
    });
  }
  /** 调用方在正文版本事务内执行；任何一项失败都会回滚正文和保留状态。 */
  retainReferences(noteId: string, body: string): void {
    let ids: string[];
    try { ids = noteImageReferences(body); } catch (error) { throw new NotesError((error as Error).message); }
    for (const id of ids) {
      const row = this.db.prepare('SELECT id FROM app_note_image WHERE id=? AND note_id=?').get(id, noteId);
      if (!row) throw new NotesError('正文引用了不存在或不属于此笔记的图片。');
    }
    for (const id of ids) this.db.prepare('UPDATE app_note_image SET retained=1 WHERE id=? AND note_id=?').run(id, noteId);
  }
}
