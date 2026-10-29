import type { NoteCiphertext, NotePasswordRecord } from './note-crypto.js';

/** 密码与逐篇密钥的持久化端口；替换密码须原子校验版本。 */
export interface NoteSecurityRepository {
  password(): NotePasswordRecord | undefined;
  replacePassword(expectedRevision: number, record: NotePasswordRecord): void;
  key(noteId: string): NoteCiphertext | undefined;
  insertKey(noteId: string, key: NoteCiphertext): void;
}
