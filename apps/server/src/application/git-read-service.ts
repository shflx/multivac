import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isPathWithin } from '../modules/sessions/working-directory.js';
import { TaskServiceError } from './task-service.js';
import type { ControlledGit, ControlledGitChannel, GitBoundary } from './controlled-git-channel.js';

export interface GitReadInput {
  operation: 'branches' | 'log' | 'file' | 'diff';
  ref?: string;
  from?: string;
  to?: string;
  path?: string;
  paths?: string[];
  offset?: number;
  limit?: number;
  statOnly?: boolean;
}
export interface GitReadOptions {
  channel: ControlledGitChannel;
  boundary: (sessionId: string) => Promise<GitBoundary>;
  lease: (sessionId: string, phase: 'starting' | 'settled', marker: string, bytes: number) => number;
}
function fail(message: string): never { throw new TaskServiceError('INVALID_REQUEST', message); }

/** 只定位当前工作目录的仓库，不向上搜索，也不读取其他工作树中的文件。 */
export async function workingGitBoundary(directory: string, protectedPaths: readonly string[]): Promise<GitBoundary> {
  const denyProtected = async (path: string) => {
    for (const protectedPath of protectedPaths) {
      const roots = [resolve(protectedPath)];
      try { roots.push(await realpath(protectedPath)); } catch { /* 缺失目录仍按声明路径保护。 */ }
      if (roots.some(root => isPathWithin(root, path))) fail('Git 元数据位于受保护目录，未读取。');
    }
  };
  const root = await realpath(directory);
  await denyProtected(root);
  const entry = join(root, '.git');
  let stat;
  try { stat = await lstat(entry); } catch { return fail('当前工作目录不是 Git 仓库根目录或有效 worktree，不向上搜索其他目录。'); }
  if (stat.isSymbolicLink()) fail('Git 元数据不能使用符号链接。');
  if (stat.isDirectory()) return { directory: root, gitDirectory: entry, commonDirectory: entry };
  if (!stat.isFile()) fail('Git 元数据无效。');
  const metadata = async (path: string): Promise<string> => {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch(() => fail('Git 指针或关联元数据无效，不跟随符号链接。'));
    try {
      const buffer = Buffer.alloc(8193);
      if (!(await file.stat()).isFile()) fail('Git 指针或关联元数据不是常规文件。');
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 8192) fail('Git 指针或关联元数据超过读取上限。');
      return buffer.subarray(0, bytesRead).toString('utf8').trim();
    } finally { await file.close(); }
  };
  const pointer = await metadata(entry);
  if (!pointer.startsWith('gitdir: ')) fail('Git 指针无效。');
  const target = resolve(root, pointer.slice(8));
  await denyProtected(target);
  const gitDirectory = await realpath(target);
  await denyProtected(gitDirectory);
  if (gitDirectory !== target) fail('Git 元数据不能通过符号链接改指其他目录。');
  const commonTarget = resolve(gitDirectory, await metadata(join(gitDirectory, 'commondir')));
  await denyProtected(commonTarget);
  const commonDirectory = await realpath(commonTarget);
  await denyProtected(commonDirectory);
  if (dirname(gitDirectory) !== join(commonDirectory, 'worktrees') || !basename(gitDirectory)
    || resolve(await metadata(join(gitDirectory, 'gitdir'))) !== entry) fail('worktree 与所属 Git 仓库的关联无效。');
  return { directory: root, gitDirectory, commonDirectory };
}

/** 固定查询操作与参数；引用先解析为提交 SHA，后续查询只使用固定对象。 */
export class GitReadService {
  constructor(private readonly options: GitReadOptions) {}

