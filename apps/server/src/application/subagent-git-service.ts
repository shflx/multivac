import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SubagentRepository } from '../modules/agents/subagent-run.js';
import type { CoordinatorToolGuard } from '../modules/sessions/coordinator-adapter.js';
import type { ControlledGit, ControlledGitChannel, GitBoundary } from './controlled-git-channel.js';
import { workingGitBoundary } from './git-read-service.js';
import { validateGitPaths } from './task-git-service.js';
import type { ExecutionLeasePhase } from './execution-budget-lease.js';
import { InternalToolOutcomeUnknownError } from '../modules/internal-tools/internal-tool.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** 执行方式在现有受控通道提交本地改动，持有委派独占直至 Git 真实退出。 */
export class SubagentGitService {
  private readonly inspected = new Map<string, { paths: string; digest: string }>();
  constructor(private readonly repository: SubagentRepository, private readonly channel: ControlledGitChannel,
    private readonly guard: CoordinatorToolGuard, private readonly protectedPaths: readonly string[],
    private readonly lease: (id: string, phase: ExecutionLeasePhase, marker: string, bytes: number) => number,
    private readonly verified: (id: string) => boolean) {}
  private source(id: string) {
    const record = this.repository.bySession(id);
    if (!record || record.run.mode !== 'execute' || record.run.status !== 'running' || record.run.stopConfirmed) throw new Error('只有运行中的执行方式可核对或提交本地改动。');
    return record;
  }
  private async boundary(id: string): Promise<GitBoundary> {
    const record = this.source(id);
    const boundary = await workingGitBoundary(record.workingDirectory.path, this.protectedPaths);
    const head = (await readFile(join(boundary.gitDirectory, 'HEAD'), 'utf8')).trim();
    if (!/^ref: refs\/heads\/[A-Za-z0-9][A-Za-z0-9/_-]*$/u.test(head)) throw new Error('本地提交必须绑定明确的当前分支。');
    return { ...boundary, branch: head.slice(5), identity: record.run.id };
  }
  private async paths(id: string, boundary: GitBoundary, input: string[]): Promise<string[]> {
    const paths = await validateGitPaths(boundary, input);
    for (const path of paths) { const release = this.guard.acquire(id, 'commit_subagent_code', resolve(boundary.directory, path)); release(); }
    return paths;
  }
  private async snapshot(git: ControlledGit, paths: string[]) {
    const head = await git(['rev-parse', '--verify', 'HEAD']);
    const status = await git(['status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=all', '--', ...paths]);
    const diff = await git(['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--', ...paths]);
    // 新文件未进入 diff，另外读取其对象摘要，防止核对后内容悄然变化。
    const files = await git(['ls-files', '--others', '--exclude-standard', '--', ...paths]);
    const untracked = files.trim() ? await git(['hash-object', '--no-filters', '--', ...files.trim().split('\n')]) : '';
    return { status, text: `${head}\n${status}\n${diff}\n${untracked}` };
  }
  async inspect(id: string, input: { paths: string[] }, signal: AbortSignal): Promise<string> {
    if (!input.paths.length) throw new Error('请逐项列出本次委派相关文件。');
    return this.channel.run(id, signal, { readOnly: true, boundary: () => this.boundary(id), lease: (phase, marker, bytes) => this.lease(id, phase, marker, bytes) }, async (git, boundary) => {
      const paths = await this.paths(id, boundary, input.paths);
      const snapshot = await this.snapshot(git, paths);
      this.inspected.set(id, { paths: JSON.stringify(paths), digest: digest(snapshot.text) });
      return snapshot.text;
    });
  }
  async commit(id: string, input: { paths: string[]; message: string }, signal: AbortSignal): Promise<string> {
    if (!input.paths.length || input.paths.length > 100 || !input.message.trim()) throw new Error('提交须明确列出文件和提交信息。');
    const release = this.guard.acquire(id, 'commit_subagent_code');
    let commitAttempted = false;
    try {
      return await this.channel.run(id, signal, { boundary: () => this.boundary(id), lease: (phase, marker, bytes) => this.lease(id, phase, marker, bytes) }, async (git, boundary) => {
        const paths = await this.paths(id, boundary, input.paths);
        const snapshot = await this.snapshot(git, paths), inspected = this.inspected.get(id);
        if (!snapshot.status.trim()) return '没有相关改动，未创建空提交。';
        if (!inspected || inspected.paths !== JSON.stringify(paths) || inspected.digest !== digest(snapshot.text)) throw new Error('先核对当前差异；核对后的文件或 HEAD 已变化时须重新核对。');
        if (!this.verified(id)) throw new Error('尚无本次执行成功的运行检查，请先完成验证。');
        await git(['add', '--', ...paths]);
        commitAttempted = true;
        await git(['commit', '--only', '--no-gpg-sign', '--no-verify', '-m', input.message, '--', ...paths]);
        const hash = (await git(['rev-parse', '--verify', 'HEAD'])).trim();
        this.repository.transaction(() => {
          const record = this.source(id);
          record.run.commitHashes = [...record.run.commitHashes, hash];
          record.run.changedFiles = [...new Set([...record.run.changedFiles, ...paths.map(path => resolve(boundary.directory, path))])];
          this.repository.save(record);
        });
        this.inspected.delete(id);
        return `本地提交已创建：${hash}；未推送。`;
      });
    } catch (error) {
      if (commitAttempted) throw new InternalToolOutcomeUnknownError(
        '本地提交已进入执行阶段，结果未知；提交可能已发生，但未能完整记录。请先只读核对当前 HEAD 与提交历史，不要更换调用身份重复提交。');
      throw error;
    } finally { release(); }
  }
}
