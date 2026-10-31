import { closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { link, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Windows 不支持 POSIX 目录刷新。返回值明确表示保证较弱，不能当作目录已持久化。 */
export async function syncDirectory(path: string, platform: NodeJS.Platform = process.platform): Promise<'directory' | 'file-only'> {
  if (platform === 'win32') return 'file-only';
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  return 'directory';
}
export function syncDirectorySync(path: string, platform: NodeJS.Platform = process.platform): 'directory' | 'file-only' {
  if (platform === 'win32') return 'file-only';
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  return 'directory';
}

export class FilePublicationError extends Error {
  constructor(readonly commitState: 'not-committed' | 'unknown', readonly backup: string | null, cause: unknown) {
    super(commitState === 'unknown' ? '文件替换结果尚未可靠确认，保留旧副本；请只读核对，不自动重试。' : '文件替换未提交，原文件保留。', { cause });
  }
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
/** temporary 必须已完成文件 fsync；Windows 旧副本直到新内容核对及刷新成功后才解除。 */
export async function publishReplacement(temporary: string, target: string, platform: NodeJS.Platform = process.platform,
  io = { link, open, readFile, rename, unlink, syncDirectory }): Promise<void> {
  let backup: string | null = null, renamed = false;
  try {
    const expected = platform === 'win32' ? await io.readFile(temporary) : null;
    if (platform === 'win32') {
      const candidate = `${target}.previous-${randomUUID()}`;
      try { await io.link(target, candidate); backup = candidate; } catch (error) { if (!missing(error)) throw error; }
    }
    await io.rename(temporary, target); renamed = true;
    if (expected) {
      const handle = await io.open(target, 'r+');
      try {
        if (!(await handle.readFile()).equals(expected)) throw new Error('替换后的文件内容不一致。');
        await handle.sync();
      } finally { await handle.close(); }
    }
    await io.syncDirectory(dirname(target), platform);
    if (backup) await io.unlink(backup);
  } catch (cause) { throw new FilePublicationError(renamed ? 'unknown' : 'not-committed', backup, cause); }
}
export function publishReplacementSync(temporary: string, target: string, platform: NodeJS.Platform = process.platform): void {
  let backup: string | null = null, renamed = false;
  try {
    const expected = platform === 'win32' ? readFileSync(temporary) : null;
    if (platform === 'win32') {
      const candidate = `${target}.previous-${randomUUID()}`;
      try { linkSync(target, candidate); backup = candidate; } catch (error) { if (!missing(error)) throw error; }
    }
    renameSync(temporary, target); renamed = true;
    if (expected) {
      const fd = openSync(target, 'r+');
      try {
        if (!readFileSync(fd).equals(expected)) throw new Error('替换后的文件内容不一致。');
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
    syncDirectorySync(dirname(target), platform);
    if (backup) unlinkSync(backup);
  } catch (cause) { throw new FilePublicationError(renamed ? 'unknown' : 'not-committed', backup, cause); }
}
