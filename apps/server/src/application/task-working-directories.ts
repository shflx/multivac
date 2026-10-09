import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { taskBranchName, taskDirectoryName } from './task-directory-names.js';
import { cp, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Project, Task, WorkingDirectory } from '@multivac/contracts';
import { isPathWithin } from '../modules/sessions/working-directory.js';
import { NativeTaskTools } from '../runtime/executors/native-task-tools.js';

const executeFile = promisify(execFile);
const MAX_ENTRIES = 10000;
const MAX_BYTES = 64 * 1024 * 1024;

/** 只由服务端分配目录；从不向用户工作树写回、覆盖或清理成果。 */
export class TaskWorkingDirectories {
  constructor(private readonly root: string, private readonly project: (id: string) => Project, private readonly protectedPaths: readonly string[] = []) {}

  async prepare(task: Task, runId: string, signal: AbortSignal): Promise<{ directory: WorkingDirectory; baseline: string | null }> {
    const base = join(this.root, 'tasks');
    await mkdir(base, { recursive: true, mode: 0o700 });
    if ((await lstat(base)).isSymbolicLink() || !isPathWithin(await realpath(this.root), await realpath(base))) throw new Error('任务目录根发生变化，未启动执行。');
    const name = taskDirectoryName(task, runId);
    const target = join(base, name);
    const source = task.projectId ? this.project(task.projectId).directories[0]?.path : undefined;
    let baseline: string | null = null;
    let kind: WorkingDirectory['kind'] = 'task-isolated';
    signal.throwIfAborted();
    if (source) {
      const sourceRoot = await realpath(source);
      for (const protectedPath of this.protectedPaths) {
        let protectedRoot = resolve(protectedPath);
        try { protectedRoot = await realpath(protectedPath); } catch { /* 缺失路径也不作为任务资料。 */ }
        if (isPathWithin(sourceRoot, protectedRoot) || isPathWithin(protectedRoot, sourceRoot)) throw new Error('任务来源与内部数据或凭据目录重叠，未创建执行快照。');
      }
      const git = async (args: string[]) => (await executeFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', sourceRoot, ...args], {
        maxBuffer: MAX_BYTES, timeout: 60000,
        env: { PATH: process.env.PATH, HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
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
    const tools = await NativeTaskTools.create(target);
    tools.dispose();
    return { directory: { kind, path: resolve(target) }, baseline };
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
