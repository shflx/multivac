import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { IMAGE_LIMITS } from '@multivac/contracts';
import { constants } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assistantQuoteWithinLimit, SESSION_FILE_LIMITS, type AssistantFileQuote, type CoordinatorFileQuote, type SessionFileContent, type SessionFileEntry, type SessionFileList, type WorkspaceSession } from '@multivac/contracts';
import { isPathWithin } from '../modules/sessions/working-directory.js';

export class SessionFilesError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** 用户主动浏览只读取会话目录，不触发模型，也不扩大会话工具的授权范围。 */
export class SessionFilesService {
  constructor(private readonly sessions: { get(id: string): Pick<WorkspaceSession, 'archivedAt' | 'workingDirectory'> & Partial<Pick<WorkspaceSession, 'title' | 'host'>> }, private readonly dataDir: string) {}

  async validateQuote(quote: AssistantFileQuote): Promise<CoordinatorFileQuote> {
    if (!quote.text.trim() || !assistantQuoteWithinLimit(quote)) throw new SessionFilesError(400, '引用内容为空或超过 4 KiB UTF-8 上限，请缩短选区。');
    const content = await this.read(quote.sourceSessionId, quote.sourceFile.path, quote.sourceFile.root);
    const { line, endLine } = quote.sourceFile;
    if ((line && line > content.text.split('\n').length) || (endLine && (!line || endLine < line || endLine > content.text.split('\n').length))) throw new SessionFilesError(400, '引用行号无效，请重新选择原文。');
    return { sourceKind: 'file', sourceFile: quote.sourceFile, text: quote.text, source: { sessionId: quote.sourceSessionId, title: this.sessions.get(quote.sourceSessionId).title ?? '来源会话' } };
  }

  async locate(id: string, path: string, expectedRoot?: string): Promise<{ root: string; absolute: string; path: string }> {
    const session = this.sessions.get(id);
    if (session.host?.kind === 'reading') throw new SessionFilesError(403, '书伴没有工作文件浏览能力。');
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

  async read(id: string, path: string, expectedRoot?: string): Promise<SessionFileContent> {
    const location = await this.locate(id, path, expectedRoot);
    const handle = await open(location.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new SessionFilesError(400, '请选择普通文件。');
      if (stat.size > SESSION_FILE_LIMITS.contentBytes) throw new SessionFilesError(413, '文件超过 512 KiB 预览上限。');
      const buffer = Buffer.alloc(SESSION_FILE_LIMITS.contentBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > SESSION_FILE_LIMITS.contentBytes) throw new SessionFilesError(413, '文件超过 512 KiB 预览上限。');
      // 读完重新核对根目录与路径；归入项目或路径被替换时不发布旧内容。
      const checked = await this.locate(id, path, location.root);
      const current = await lstat(checked.absolute);
      if (current.ino !== stat.ino || current.dev !== stat.dev) throw new SessionFilesError(409, '文件已变化，请重新读取。');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)); }
      catch { throw new SessionFilesError(415, '只支持 UTF-8 文本预览。'); }
      if (text.includes('\0')) throw new SessionFilesError(415, '二进制文件不能预览。');
      if (text.split('\n').length > SESSION_FILE_LIMITS.contentLines) throw new SessionFilesError(413, '文件超过 20000 行预览上限。');
      const extension = extname(path).toLowerCase();
      const kind = ['.md', '.markdown'].includes(extension) ? 'markdown' : ['.ts', '.tsx'].includes(extension) ? 'typescript' : ['.html', '.htm'].includes(extension) ? 'html' : 'text';
      return { root: location.root, path: location.path, text, bytes: size, kind };
    } finally { await handle.close(); }
  }

  async readImage(id: string, path: string, expectedRoot: string): Promise<Buffer> {
    const location = await this.locate(id, path, expectedRoot);
    const handle = await open(location.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > IMAGE_LIMITS.bytes) throw new SessionFilesError(413, '图片必须为不超过 10 MiB 的普通文件。');
      const buffer = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < buffer.length) { const read = await handle.read(buffer, size, buffer.length - size, size); if (!read.bytesRead) break; size += read.bytesRead; }
      if (size !== stat.size) throw new SessionFilesError(409, '图片文件已变化。');
      const checked = await this.locate(id, path, expectedRoot);
      const current = await lstat(checked.absolute);
      const after = await handle.stat();
      if (current.ino !== stat.ino || current.dev !== stat.dev || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new SessionFilesError(409, '图片文件已变化。');
      return buffer.subarray(0, size);
    } finally { await handle.close(); }
  }
}
