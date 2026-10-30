import type { NotePasswordRecord, NoteSealedKey } from './note-crypto.js';

/** 密钥对记录与逐篇密钥的持久化端口；替换密码须原子校验版本。 */
export interface NoteSecurityRepository {
  password(): NotePasswordRecord | undefined;
  replacePassword(expectedRevision: number, record: NotePasswordRecord): void;
  key(noteId: string): NoteSealedKey | undefined;
  insertKey(noteId: string, key: NoteSealedKey): void;
}