  private path(path: string): string {
    if (!path || path.length > 1024 || isAbsolute(path) || /[\u0000-\u001f\\]/u.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')) fail('Git 文件路径必须是仓库内的安全相对路径。');
    return path;
  }
  private async commit(git: ControlledGit, ref = 'HEAD'): Promise<string> {
    if (!ref || ref.length > 256 || /[\u0000-\u0020\\]/u.test(ref)) fail('Git 引用必须是 HEAD、本地分支或提交 SHA。');
    let target: string;
    if (ref === 'HEAD' || /^[a-f0-9]{7,64}$/iu.test(ref)) target = ref;
    else {
      if (ref.startsWith('refs/') && !ref.startsWith('refs/heads/')) fail('只读取本地分支，不读取其他引用命名空间。');
      target = ref.startsWith('refs/heads/') ? ref : `refs/heads/${ref}`;
      await git(['check-ref-format', target]);
    }
    const sha = (await git(['rev-parse', '--verify', '--end-of-options', `${target}^{commit}`])).trim();
    if (!/^[a-f0-9]{40,64}$/u.test(sha)) fail('Git 提交身份无效。');
    return sha;
  }
  async read(sessionId: string, input: GitReadInput, signal: AbortSignal): Promise<string> {
    const fields: Record<GitReadInput['operation'], readonly string[]> = {
      branches: ['operation', 'offset', 'limit'], log: ['operation', 'ref', 'offset', 'limit'],
      file: ['operation', 'ref', 'path', 'offset', 'limit'], diff: ['operation', 'from', 'to', 'paths', 'statOnly'],
    };
    const allowed = fields[input.operation];
    if (!allowed || Object.keys(input).some(key => !allowed.includes(key))) fail('Git 查询操作与参数不匹配。');
    const offset = input.offset ?? 0;
    const limit = input.limit ?? (input.operation === 'file' ? 200 : 50);
    const maximum = input.operation === 'file' ? 1000 : 100;
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000 || !Number.isInteger(limit) || limit < 1 || limit > maximum) fail('Git 查询分页参数超出范围。');
    if (input.operation === 'file' && !input.path) fail('读取分支文件须指定相对文件路径。');
    if (input.operation === 'diff' && !input.from) fail('比较分支须指定 from 引用。');
    return this.options.channel.run(sessionId, signal, {
      readOnly: true,
      boundary: () => this.options.boundary(sessionId),
      lease: (phase, marker, bytes) => this.options.lease(sessionId, phase, marker, bytes),
    }, async git => {
      if (input.operation === 'branches') {
        const output = await git(['for-each-ref', '--sort=refname', `--count=${offset + limit + 1}`, '--format=%(refname)%09%(objectname)%09%(subject)', 'refs/heads/']);
        const rows = output.trimEnd().split('\n').filter(Boolean).slice(offset);
        return JSON.stringify({ operation: input.operation, offset, hasMore: rows.length > limit, branches: rows.slice(0, limit).map(line => {
          const [ref, commit, ...subject] = line.split('\t');
          return { name: ref!.slice('refs/heads/'.length), commit, subject: subject.join('\t') };
        }) });
      }
      if (input.operation === 'log') {
        const commit = await this.commit(git, input.ref);
        const output = await git(['log', '--no-ext-diff', '--no-textconv', '--no-show-signature', `--skip=${offset}`, `--max-count=${limit + 1}`, '--format=%H%x00%an%x00%ae%x00%aI%x00%B%x00', commit, '--']);
        const fields = output.split('\u0000');
        const commits = [];
        for (let i = 0; i + 4 < fields.length; i += 5) commits.push({ commit: fields[i]!.trim(), author: fields[i + 1], email: fields[i + 2], authoredAt: fields[i + 3], message: fields[i + 4]!.trimEnd() });
        return JSON.stringify({ operation: input.operation, ref: input.ref ?? 'HEAD', commit, offset, hasMore: commits.length > limit, commits: commits.slice(0, limit) });
      }
      if (input.operation === 'file') {
        const path = this.path(input.path!);
        const commit = await this.commit(git, input.ref);
        const tree = await git(['ls-tree', '--full-tree', '-z', commit, '--', path]);
        const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t([^\u0000]+)\u0000$/u.exec(tree);
        if (!match || match[3] !== path) fail('该提交中没有此常规文件；不读取目录，也不跟随符号链接。');
        const size = Number((await git(['cat-file', '-s', match[2]!])).trim());
        if (!Number.isSafeInteger(size) || size > 768 * 1024) fail('Git 文件超过 768 KiB 读取上限。');
        const text = await git(['cat-file', 'blob', match[2]!]);
        if (/[\u0000\ufffd]/u.test(text)) fail('Git 文件不是可读取的 UTF-8 文本。');
        const lines = text ? text.split('\n') : [];
        if (text.endsWith('\n')) lines.pop();
        const content = lines.slice(offset, offset + limit).join('\n');
        if (Buffer.byteLength(content, 'utf8') > 64 * 1024) fail('文件片段超过 64 KiB，请缩小 limit。');
        return JSON.stringify({ operation: input.operation, ref: input.ref ?? 'HEAD', commit, path, offset, totalLines: lines.length, hasMore: offset + limit < lines.length, content });
      }
      const paths = (input.paths ?? []).map(path => this.path(path));
      if (paths.length > 100) fail('Git 差异查询最多指定 100 个文件。');
      const from = await this.commit(git, input.from);
      const to = await this.commit(git, input.to);
      const diff = await git(['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--no-renames', ...(input.statOnly ? ['--stat'] : []), from, to, '--', ...paths]);
      return JSON.stringify({ operation: input.operation, from, to, diff: diff || '没有差异。' });
    });
  }
}
