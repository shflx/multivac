import { randomBytes } from 'node:crypto';
import { createNoteKeys, openNoteDataKey, protectNotePrivateKey, sealNoteDataKey, unprotectNotePrivateKey, type NotePasswordRecord, type NoteSealedKey } from '../modules/notes/note-crypto.js';
import { NotesError } from '../modules/notes/note.js';
import type { NoteSecurityRepository } from '../modules/notes/security-repository.js';

import { NOTE_IDLE_TIMEOUT_MS, type NoteAccess } from '@multivac/contracts';
export { NOTE_IDLE_TIMEOUT_MS, NOTE_ACCESS_HEADER, NOTE_WINDOW_HEADER, type NoteAccess } from '@multivac/contracts';
/**
 * 两种窗口凭证：输入密码解锁得到私钥凭证，可打开该篇的逐篇密钥；
 * 加密新笔记时得到数据凭证，只持有该篇刚生成的逐篇密钥，并绑定其封装记录。
 */
type GrantSecret = { kind: 'private'; key: Buffer } | { kind: 'data'; key: Buffer; sealed: string };
interface Grant { noteId: string; window: string; secret: GrantSecret; lastActivity: number; passwordRevision: number }

/** 公开窗口 ID 不作为授权。两个随机秘密只驻留当前页面内存，不使用 Cookie 或 URL。 */
export class NoteSecurityService {
  private readonly grants = new Map<string, Grant>();
  private readonly listeners = new Set<(noteId: string, token: string) => void>();
  private readonly timer: ReturnType<typeof setInterval>;
  private deriving = false;
  constructor(readonly repository: NoteSecurityRepository, private readonly now = Date.now) {
    this.timer = setInterval(() => this.expire(), 1000);
    this.timer.unref();
  }
  status() { return { configured: !!this.repository.password(), idleTimeoutMs: NOTE_IDLE_TIMEOUT_MS }; }
  onRevoke(listener: (noteId: string, token: string) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private revoke(token: string): void {
    const grant = this.grants.get(token);
    if (!grant) return;
    this.grants.delete(token);
    // 先禁止新访问，再通知订阅者停止交付；每份凭证独立持有可清零的密钥。
    for (const listener of this.listeners) { try { listener(grant.noteId, token); } catch { /* 单个订阅失败不能阻止凭证撤销和密钥释放。 */ } }
    grant.secret.key.fill(0);
  }
  private expire(): void {
    const revision = this.repository.password()?.revision;
    for (const [token, grant] of this.grants) if (this.now() - grant.lastActivity >= NOTE_IDLE_TIMEOUT_MS || grant.passwordRevision !== revision) this.revoke(token);
  }
  /** 当前密钥对记录；旧版记录无法用于新格式，给出明确的重新设置提示。 */
  private keys(): NotePasswordRecord {
    const current = this.repository.password();
    if (!current) throw new NotesError('请先设置笔记密码。', 409);
    if (current.format !== 2) throw new NotesError('笔记密码记录是旧版本，请在偏好中重新设置。', 409);
    return current;
  }
  private async derive<T>(operation: () => Promise<T>): Promise<T> {
    // 派生较耗资源；本实例同一时刻只接受一次，避免密码接口耗尽工作线程。
    if (this.deriving) throw new NotesError('正在验证密码，请稍后重试。', 429);
    this.deriving = true;
    try { return await operation(); } finally { this.deriving = false; }
  }
  async initialize(password: string): Promise<void> {
    return this.derive(async () => {
      if (this.repository.password()) throw new NotesError('共用密码已设置。', 409);
      this.repository.replacePassword(0, await createNoteKeys(password, 1));
    });
  }
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    return this.derive(async () => {
      const current = this.keys();
      // 只重新保护私钥；公钥和逐篇密钥不变，已加密笔记无需重新加密。
      const privateKey = await unprotectNotePrivateKey(currentPassword, current);
      try {
        const replacement = await protectNotePrivateKey(newPassword, privateKey, current.publicKey, current.revision + 1);
        this.repository.replacePassword(current.revision, replacement);
        for (const token of this.grants.keys()) this.revoke(token);
      } finally { privateKey.fill(0); }
    });
  }
  async unlock(noteId: string, password: string, window: string): Promise<{ token: string; idleTimeoutMs: number }> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(noteId) || !/^[A-Za-z0-9_-]{32,128}$/u.test(window)) throw new NotesError('笔记身份或窗口凭据无效。');
    return this.derive(async () => {
      const current = this.keys();
      const key = await unprotectNotePrivateKey(password, current);
      if (this.repository.password()?.revision !== current.revision) { key.fill(0); throw new NotesError('密码已变化，请重新解锁。', 409); }
      return this.issue(noteId, window, { kind: 'private', key }, current.revision);
    });
  }
  private issue(noteId: string, window: string, secret: GrantSecret, passwordRevision: number): { token: string; idleTimeoutMs: number } {
    this.expire();
    for (const [token, grant] of this.grants) if (grant.window === window && grant.noteId === noteId) this.revoke(token);
    if (this.grants.size >= 256) { secret.key.fill(0); throw new NotesError('解锁窗口数量超过限制，请先锁定不再使用的窗口。', 429); }
    const token = randomBytes(32).toString('base64url');
    this.grants.set(token, { noteId, window, secret, lastActivity: this.now(), passwordRevision });
    return { token, idleTimeoutMs: NOTE_IDLE_TIMEOUT_MS };
  }
  /**
   * 为尚未加密的笔记生成逐篇密钥，只用公钥封装，不需要密码；当前窗口取得只限这一篇的数据凭证。
   * 封装记录由 createDataKey 在转换事务内写入，转换失败时由调用方撤销凭证。
   */
  beginEncryption(noteId: string, window: string): NoteAccess {
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(noteId) || !/^[A-Za-z0-9_-]{32,128}$/u.test(window)) throw new NotesError('笔记身份或窗口凭据无效。');
    const current = this.keys();
    if (this.repository.key(noteId)) throw new NotesError('笔记已有加密密钥，请输入笔记密码。', 409);
    const key = randomBytes(32);
    const sealed = JSON.stringify(sealNoteDataKey(current.publicKey, noteId, key));
    return { ...this.issue(noteId, window, { kind: 'data', key, sealed }, current.revision), window };
  }
  private grant(noteId: string, access?: NoteAccess): Grant {
    this.expire();
    const grant = access && this.grants.get(access.token);
    if (!grant || grant.noteId !== noteId || grant.window !== access!.window) throw new NotesError('笔记已锁定，请输入共用密码解锁。', 423);
    return grant;
  }
  hasDataKey(noteId: string): boolean { return !!this.repository.key(noteId); }
  assertAccess(noteId: string, access?: NoteAccess): void { this.grant(noteId, access); }
  touch(noteId: string, access: NoteAccess): void { this.grant(noteId, access).lastActivity = this.now(); }
  lock(noteId: string, access: NoteAccess): void {
    this.grant(noteId, access);
    this.revoke(access.token);
  }
  /** 只供受保护仓储使用；调用前始终重新核对具体笔记的窗口资格。 */
  withDataKey<T>(noteId: string, access: NoteAccess | undefined, operation: (key: Buffer) => T): T {
    const grant = this.grant(noteId, access);
    const sealed = this.repository.key(noteId);
    if (!sealed) throw new NotesError('笔记密钥不存在。', 409);
    const key = this.dataKey(noteId, grant, sealed);
    try { return operation(key); } finally { key.fill(0); }
  }
  /** 取出逐篇密钥的副本：数据凭证须与当前封装记录一致，防止取消加密后重新加密时沿用旧密钥。 */
  private dataKey(noteId: string, grant: Grant, sealed: NoteSealedKey): Buffer {
    if (grant.secret.kind === 'data') {
      if (grant.secret.sealed !== JSON.stringify(sealed)) throw new NotesError('笔记密钥已变化，请输入笔记密码。', 423);
      return Buffer.from(grant.secret.key);
    }
    return openNoteDataKey(grant.secret.key, this.keys().publicKey, noteId, sealed);
  }
  /** 在存储转换事务内写入封装记录，失败时随同转换回滚；密码解锁的凭证当场生成新密钥。 */
  createDataKey(noteId: string, access: NoteAccess): void {
    const grant = this.grant(noteId, access);
    if (this.repository.key(noteId)) return;
    if (grant.secret.kind === 'data') { this.repository.insertKey(noteId, JSON.parse(grant.secret.sealed) as NoteSealedKey); return; }
    const current = this.keys();
    const key = randomBytes(32);
    try { this.repository.insertKey(noteId, sealNoteDataKey(current.publicKey, noteId, key)); }
    finally { key.fill(0); }
  }
  close(): void {
    clearInterval(this.timer);
    for (const token of this.grants.keys()) this.revoke(token);
    this.listeners.clear();
  }
}
