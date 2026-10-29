import type { NoteAccess } from '@multivac/contracts';

/** 数据库与托管文件的加密转换端口，状态只表示持久化的转换进度。 */
export interface NoteEncryption {
  status(noteId: string): { state: 'plain' | 'encrypting' | 'encrypted' | 'decrypting' };
  encrypt(noteId: string, expectedRevision: number, access: NoteAccess): void;
  decrypt(noteId: string, expectedRevision: number, access: NoteAccess): void;
  recover(noteId: string, access: NoteAccess): void;
}
