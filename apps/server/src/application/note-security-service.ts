import { randomBytes } from 'node:crypto';
import { decryptNoteBytes, encryptNoteBytes, protectNoteMaster, unprotectNoteMaster } from '../modules/notes/note-crypto.js';
import { NotesError } from '../modules/notes/note.js';
import type { NoteSecurityRepository } from '../modules/notes/security-repository.js';

import { NOTE_IDLE_TIMEOUT_MS, type NoteAccess } from '@multivac/contracts';
export { NOTE_IDLE_TIMEOUT_MS, NOTE_ACCESS_HEADER, NOTE_WINDOW_HEADER, type NoteAccess } from '@multivac/contracts';
interface Grant { noteId: string; window: string; master: Buffer; lastActivity: number; passwordRevision: number }

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
    grant.master.fill(0);
  }
  private expire(): void {
    const revision = this.repository.password()?.revision;
    for (const [token, grant] of this.grants) if (this.now() - grant.lastActivity >= NOTE_IDLE_TIMEOUT_MS || grant.passwordRevision !== revision) this.revoke(token);
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
      const master = randomBytes(32);
      try { this.repository.replacePassword(0, await protectNoteMaster(password, master, 1)); }
      finally { master.fill(0); }
    });
  }
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    return this.derive(async () => {
      const current = this.repository.password();
      if (!current) throw new NotesError('请先设置共用密码。', 409);
      const master = await unprotectNoteMaster(currentPassword, current);
      try {
        const replacement = await protectNoteMaster(newPassword, master, current.revision + 1);
        this.repository.replacePassword(current.revision, replacement);
        for (const token of this.grants.keys()) this.revoke(token);
      } finally { master.fill(0); }
    });
  }
  async unlock(noteId: string, password: string, window: string): Promise<{ token: string; idleTimeoutMs: number }> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(noteId) || !/^[A-Za-z0-9_-]{32,128}$/u.test(window)) throw new NotesError('笔记身份或窗口凭据无效。');
    return this.derive(async () => {
      const current = this.repository.password();
      if (!current) throw new NotesError('请先设置共用密码。', 409);
      const master = await unprotectNoteMaster(password, current);
      if (this.repository.password()?.revision !== current.revision) { master.fill(0); throw new NotesError('密码已变化，请重新解锁。', 409); }
      this.expire();
      for (const [token, grant] of this.grants) if (grant.window === window && grant.noteId === noteId) this.revoke(token);
      if (this.grants.size >= 256) { master.fill(0); throw new NotesError('解锁窗口数量超过限制，请先锁定不再使用的窗口。', 429); }
      const token = randomBytes(32).toString('base64url');
      this.grants.set(token, { noteId, window, master, lastActivity: this.now(), passwordRevision: current.revision });
      return { token, idleTimeoutMs: NOTE_IDLE_TIMEOUT_MS };
    });
  }
  private grant(noteId: string, access?: NoteAccess): Grant {
    this.expire();
    const grant = access && this.grants.get(access.token);
    if (!grant || grant.noteId !== noteId || grant.window !== access!.window) throw new NotesError('笔记已锁定，请输入共用密码解锁。', 423);
    return grant;
  }
  assertAccess(noteId: string, access?: NoteAccess): void { this.grant(noteId, access); }
  touch(noteId: string, access: NoteAccess): void { this.grant(noteId, access).lastActivity = this.now(); }
  lock(noteId: string, access: NoteAccess): void {
    this.grant(noteId, access);
    this.revoke(access.token);
  }
  /** 只供受保护仓储使用；调用前始终重新核对具体笔记的窗口资格。 */
  withDataKey<T>(noteId: string, access: NoteAccess | undefined, operation: (key: Buffer) => T): T {
    const grant = this.grant(noteId, access);
    const wrapped = this.repository.key(noteId);
    if (!wrapped) throw new NotesError('笔记密钥不存在。', 409);
    const key = decryptNoteBytes(grant.master, wrapped, { noteId, kind: 'data-key', identity: '1' });
    try { return operation(key); } finally { key.fill(0); }
  }
  /** 在存储转换事务内创建，失败时随同转换回滚。 */
  createDataKey(noteId: string, access: NoteAccess): void {
    const grant = this.grant(noteId, access);
    if (this.repository.key(noteId)) return;
    const key = randomBytes(32);
    try { this.repository.insertKey(noteId, encryptNoteBytes(grant.master, key, { noteId, kind: 'data-key', identity: '1' })); }
    finally { key.fill(0); }
  }
  close(): void {
    clearInterval(this.timer);
    for (const token of this.grants.keys()) this.revoke(token);
    this.listeners.clear();
  }
}
