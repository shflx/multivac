import { createPlatformCapabilities } from '../runtime/platform-capabilities.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskServiceError } from '../modules/tasks/task-error.js';

export interface GitBoundary { directory: string; gitDirectory: string; commonDirectory: string; branch?: string; identity?: string }
export type ControlledGit = (args: string[], allowMissing?: boolean) => Promise<string>;
interface GitOperationOptions {
  boundary: () => Promise<GitBoundary>;
  lease: (phase: 'starting' | 'settled', marker: string, bytes: number) => number;
  inputBytes?: number;
  readOnly?: boolean;
}
const fail = (message: string): never => { throw new TaskServiceError('INVALID_REQUEST', message); };

/** 受控 Git 共用执行通道；只读操作不授予工作树、索引、对象库或引用的写权限。 */
export class ControlledGitChannel {
  private readonly busy = new Set<string>();
  private executable: Promise<string> | undefined;
  private readonly children = new Map<ChildProcess, string>();
  private disposed = false;
  private readonly operations = new Set<Promise<void>>();
  get hasOperations(): boolean { return this.operations.size > 0; }
  constructor(private readonly protectedPaths: readonly string[] = []) {}
  processesStopped(sessionId: string): boolean { return ![...this.children.values()].includes(sessionId); }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const child of this.children.keys()) child.kill('SIGKILL');
    await Promise.all([...this.operations]);
  }

  private async gitExecutable(): Promise<string> {
    const denial = createPlatformCapabilities().denial('controlledGit');
    if (denial) fail(denial);
    // 绕过 /usr/bin/git 的 xcode-select 启动器，直接使用已选开发工具中的 Git，不启动查询子进程。
    this.executable ??= realpath('/var/select/developer_dir').then(path => realpath(join(path, 'usr/bin/git')))
      .catch(() => { this.executable = undefined; return fail('无法定位已选开发工具中的 Git，请检查本地开发工具是否可用。'); });
    return this.executable;
  }

  async run<T>(sessionId: string, signal: AbortSignal, options: GitOperationOptions,
    action: (git: ControlledGit, boundary: GitBoundary) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.disposed) fail('受控 Git 通道已停止。');
    let settled!: () => void;
    const completion = new Promise<void>(resolve => { settled = resolve; });
    this.operations.add(completion);
    const marker = randomUUID();
    let leased = false, outputBytes = 0, directory: string | undefined;
    try {
      const allowance = Math.min(1024 * 1024, options.lease('starting', marker, options.inputBytes ?? 0)); leased = true;
      const boundary = await options.boundary();
      if (!options.readOnly && !boundary.branch) fail('Git 写入必须绑定任务分支。');
      if (this.busy.has(boundary.directory)) fail('当前目录正在执行 Git 操作，请等待结束后再试。');
      directory = boundary.directory; this.busy.add(directory);
      const executable = await this.gitExecutable();
      const quote = (path: string) => JSON.stringify(path);
      const protectedRoots: string[] = [];
      for (const path of this.protectedPaths) {
        protectedRoots.push(resolve(path));
        try { protectedRoots.push(await realpath(path)); } catch { /* 缺失目录也按声明路径拒绝。 */ }
      }
      const reads = ['/usr', '/bin', '/System', '/Library/Apple/System', dirname(executable), join(dirname(dirname(executable)), 'lib'), boundary.directory, boundary.commonDirectory];
      const profile = `(version 1) (deny default) (allow process-exec) (deny process-fork)
        (allow file-read-metadata (vnode-type DIRECTORY))
        (allow file-read* (literal "/") ${reads.map(path => `(subpath ${quote(path)})`).join(' ')} (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))
        ${options.readOnly ? '(allow file-write* (literal "/dev/null"))' : `(allow file-write* (subpath ${quote(boundary.directory)}) (subpath ${quote(boundary.gitDirectory)})
          (subpath ${quote(join(boundary.commonDirectory, 'objects'))})
          (literal ${quote(join(boundary.commonDirectory, boundary.branch!))}) (literal ${quote(join(boundary.commonDirectory, `${boundary.branch}.lock`))})
          (literal ${quote(join(boundary.commonDirectory, 'logs', boundary.branch!))}) (literal ${quote(join(boundary.commonDirectory, 'logs', `${boundary.branch}.lock`))})
          (literal "/dev/null"))`}
        ${protectedRoots.map(path => `(deny file-read* file-write* (subpath ${quote(path)}))`).join(' ')}`;
      const fixed = ['--no-optional-locks', '--no-replace-objects', '--literal-pathspecs', `--git-dir=${boundary.gitDirectory}`, `--work-tree=${boundary.directory}`,
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.logAllRefUpdates=false',
        '-c', 'commit.gpgSign=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'user.name=Multivac', '-c', 'user.email=multivac@localhost'];
      const git = async (args: string[], allowMissing = false): Promise<string> => {
        signal.throwIfAborted();
        if (this.disposed) fail('受控 Git 通道已停止。');
        const checked = await options.boundary();
        if (checked.gitDirectory !== boundary.gitDirectory || checked.directory !== boundary.directory || checked.commonDirectory !== boundary.commonDirectory || checked.identity !== boundary.identity) fail('Git 读取或执行边界已失效。');
        signal.throwIfAborted();
        // 边界读取会让出执行权；关闭后不能在这段等待结束时再启动新进程。
        if (this.disposed) fail('受控 Git 通道已停止。');
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
      try { if (leased) options.lease('settled', marker, outputBytes); }
      finally { if (directory) this.busy.delete(directory); this.operations.delete(completion); settled(); }
    }
  }
}
