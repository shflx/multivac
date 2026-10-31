import { gitEnvironment, gitNullDevice } from './git-platform.js';
import { createPlatformCapabilities, type PlatformCapabilities } from '../runtime/platform-capabilities.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { taskBranchName, taskDirectoryName } from './task-directory-names.js';
import { cp, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Project, Task, WorkingDirectory } from '@multivac/contracts';
import { isPathWithin } from '../modules/sessions/working-directory.js';
import { prepareNodeDependencies } from './task-node-dependencies.js';

const executeFile = promisify(execFile);
const MAX_ENTRIES = 10000;
const MAX_BYTES = 64 * 1024 * 1024;

/** 只由服务端分配目录；从不向用户工作树写回、覆盖或清理成果。 */
export class TaskWorkingDirectories {
  constructor(private readonly root: string, private readonly project: (id: string) => Project, private readonly protectedPaths: readonly string[] = [], private readonly capabilities: PlatformCapabilities = createPlatformCapabilities()) {}

  async prepare(task: Task, runId: string, signal: AbortSignal): Promise<{ directory: WorkingDirectory; baseline: string | null }> {
    const denial = this.capabilities.denial('taskExecution') ?? this.capabilities.denial('command');
    if (denial) throw new Error(denial);
    signal.throwIfAborted();
    const base = join(this.root, 'tasks');
    await mkdir(base, { recursive: true, mode: 0o700 });
    if ((await lstat(base)).isSymbolicLink() || !isPathWithin(await realpath(this.root), await realpath(base))) throw new Error('任务目录根发生变化，未启动执行。');
    let hooksPath = gitNullDevice(this.capabilities.platform);
    if (this.capabilities.platform === 'win32') {
      hooksPath = join(base, '.disabled-git-hooks');
      await mkdir(hooksPath, { recursive: true });
      if ((await lstat(hooksPath)).isSymbolicLink() || !isPathWithin(await realpath(base), await realpath(hooksPath)) || (await readdir(hooksPath)).length)
        throw new Error('Git 禁用 hooks 目录不可用。');
    }
    const name = taskDirectoryName(task, runId);
    const target = join(base, name);
    const sourceRoot = await this.sourceRoot(task);
    let baseline: string | null = null;
    let kind: WorkingDirectory['kind'] = 'task-isolated';
    signal.throwIfAborted();
    if (sourceRoot) {
      const git = async (args: string[]) => (await executeFile(this.capabilities.platform === 'win32' ? 'git.exe' : 'git', ['-c', `core.hooksPath=${hooksPath}`, '-c', 'core.fsmonitor=false', '-C', sourceRoot, ...args], {
        maxBuffer: MAX_BYTES, timeout: 60000,
        env: gitEnvironment(this.capabilities.platform, process.env, 'worktree', base), signal,
      })).stdout.trim();
      let repositoryRoot: string | null = null;
      try { repositoryRoot = await git(['rev-parse', '--show-toplevel']); }
      catch { /* 非 Git 项目使用独立快照，不回退到用户原目录执行。 */ }
      if (repositoryRoot) {
        if (await realpath(repositoryRoot) !== sourceRoot) throw new Error('Git 项目的主目录须为仓库根目录，不能隐式扩大到上级目录。');
        baseline = await git(['rev-parse', 'HEAD']);
        // 禁用项目声明的 checkout filter 与 hooks，避免准备 worktree 时执行项目提供的命令。
        let filters = '';
        try { filters = await git(['config', '--name-only', '--get-regexp', '^filter\\..*\\.(smudge|process|required)$']); }
        catch { /* 没有过滤器配置。 */ }
        const disabled = filters.split('\n').filter(Boolean).flatMap((key) => ['-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`]);
        signal.throwIfAborted();
        await git([...disabled, 'worktree', 'add', '-b', taskBranchName(name)!, target, baseline]);
        kind = 'worktree';
      } else {
        await this.checkSnapshot(sourceRoot, signal);
        await cp(sourceRoot, target, { recursive: true, force: false, errorOnExist: true, dereference: false });
      }
    } else await mkdir(target, { mode: 0o700 });
    signal.throwIfAborted();
    // worktree 组织修改位置；执行能力由与工作会话共用的后端核对，不把 cwd 当沙箱。
    return { directory: { kind, path: resolve(target) }, baseline };
  }

  /**
   * 每次执行前为 worktree 补齐 Node 依赖（新建或沿用的目录均适用，已准备过的跳过）。
   * 失败不阻止任务：提示词会说明依赖不可用，由模型据实处理。
   */
  async prepareDependencies(task: Task, directory: WorkingDirectory, signal: AbortSignal): Promise<void> {
    if (directory.kind !== 'worktree') return;
    try {
      const sourceRoot = await this.sourceRoot(task);
      if (sourceRoot) await prepareNodeDependencies(sourceRoot, directory.path, signal);
    } catch (error) {
      signal.throwIfAborted();
      console.warn('任务目录依赖准备失败，按未准备继续。', { task: task.taskId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** 项目主目录的真实路径；与内部数据或凭据目录重叠时拒绝作为任务来源。 */
  private async sourceRoot(task: Task): Promise<string | null> {
    const source = task.projectId ? this.project(task.projectId).directories[0]?.path : undefined;
    if (!source) return null;
    const sourceRoot = await realpath(source);
    for (const protectedPath of this.protectedPaths) {
      let protectedRoot = resolve(protectedPath);
      try { protectedRoot = await realpath(protectedPath); } catch { /* 缺失路径也不作为任务资料。 */ }
      if (isPathWithin(sourceRoot, protectedRoot) || isPathWithin(protectedRoot, sourceRoot)) throw new Error('任务来源与内部数据或凭据目录重叠，未创建执行快照。');
    }
    return sourceRoot;
  }

  private async checkSnapshot(root: string, signal: AbortSignal): Promise<void> {
    const queue = [root];
    let entries = 0;
    let bytes = 0;
    while (queue.length) {
      signal.throwIfAborted();
      for (const item of await readdir(queue.pop()!, { withFileTypes: true })) {
        if (++entries > MAX_ENTRIES) throw new Error('非 Git 项目快照超过目录条目预算。');
        const path = join(item.parentPath, item.name);
        if (item.isSymbolicLink()) throw new Error('非 Git 任务快照包含符号链接，请先明确资料范围。');
        if (item.isDirectory()) queue.push(path);
        else if (item.isFile()) {
          bytes += (await lstat(path)).size;
          if (bytes > MAX_BYTES) throw new Error('非 Git 项目快照超过文件预算。');
        } else throw new Error('非 Git 项目快照包含非普通文件。');
      }
    }
  }
}
