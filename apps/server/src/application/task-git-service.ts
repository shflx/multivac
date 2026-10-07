import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isPathWithin } from '../modules/sessions/working-directory.js';
import { TaskServiceError } from './task-service.js';

export interface TaskGitSource { runId: string; directory: string; sourceDirectory: string }
export interface TaskGitOptions {
  workRoot: string;
  source: (sessionId: string) => TaskGitSource;
  lease: (sessionId: string, phase: 'starting' | 'settled', marker: string, bytes: number) => number;
  protectedPaths?: readonly string[];
}
interface GitBoundary { directory: string; gitDirectory: string; commonDirectory: string; branch: string }
const fail = (message: string): never => { throw new TaskServiceError('INVALID_REQUEST', message); };

/** Git 专用进程只访问固定 worktree 与所需元数据；通用任务 bash 的隔离规则保持不变。 */
export class TaskGitService {
  private readonly busy = new Set<string>();
  private executable: Promise<string> | undefined;
  private readonly children = new Map<ChildProcess, string>();
  private disposed = false;
  constructor(private readonly options: TaskGitOptions) {}

  processesStopped(sessionId: string): boolean { return ![...this.children.values()].includes(sessionId); }
  dispose(): void { this.disposed = true; for (const child of this.children.keys()) child.kill('SIGKILL'); }

  private async boundary(source: TaskGitSource): Promise<GitBoundary> {
    const directory = await realpath(source.directory);
    const root = await realpath(join(this.options.workRoot, 'tasks'));
    const name = relative(root, directory);
    if (root !== join(await realpath(this.options.workRoot), 'tasks') || !/^[a-f0-9]{64}$/u.test(name)
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
    const branch = `refs/heads/multivac-task-${name.slice(0, 20)}`;
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

  private async gitExecutable(): Promise<string> {
    if (process.platform !== 'darwin') fail('当前平台尚未验证任务 Git 隔离，未执行。');
    // 绕过 /usr/bin/git 的 xcode-select 启动器，直接使用已选开发工具中的 Git，不启动查询子进程。
    this.executable ??= realpath('/var/select/developer_dir').then(path => realpath(join(path, 'usr/bin/git')))
      .catch(() => { this.executable = undefined; return fail('无法定位已选开发工具中的 Git，请检查本地开发工具是否可用。'); });
    return this.executable;
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
    signal.throwIfAborted();
    if (this.disposed) fail('任务 Git 通道已停止。');
    const source = this.options.source(sessionId);
    if (this.busy.has(source.directory)) fail('当前任务正在执行 Git 操作，请等待结束后再试。');
    this.busy.add(source.directory);
    const marker = randomUUID();
    let leased = false, outputBytes = 0;
    try {
      const allowance = Math.min(1024 * 1024, this.options.lease(sessionId, 'starting', marker, inputBytes)); leased = true;
      const boundary = await this.boundary(source);
      const executable = await this.gitExecutable();
      const quote = (path: string) => JSON.stringify(path);
      const protectedRoots: string[] = [];
      for (const path of this.options.protectedPaths ?? []) {
        protectedRoots.push(resolve(path));
        try { protectedRoots.push(await realpath(path)); } catch { /* 缺失目录也按声明路径拒绝。 */ }
      }
      const reads = ['/usr', '/bin', '/System', '/Library/Apple/System', dirname(executable), join(dirname(dirname(executable)), 'lib'), boundary.directory, boundary.commonDirectory];
      const profile = `(version 1) (deny default) (allow process-exec) (deny process-fork)
        (allow file-read-metadata (vnode-type DIRECTORY))
        (allow file-read* (literal "/") ${reads.map(path => `(subpath ${quote(path)})`).join(' ')} (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))
        (allow file-write* (subpath ${quote(boundary.directory)}) (subpath ${quote(boundary.gitDirectory)})
          (subpath ${quote(join(boundary.commonDirectory, 'objects'))})
          (literal ${quote(join(boundary.commonDirectory, boundary.branch))}) (literal ${quote(join(boundary.commonDirectory, `${boundary.branch}.lock`))})
          (literal ${quote(join(boundary.commonDirectory, 'logs', boundary.branch))}) (literal ${quote(join(boundary.commonDirectory, 'logs', `${boundary.branch}.lock`))})
          (literal "/dev/null"))
        ${protectedRoots.map(path => `(deny file-read* file-write* (subpath ${quote(path)}))`).join(' ')}`;
      const fixed = ['--no-optional-locks', '--literal-pathspecs', `--git-dir=${boundary.gitDirectory}`, `--work-tree=${boundary.directory}`,
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.logAllRefUpdates=false',
        '-c', 'commit.gpgSign=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'user.name=Multivac', '-c', 'user.email=multivac@localhost'];
      const git = async (args: string[], allowMissing = false): Promise<string> => {
        signal.throwIfAborted();
        if (this.disposed) fail('任务 Git 通道已停止。');
        const current = this.options.source(sessionId);
        if (current.runId !== source.runId || current.directory !== source.directory || current.sourceDirectory !== source.sourceDirectory) fail('任务执行边界已失效，未继续 Git 操作。');
        const checked = await this.boundary(current);
        if (checked.gitDirectory !== boundary.gitDirectory || checked.directory !== boundary.directory) fail('任务 Git 关联已失效。');
        signal.throwIfAborted();
        const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
          const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, executable, ...fixed, ...args], {
            cwd: boundary.directory, env: { PATH: '/usr/bin:/bin', HOME: boundary.directory, TMPDIR: boundary.directory,
              LANG: 'en_US.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          this.children.set(child, sessionId);
          const stdout: Buffer[] = [], stderr: Buffer[] = [];
          let executionError: Error | undefined;
          const stop = () => { child.kill('SIGKILL'); };
          const timer = setTimeout(stop, 30000);
          signal.addEventListener('abort', stop, { once: true });
          if (signal.aborted) stop();
          const receive = (chunks: Buffer[]) => (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > allowance) stop(); else chunks.push(chunk); };
          child.stdout.on('data', receive(stdout)); child.stderr.on('data', receive(stderr));
          child.once('error', error => { executionError = error; });
          child.once('close', code => {
            clearTimeout(timer); signal.removeEventListener('abort', stop); this.children.delete(child);
            if (executionError) reject(executionError);
            else resolveResult({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
          });
        });
        signal.throwIfAborted();
        if (outputBytes > allowance) fail('Git 操作输出超过当前额度，已停止。请缩小查看范围后重试。');
        if (result.code !== 0 && !(allowMissing && result.code === 1)) fail(`Git 操作未成功：${(result.stderr || result.stdout).trim().slice(0, 2000) || '执行已停止，请先检查当前状态。'}`);
        return result.stdout;
      };
      // 禁用仓库声明的 clean/process 过滤器，避免暂存时启动任意外部程序。
      const filters = await git(['config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|required)$'], true);
      for (const key of filters.trim().split('\n').filter(Boolean)) {
        if (!/^filter\.[^=\r\n]+\.(clean|process|required)$/u.test(key)) fail('仓库过滤器配置无效。');
        fixed.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
      }
      return await action(git, boundary);
    } finally {
      try { if (leased) this.options.lease(sessionId, 'settled', marker, outputBytes); }
      finally { this.busy.delete(source.directory); }
    }
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
