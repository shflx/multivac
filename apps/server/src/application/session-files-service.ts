import { lstat, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SESSION_FILE_LIMITS, type SessionFileEntry, type SessionFileList, type WorkspaceSession } from '@multivac/contracts';
import { isPathWithin } from '../modules/sessions/working-directory.js';

export class SessionFilesError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** 用户主动浏览只读取会话目录，不触发模型，也不扩大会话工具的授权范围。 */
export class SessionFilesService {
  constructor(private readonly sessions: { get(id: string): Pick<WorkspaceSession, 'archivedAt' | 'workingDirectory'> }, private readonly dataDir: string) {}

  async locate(id: string, path: string, expectedRoot?: string): Promise<{ root: string; absolute: string; path: string }> {
    const session = this.sessions.get(id);
    if (session.archivedAt || !session.workingDirectory) throw new SessionFilesError(404, '会话工作目录不可用。');
    const root = session.workingDirectory.path;
    if (expectedRoot !== undefined && expectedRoot !== root) throw new SessionFilesError(409, '工作目录已变化，请重新打开文件。');
    if (path.length > SESSION_FILE_LIMITS.pathLength || isAbsolute(path) || path.includes('\0') || path.includes('\\') || path.split('/').includes('..')) {
      throw new SessionFilesError(400, '文件路径必须位于当前会话工作目录内。');
    }
    const canonicalRoot = await realpath(root);
    const protectedRoot = await realpath(this.dataDir).catch(() => resolve(this.dataDir));
    if (isPathWithin(protectedRoot, canonicalRoot)) throw new SessionFilesError(403, '不能浏览应用内部数据目录。');
    const absolute = resolve(canonicalRoot, path);
    if (!isPathWithin(canonicalRoot, absolute)) throw new SessionFilesError(403, '文件超出会话工作目录。');
    // 不遍历符号链接，避免目录环路、外部目标以及其他会话临时目录泄漏。
    let current = canonicalRoot;
    for (const segment of relative(canonicalRoot, absolute).split(sep).filter(Boolean)) {
      current = join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) throw new SessionFilesError(403, '文件浏览不跟随符号链接。');
    }
    const actual = await realpath(absolute);
    if (!isPathWithin(canonicalRoot, actual) || isPathWithin(protectedRoot, actual)) throw new SessionFilesError(403, '文件超出可浏览范围。');
    return { root, absolute: actual, path: relative(canonicalRoot, actual).split(sep).join('/') };
  }

  async list(id: string, path = '', query = '', expectedRoot?: string): Promise<SessionFileList> {
    if (query.length > 200) throw new SessionFilesError(400, '搜索词过长。');
    const location = await this.locate(id, path, expectedRoot);
    const entries: SessionFileEntry[] = [];
    const pending = [{ absolute: location.absolute, path: location.path, depth: 0 }];
    const searching = Boolean(query.trim());
    const needle = query.trim().toLocaleLowerCase();
    let scanned = 0;
    let limited = false;
    outer: while (pending.length) {
      const directory = pending.shift()!;
      const checked = await this.locate(id, directory.path, location.root);
      const stream = await opendir(checked.absolute);
      for await (const entry of stream) {
        if (++scanned > (searching ? SESSION_FILE_LIMITS.searchEntries : SESSION_FILE_LIMITS.directoryEntries)) { limited = true; break outer; }
        if (!entry.isDirectory() && !entry.isFile()) continue;
        const entryPath = [directory.path, entry.name].filter(Boolean).join('/');
        if (searching && entry.isDirectory()) {
          if (directory.depth < SESSION_FILE_LIMITS.depth) pending.push({ absolute: join(directory.absolute, entry.name), path: entryPath, depth: directory.depth + 1 });
          else limited = true;
        }
        if (!searching || (entry.isFile() && entry.name.toLocaleLowerCase().includes(needle))) entries.push({ name: entry.name, path: entryPath, kind: entry.isDirectory() ? 'directory' : 'file' });
        if (searching && entries.length >= SESSION_FILE_LIMITS.searchResults) { limited = true; break outer; }
      }
    }
    entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) || a.path.localeCompare(b.path));
    return { root: location.root, path: location.path, entries, limited };
  }
}
