import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isPathWithin } from '../modules/sessions/working-directory.js';
import { TaskServiceError } from '../modules/tasks/task-error.js';
import { taskBranchName } from './task-directory-names.js';
import { ControlledGitChannel, type GitBoundary } from './controlled-git-channel.js';

export interface TaskGitSource { runId: string; directory: string; sourceDirectory: string }
export interface TaskGitOptions {
  workRoot: string;
  source: (sessionId: string) => TaskGitSource;
  lease: (sessionId: string, phase: 'starting' | 'settled', marker: string, bytes: number) => number;
  protectedPaths?: readonly string[];
}
const fail = (message: string): never => { throw new TaskServiceError('INVALID_REQUEST', message); };

/** Git 专用进程只访问固定 worktree 与所需元数据；共用 shell 也能操作 Git 元数据，本通道仍提供固定边界的可核对入口。 */
export class TaskGitService {
  readonly channel: ControlledGitChannel;
  constructor(private readonly options: TaskGitOptions) { this.channel = new ControlledGitChannel(options.protectedPaths); }
  processesStopped(sessionId: string): boolean { return this.channel.processesStopped(sessionId); }
  dispose(): Promise<void> { return this.channel.dispose(); }
  async readBoundary(sessionId: string): Promise<GitBoundary> {
    const source = this.options.source(sessionId);
    return { ...await this.boundary(source), identity: source.runId };
  }

  private async boundary(source: TaskGitSource): Promise<GitBoundary> {
    const directory = await realpath(source.directory);
    const root = await realpath(join(this.options.workRoot, 'tasks'));
    const name = relative(root, directory);
    const branchName = taskBranchName(name);
    if (root !== join(await realpath(this.options.workRoot), 'tasks') || !branchName
      || resolve(source.directory) !== join(resolve(this.options.workRoot), 'tasks', name)) fail('任务执行目录发生变化，未执行 Git 操作。');
    const sourceRoot = await realpath(source.sourceDirectory);
    let commonDirectory = join(sourceRoot, '.git');
    const sourceEntry = await lstat(commonDirectory);
    if (sourceEntry.isFile()) {
      const pointer = (await readFile(commonDirectory, 'utf8')).trim();
      if (!pointer.startsWith('gitdir: ')) fail('项目 Git 元数据无效。');
      const sourceGit = await realpath(resolve(sourceRoot, pointer.slice(8)));
      commonDirectory = resolve(sourceGit, (await readFile(join(sourceGit, 'commondir'), 'utf8')).trim());
    } else if (!sourceEntry.isDirectory() || sourceEntry.isSymbolicLink()) fail('项目 Git 元数据无效。');
    commonDirectory = await realpath(commonDirectory);
    const gitDirectory = join(commonDirectory, 'worktrees', name);
    if (await realpath(gitDirectory) !== gitDirectory) fail('任务 Git 元数据发生变化。');
    const pointer = await this.worktreePointer(directory);
    if (pointer !== `gitdir: ${gitDirectory}` || resolve((await readFile(join(gitDirectory, 'gitdir'), 'utf8')).trim()) !== join(directory, '.git')
      || await realpath(resolve(gitDirectory, (await readFile(join(gitDirectory, 'commondir'), 'utf8')).trim())) !== commonDirectory) fail('任务 worktree 与项目仓库的关联发生变化。');
    const branch = `refs/heads/${branchName}`;
    if ((await readFile(join(gitDirectory, 'HEAD'), 'utf8')).trim() !== `ref: ${branch}`) fail('任务分支发生变化，未执行 Git 操作。');
    return { directory, gitDirectory, commonDirectory, branch };
  }

  private async worktreePointer(directory: string): Promise<string> {
    // 指针由任务目录提供：禁止跟随链接，并限定实际读取量，避免检查后被替换或增长。
    const file = await open(join(directory, '.git'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch(() => fail('任务 Git 指针无效。'));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 8192) fail('任务 Git 指针无效。');
      const buffer = Buffer.alloc(8193);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 8192) fail('任务 Git 指针无效。');
      return buffer.subarray(0, bytesRead).toString('utf8').trim();
    } finally { await file.close(); }
  }

  private async paths(boundary: GitBoundary, paths: readonly string[]): Promise<string[]> {
    return Promise.all(paths.map(async path => {
      if (!path || isAbsolute(path) || /[\u0000-\u001f\\]/u.test(path) || path.split('/').some(part => !part || part === '..' || part === '.' || part === '.git')) fail('Git 文件路径必须是任务目录内的相对文件路径。');
      const target = resolve(boundary.directory, path);
      if (!isPathWithin(boundary.directory, target)) fail('Git 文件路径超出任务目录。');
      let current = boundary.directory;
      for (const part of path.split('/')) {
        current = join(current, part);
        try {
          const stat = await lstat(current);
          if (stat.isSymbolicLink()) fail('Git 提交通道不接受符号链接路径。');
          if (current === target && stat.isDirectory()) fail('请逐项列出需要提交的文件，不提交整个目录。');
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      return path;
    }));
  }

  private async operation<T>(sessionId: string, signal: AbortSignal, inputBytes: number,
    action: (git: (args: string[], allowMissing?: boolean) => Promise<string>, boundary: GitBoundary) => Promise<T>): Promise<T> {
    const source = this.options.source(sessionId);
    return this.channel.run(sessionId, signal, {
      inputBytes,
      lease: (phase, marker, bytes) => this.options.lease(sessionId, phase, marker, bytes),
      boundary: async () => {
        const current = this.options.source(sessionId);
        if (current.runId !== source.runId || current.directory !== source.directory || current.sourceDirectory !== source.sourceDirectory) fail('任务执行边界已失效，未继续 Git 操作。');
        return { ...await this.boundary(current), identity: current.runId };
      },
    }, action);
  }

  async inspect(sessionId: string, input: { staged?: boolean; paths?: string[] }, signal: AbortSignal): Promise<string> {
    return this.operation(sessionId, signal, 0, async (git, boundary) => {
      const paths = await this.paths(boundary, input.paths ?? []);
      const head = (await git(['rev-parse', '--verify', 'HEAD'])).trim();
      const status = await git(['status', '--short', '--untracked-files=normal', '--ignore-submodules=all', '--', ...paths]);
      const diff = await git(['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', ...(input.staged ? ['--cached'] : []), '--', ...paths]);
      return `HEAD：${head}\n状态：\n${status || '工作区干净。\n'}${input.staged ? '已暂存' : '未暂存'}差异：\n${diff || '没有差异。'}`;
    });
  }

  async commit(sessionId: string, input: { paths: string[]; message: string }, signal: AbortSignal): Promise<string> {
    if (!input.paths.length || input.paths.length > 100 || !input.message.trim() || input.message.length > 16000) fail('提交须指定 1–100 个文件和非空提交信息。');
    return this.operation(sessionId, signal, Buffer.byteLength(input.message, 'utf8'), async (git, boundary) => {
      const paths = await this.paths(boundary, input.paths);
      await git(['add', '--', ...paths]);
      await git(['commit', '--only', '--no-gpg-sign', '--no-verify', '-m', input.message, '--', ...paths]);
      const head = (await git(['rev-parse', '--verify', 'HEAD'])).trim();
      const summary = await git(['show', '--no-ext-diff', '--no-textconv', '--format=short', '--stat', '--no-renames', head]);
      return `本地提交已创建：${head}\n${summary}\n尚未发布远端。`;
    });
  }
}
