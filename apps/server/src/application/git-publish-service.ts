import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { Check } from 'typebox/value';
import { ProposeGitPublishSchema, UNKNOWN_CHANGE_ORIGIN, type ExternalOperation, type ProposeGitPublish, type DecideHumanRequest } from '@multivac/contracts';
import type { SqliteInboxRepository } from '../storage/sqlite-inbox-repository.js';
import type { WorkbenchEvents } from './workbench-events.js';
import { TaskServiceError } from './task-service.js';

const exec = promisify(execFile);
export interface GitPublishSource { directory: string; taskId: string | null; canPublish: boolean }
/** 只发布固定提交到不存在的新分支，不运行 shell，不使用仓库 hooks。 */
export class GitPublishService {
  constructor(private readonly repository: SqliteInboxRepository, private readonly events: WorkbenchEvents,
    private readonly source: (sessionId: string) => GitPublishSource, private readonly allowLocalForTest = false) {
    for (const operation of repository.operations()) if (operation.status === 'executing') this.save({ ...operation, status: 'unknown', result: '进程中断，发布结果未知；只能只读核对远端。' });
  }
  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', '-c', `protocol.file.allow=${this.allowLocalForTest ? 'always' : 'never'}`, ...args], {
      cwd, timeout: 30000, maxBuffer: 128 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
    });
    return stdout.trim();
  }
  private save(operation: ExternalOperation): ExternalOperation {
    const next = { ...operation, revision: operation.revision + 1, updatedAt: new Date().toISOString() };
    this.repository.saveOperation(next);
    this.events.publish({ type: 'inbox.changed', id: next.id, origin: UNKNOWN_CHANGE_ORIGIN });
    return next;
  }
  invalidateTask(taskId: string): void {
    for (const operation of this.list()) if (operation.taskId === taskId && operation.status === 'pending') this.save({ ...operation, status: 'invalidated', result: '来源任务已取消，未执行发布。' });
  }
  pending(taskId: string): boolean { return this.list().some((operation) => operation.taskId === taskId && ['pending', 'executing', 'unknown'].includes(operation.status)); }
  list(): ExternalOperation[] { return this.repository.operations(); }
  get(id: string): ExternalOperation {
    const operation = this.repository.operation(id);
    if (!operation) throw new TaskServiceError('NOT_FOUND', '外发请求不存在。');
    return operation;
  }
  async propose(sessionId: string, commandId: string, input: ProposeGitPublish): Promise<ExternalOperation> {
    if (!Check(ProposeGitPublishSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '发布参数无效。');
    const id = `external:${createHash('sha256').update(`${sessionId}:${commandId}`).digest('hex')}`;
    const previous = this.repository.operation(id);
    if (previous) {
      if (previous.remote !== input.remote || previous.ref !== `refs/heads/${input.branch}`) throw new TaskServiceError('COMMAND_ID_CONFLICT', '同一命令不能改变发布目标。');
      return previous;
    }
    const source = this.source(sessionId);
    const cwd = await realpath(source.directory);
    const target = await this.git(cwd, ['remote', 'get-url', '--push', input.remote]);
    // 不接收内嵌凭据、shell transport 或任意协议；本地裸仓库仅供受控集成测试。
    const url = target.startsWith('https://') ? new URL(target) : null;
    if ((!url || url.username || url.password || url.search || url.hash) && !(this.allowLocalForTest && target.startsWith('/'))) throw new TaskServiceError('INVALID_REQUEST', '仅支持无内嵌凭据的 HTTPS Git 远端。');
    const ref = `refs/heads/${input.branch}`;
    await this.git(cwd, ['check-ref-format', ref]);
    const commit = await this.git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const summary = (await this.git(cwd, ['show', '--format=short', '--stat', '--no-renames', commit])).slice(0, 8000);
    const at = new Date().toISOString();
    const operation: ExternalOperation = { id, sessionId, taskId: source.taskId, revision: 1, status: 'pending', repository: cwd, remote: input.remote, target, ref, commit, summary,
      account: '使用本机 Git HTTPS 凭据；具体账号由远端认证，应用不读取凭据。', createdAt: at, updatedAt: at, result: '等待用户批准；尚未发布。' };
    this.repository.saveOperation(operation); this.events.publish({ type: 'inbox.changed', id, origin: UNKNOWN_CHANGE_ORIGIN });
    return operation;
  }
  private remoteCommit(operation: ExternalOperation): Promise<string> {
    return this.git(operation.repository, ['ls-remote', '--refs', operation.target, operation.ref]).then((text) => text.split(/\s/)[0] ?? '');
  }
  async reconcile(id: string): Promise<ExternalOperation> {
    const operation = this.get(id);
    if (operation.status !== 'unknown') return operation;
    try {
      const commit = await this.remoteCommit(operation);
      if (commit === operation.commit) return this.save({ ...operation, status: 'succeeded', result: '已只读核对远端分支指向固定提交。' });
      return this.save({ ...operation, result: commit ? '远端分支指向其他提交，保留未知状态；不会覆盖或重推。' : '远端目前没有该分支，仍不能证明原请求从未生效；不会自动重推。' });
    } catch { return this.save({ ...operation, result: '远端核对失败，结果仍未知；未重新执行发布。' }); }
  }
  async decide(id: string, input: DecideHumanRequest): Promise<ExternalOperation> {
    const operation = this.get(id);
    if (!['once', 'deny'].includes(input.decision)) throw new TaskServiceError('INVALID_REQUEST', '外发只允许单次批准或拒绝。');
    if (operation.status !== 'pending') {
      if (input.decision === 'deny' && operation.status === 'denied') return operation;
      if (input.decision === 'once' && ['executing', 'unknown', 'succeeded'].includes(operation.status)) return operation;
      throw new TaskServiceError('TASK_CONFLICT', '外发请求已终结。');
    }
    if (input.revision !== operation.revision) throw new TaskServiceError('TASK_CONFLICT', '发布请求版本已变化。');
    if (input.decision === 'deny') return this.save({ ...operation, status: 'denied', result: '用户拒绝，未执行发布；本地成果保留。' });
    // 先持久化唯一执行权；后续任何失败均不重放 push。
    let current = this.save({ ...operation, status: 'executing', result: '已获单次批准，正在复核目标。' });
    try {
      const source = this.source(operation.sessionId);
      if (!source.canPublish || await realpath(source.directory) !== operation.repository
        || await this.git(operation.repository, ['remote', 'get-url', '--push', operation.remote]) !== operation.target
        || await this.git(operation.repository, ['rev-parse', '--verify', 'HEAD^{commit}']) !== operation.commit) {
        return this.save({ ...current, status: 'invalidated', result: '来源、停止状态、目标或提交已变化；未发布，请重新申请。' });
      }
      if (await this.remoteCommit(operation)) return this.save({ ...current, status: 'invalidated', result: '远端分支已经存在，未覆盖；请重新选择新分支。' });
      if (!this.source(operation.sessionId).canPublish) return this.save({ ...current, status: 'invalidated', result: '来源执行条件已变化，未发布。' });
      current = this.save({ ...current, result: '发布意图已保存，正在发送固定提交。' });
      await this.git(operation.repository, ['push', '--porcelain', `--force-with-lease=${operation.ref}:`, operation.target, `${operation.commit}:${operation.ref}`]);
      // 即使命令返回成功，也核对最终远端引用，不用输出文案猜测成功。
      current = this.save({ ...current, status: 'unknown', result: '已发送，正在核对远端。' });
    } catch { current = this.save({ ...current, status: 'unknown', result: '外部结果未知；不会重发，只读核对远端。' }); }
    return this.reconcile(current.id);
  }
}
