/** 执行器只接收明文读写端口，不接触密码或裸密钥。 */
export interface ProtectedManagedFiles {
  forSession(sessionId: string): boolean;
  has(path: string): boolean;
  readBytes(path: string): Buffer;
  createBytes(sessionId: string, path: string, content: Buffer): void;
  remove(path: string): void;
}
export interface ProtectedTranscriptStore {
  forSession(sessionId: string): boolean;
  has(path: string): boolean;
  read(path: string): string;
  create(sessionId: string, path: string, content: string): void;
  write(path: string, content: string): void;
  version(path: string): string;
}
