import { secureWindowsPrivateDirectory } from './private-directory.js';
import { publishReplacementSync } from './file-durability.js';
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkedIlinkBase } from '../modules/notifications/wechat/client.js';

import type { PrivateWechatBinding, PrivateWechatBindingStore } from '../modules/notifications/wechat/binding.js';

/** 与公开业务库分开，整份原子替换确保去重、上下文和游标一起保存。不会保存入站正文。 */
export class PrivateWechatStore implements PrivateWechatBindingStore {
  constructor(private readonly root: string) {}
  private path(): string { return join(this.root, 'binding.json'); }
  load(): PrivateWechatBinding | null {
    try {
      const directory = lstatSync(this.root);
      if (!directory.isDirectory() || directory.isSymbolicLink() || (process.platform !== 'win32' && (directory.mode & 0o077))) throw new Error();
      secureWindowsPrivateDirectory(this.root, 'binding.json');
      const stat = lstatSync(this.path());
      if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error();
      const value = JSON.parse(readFileSync(this.path(), 'utf8')) as PrivateWechatBinding;
      if (!value || ![value.channelId, value.botId, value.userId, value.token].every(s => typeof s === 'string' && s.trim()) ||
        !Number.isSafeInteger(value.generation) || value.generation < 1 || checkedIlinkBase(value.apiBase) !== value.apiBase ||
        typeof value.cursor !== 'string' || !Array.isArray(value.seenIds) || !value.seenIds.every(id => typeof id === 'string') ||
        !(value.contextToken === null || typeof value.contextToken === 'string' && value.contextToken.trim()) ||
        !(value.contextObservedAt === null || typeof value.contextObservedAt === 'string' && Number.isFinite(Date.parse(value.contextObservedAt))) ||
        (!!value.contextToken !== !!value.contextObservedAt)) throw new Error();
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('微信私有资料不可用，请在本机重新绑定。');
    }
  }
  save(value: PrivateWechatBinding): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('微信私有目录不可用。');
    if (process.platform === 'win32') secureWindowsPrivateDirectory(this.root, 'binding.json');
    else chmodSync(this.root, 0o700);
    const temporary = join(this.root, `.binding-${randomUUID()}.tmp`);
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
    finally { closeSync(fd); }
    try {
      publishReplacementSync(temporary, this.path());
    } finally { try { unlinkSync(temporary); } catch { /* 已原子移动。 */ } }
  }
  clear(): void {
    try { unlinkSync(this.path()); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('微信私有资料清除失败。'); }
  }
}
