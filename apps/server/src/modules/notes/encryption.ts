import type { NoteAccess } from '@multivac/contracts';

/** 数据库与托管文件的加密转换端口，状态只表示持久化的转换进度。 */
export interface NoteEncryption {
  /** needsPassword：普通笔记沿用此前加密留下的逐篇密钥，重新加密须输入密码打开它。 */
  status(noteId: string): { state: 'plain' | 'encrypting' | 'encrypted' | 'decrypting'; needsPassword?: true };
  encrypt(noteId: string, expectedRevision: number, access: NoteAccess): void;
  /** 不需要密码：为当前窗口签发只限这一篇的凭证并加密，失败时撤销凭证；返回该凭证。 */
  encryptNew(noteId: string, expectedRevision: number, window: string): NoteAccess;
  decrypt(noteId: string, expectedRevision: number, access: NoteAccess): void;
  recover(noteId: string, access: NoteAccess): void;
}
