import { satisfiesTaskDependency } from '@multivac/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { Check } from 'typebox/value';
import { SubmitArtifactSchema, type SubmitArtifact, type ArtifactVersion, type HumanRequest, type DecideHumanRequest, type Task, type TaskRun } from '@multivac/contracts';
import type { ArtifactRepository } from '../modules/tasks/artifact.js';
import type { TaskRunRepository } from '../modules/tasks/task.js';
import { TaskService, TaskServiceError, fingerprint } from './task-service.js';
import { HumanRequestService } from './human-request-service.js';
import type { WorkbenchEvents } from './workbench-events.js';

const MAX_BYTES = 512 * 1024;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** 成果正文存为受控文件，版本、来源运行与服务端证据存 SQLite；验收不授予发布权限。 */
export class ArtifactService {
  private disposed = false;
  private readonly processing = new Set<string>();
  private readonly unsubscribe: () => void;
  constructor(private readonly tasks: TaskService, private readonly runs: TaskRunRepository, private readonly versions: ArtifactRepository, private readonly requests: HumanRequestService, private readonly root: string, events: WorkbenchEvents) {
    requests.setReview((request, input) => this.prepareReview(request, input));
    this.unsubscribe = events.subscribe((event) => {
      if (event.type !== 'task.changed') return;
      if (event.task.status === 'paused' && event.task.executionTaskId) {
        const parent = this.tasks.get(event.task.executionTaskId);
        if (parent.status === 'review') {
          this.tasks.transition(parent.taskId, { commandId: `child-returned:${event.task.taskId}:${event.task.revision}`, key: String(event.task.revision), kind: 'child-returned', summary: `子任务「${event.task.title}」需要修改，整体交付等待重新核对。` }, current => ({ ...current, status: 'paused', pauseSource: 'user', reason: '子任务被退回，整体成果需重新核对。', nextStep: '继续父任务，处理子任务反馈并重新提交整体成果。' }));
          this.requests.invalidate(parent.taskId, '子任务被退回，整体成果需要重新核对。');
        }
      }
      if (!['waiting', 'review'].includes(event.task.status)) return;
      const run = event.task.currentRunId ? this.runs.get(event.task.currentRunId) : null;
      if (run?.taskId === event.task.taskId && run.stopConfirmed && run.status === 'settled' && (run.artifactCandidate || run.childResults?.length)) {
        void this.settleTree(run).catch((error: unknown) => this.processingFailed(this.tasks.get(event.task.taskId), error));
      } else if (event.task.artifactVersionId) void this.finalize(event.task.taskId, event.task.artifactVersionId).catch((error: unknown) => this.processingFailed(event.task, error));
    });
    // 崩溃发生在停止确认与固定成果之间时，仅恢复成果核对，不重发模型执行。
    queueMicrotask(() => {
      if (this.disposed) return;
      let offset = 0;
      do {
        const page = this.tasks.list({ statuses: ['waiting', 'review'], offset, limit: 100 });
        for (const task of page.tasks) {
          const run = task.currentRunId ? this.runs.get(task.currentRunId) : null;
          if (run?.taskId === task.taskId && run.treeTasks?.length && run.stopConfirmed && run.status === 'settled') void this.settleTree(run).catch(error => this.processingFailed(this.tasks.get(task.taskId), error));
        }
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      } while (true);
    });
  }
  /** 子项候选只在父运行停止后固定，依赖顺序发布；事件重入不能重复结算。 */
  private async settleTree(run: TaskRun): Promise<void> {
    if (this.processing.has(run.runId)) return;
    this.processing.add(run.runId);
    try {
      const remaining = [...(run.childResults ?? [])];
      while (remaining.length) {
        const index = remaining.findIndex(result => this.readyForDelivery(this.tasks.get(result.taskId), run));
        if (index < 0) throw new TaskServiceError('INVALID_REQUEST', '子任务依赖或人工任务尚未满足，不能交付整体成果。');
        const result = remaining.splice(index, 1)[0]!;
        const task = this.tasks.get(result.taskId);
        if (!satisfiesTaskDependency(task.status)) {
          const existing = this.versions.get(digest(Buffer.from(`${task.taskId}:${result.commandId}`)));
          if (existing) await this.finalize(task.taskId, existing.versionId);
          else await this.submit(task.taskId, { commandId: result.commandId, title: result.title, path: result.path, runId: run.runId, revision: task.revision });
        }
      }
      if (run.artifactCandidate) {
        const task = this.tasks.get(run.taskId);
        if (!satisfiesTaskDependency(task.status)) {
          const existing = this.versions.get(digest(Buffer.from(`${task.taskId}:${run.artifactCandidate.commandId}`)));
          if (existing) await this.finalize(task.taskId, existing.versionId);
          else await this.submit(task.taskId, { ...run.artifactCandidate, runId: run.runId, revision: task.revision });
        }
      }
    } finally { this.processing.delete(run.runId); }
  }

  private readyForDelivery(task: Task, run: TaskRun): boolean {
    let current: Task | undefined = task;
    while (current) {
      if (!current.dependencyIds.every(id => satisfiesTaskDependency(this.tasks.get(id).status))) return false;
      current = current.taskId === run.taskId || !run.treeTasks?.some(child => child.taskId === current!.taskId) ? undefined : this.tasks.get(current.parentTaskId!);
    }
    return (run.treeTasks ?? []).filter(child => task.taskId === run.taskId || child.parentTaskId === task.taskId).every(child => satisfiesTaskDependency(this.tasks.get(child.taskId).status));
  }

  async executionTree(sessionId: string, offset = 0, limit = 20) {
    const run = this.runs.bySession(sessionId);
    if (!run) throw new TaskServiceError('INVALID_REQUEST', '当前没有任务执行。');
    const snapshots = run.treeTasks ?? [];
    const items = await Promise.all(snapshots.slice(offset, offset + limit).map(async snapshot => {
      const task = this.tasks.get(snapshot.taskId);
      const version = task.artifactVersionId ? this.versions.get(task.artifactVersionId) : null;
      const content = version ? (await this.read(version.versionId)).content : null;
      return { task, candidate: run.childResults?.find(item => item.taskId === snapshot.taskId) ?? null,
        artifact: version ? { versionId: version.versionId, title: version.title, runId: version.runId, content: content!.slice(0, 4000), truncated: content!.length > 4000, inCurrentDirectory: this.runs.get(version.runId)?.directory?.path === run.directory?.path } : null };
    }));
    return { taskId: run.taskId, runId: run.runId, directoryKind: run.directory?.kind ?? null, total: snapshots.length, nextOffset: offset + items.length < snapshots.length ? offset + items.length : null, items };
  }

  reportChild(sessionId: string, commandId: string, taskId: string, summary: string, title?: string, path?: string): void {
    const run = this.runs.bySession(sessionId);
    if (!run || run.stopIntent || run.stopConfirmed || this.tasks.get(run.taskId).status !== 'running' || !run.treeTasks?.some(child => child.taskId === taskId)) throw new TaskServiceError('INVALID_REQUEST', '子任务不属于当前活动父任务运行。');
    const task = this.tasks.get(taskId);
    if (task.humanOnly || ['done', 'review', 'cancelled'].includes(task.status) || task.currentRunId !== run.runId || this.requests.pending(taskId)) throw new TaskServiceError('INVALID_REQUEST', '子任务当前不能由本次运行推进。');
    const completed = (id: string) => satisfiesTaskDependency(this.tasks.get(id).status) || this.tasks.get(id).status === 'waiting' && this.tasks.get(id).currentRunId === run.runId && !!run.childResults?.some(item => item.taskId === id);
    let current: Task | undefined = task;
    while (current) {
      if (!current.dependencyIds.every(completed)) throw new TaskServiceError('INVALID_REQUEST', '前置任务尚未交付或登记本轮候选。');
      current = current.taskId === run.taskId ? undefined : this.tasks.get(current.parentTaskId!);
    }
    if ((title === undefined) !== (path === undefined) || path !== undefined && (!title?.trim() || !path.trim() || isAbsolute(path) || path.includes('\0') || path.split(/[\\/]/).includes('..'))) throw new TaskServiceError('INVALID_REQUEST', '子任务成果必须提供标题与任务目录内相对路径。');
    if (path && !run.treeTasks.filter(child => child.parentTaskId === taskId).every(child => completed(child.taskId))) throw new TaskServiceError('INVALID_REQUEST', '先登记下级任务成果，再提交整合成果。');
    this.tasks.transition(taskId, { commandId, key: fingerprint({ taskId, summary, title, path }), kind: 'tree-progress', summary }, value => {
      if (path && title) this.runs.save({ ...this.runs.get(run.runId)!, childResults: [...(run.childResults ?? []).filter(item => item.taskId !== taskId), { taskId, commandId: `child-result:${digest(Buffer.from(commandId))}`, title, path }] });
      return { ...value, executionProgress: path || value.executionProgress === 'ready' ? 'ready' : 'processing', reason: summary, nextStep: path || value.executionProgress === 'ready' ? '成果候选已登记，等待父运行停止后核对；尚未交付。' : '由父任务会话继续处理。' };
    });
  }

  private processingFailed(observed: Task, error: unknown): void {
    try {
      const current = this.tasks.get(observed.taskId);
      if (current.revision !== observed.revision || !['waiting', 'review'].includes(current.status)) return;
      const reason = error instanceof TaskServiceError ? error.message : '服务端未能保存或核对成果，请检查任务会话中的提交记录。';
      this.tasks.transition(current.taskId, { commandId: `artifact-error:${createHash('sha256').update(`${current.taskId}:${current.revision}`).digest('hex')}`, revision: current.revision, key: reason, kind: 'artifact-error', summary: reason }, (task) => ({ ...task, status: 'failed', reason, nextStep: '核对成果提交失败原因后重试任务。' }));
    } catch { /* 候选或任务已变化时不覆盖后续事实。 */ }
  }
  list(taskId: string): ArtifactVersion[] { this.tasks.get(taskId); return this.versions.list(taskId); }
  get(id: string): ArtifactVersion { const version = this.versions.get(id); if (!version) throw new TaskServiceError('NOT_FOUND', '成果版本不存在。'); return version; }
  async read(id: string): Promise<{ version: ArtifactVersion; content: string }> {
    const version = this.get(id);
    let bytes: Buffer;
    try { bytes = await readFile(join(this.root, version.fileKey)); }
    catch { throw new TaskServiceError('NOT_FOUND', '成果文件已失效。'); }
    if (bytes.length !== version.size || digest(bytes) !== version.sha256) throw new TaskServiceError('TASK_CONFLICT', '成果文件与固定版本不一致。');
    try { return { version, content: new TextDecoder('utf8', { fatal: true }).decode(bytes) }; }
    catch { throw new TaskServiceError('INVALID_REQUEST', '成果不是可阅读的 UTF-8 文本。'); }
  }
  async submit(taskId: string, input: SubmitArtifact): Promise<ArtifactVersion> {
    if (!Check(SubmitArtifactSchema, input) || (input.path === undefined) === (input.text === undefined)) throw new TaskServiceError('INVALID_REQUEST', '成果必须指定一个文件或独立文本。');
    const versionId = createHash('sha256').update(`${taskId}:${input.commandId}`).digest('hex');
    const existing = this.versions.get(versionId);
    if (existing) {
      this.tasks.transition(taskId, { commandId: input.commandId, revision: input.revision, key: fingerprint(input), kind: 'artifact', summary: '成果已提交。' }, (task) => task);
      return existing;
    }
    const task = this.tasks.get(taskId);
    const run = this.runs.get(input.runId);
    if (!run || run.taskId !== taskId && !run.treeTasks?.some(child => child.taskId === taskId && !child.humanOnly) || !run.directory || task.currentRunId !== run.runId) throw new TaskServiceError('INVALID_REQUEST', '成果必须引用该任务当前的真实运行。');
    if (!run.stopConfirmed) throw new TaskServiceError('INVALID_REQUEST', '当前运行尚未确认停止，不能读取可能仍被修改的成果。');
    if (run.treeTasks?.length && !this.readyForDelivery(task, run)) throw new TaskServiceError('INVALID_REQUEST', '必要子任务或依赖尚未交付，不能提交整合成果。');
    if (task.status === 'done') throw new TaskServiceError('INVALID_REQUEST', '已完成的任务不能覆写成果。');
    const bytes = input.text === undefined ? await this.sourceFile(run.directory.path, input.path!) : Buffer.from(input.text, 'utf8');
    if (!bytes.length || bytes.length > MAX_BYTES) throw new TaskServiceError('INVALID_REQUEST', '成果为空或超过阅读上限。');
    let content: string;
    try { content = new TextDecoder('utf8', { fatal: true }).decode(bytes); } catch { throw new TaskServiceError('INVALID_REQUEST', '成果必须为 UTF-8 文本。'); }
    if (!content.trim() || !input.title.trim()) throw new TaskServiceError('INVALID_REQUEST', '成果标题和内容不能为空。');
    const previous = this.versions.list(taskId);
    if (previous.length >= 100) throw new TaskServiceError('INVALID_REQUEST', '成果版本达到保留上限。');
    const version: ArtifactVersion = {
      artifactId: previous[0]?.artifactId ?? randomUUID(), versionId, taskId, runId: run.runId,
      version: (previous[0]?.version ?? 0) + 1, title: input.title.trim(),
      sourceKind: input.text === undefined ? 'file' : 'user-text', sourcePath: input.path ?? null,
      sha256: digest(bytes), size: bytes.length, fileKey: versionId,
      createdAt: new Date().toISOString(), status: 'submitted', feedback: '',
      checks: [{ name: '内容完整性', passed: true, evidence: `SHA-256 ${digest(bytes)}` }, { name: '非空 UTF-8 文本', passed: true, evidence: `${bytes.length} 字节` }],
    };
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try { await writeFile(join(this.root, version.fileKey), bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || digest(await readFile(join(this.root, version.fileKey))) !== version.sha256) throw new TaskServiceError('TASK_CONFLICT', '成果存储失败或版本内容冲突。');
    }
    this.tasks.transition(taskId, { commandId: input.commandId, revision: input.revision, key: fingerprint(input), kind: 'artifact', summary: `已保存成果「${version.title}」版本 ${version.version}。` }, (current) => {
      this.versions.save(version);
      return { ...current, artifactVersionId: versionId, reason: current.status === 'cancelled' ? current.reason : '成果候选已保存，等待执行终结与核对。' };
    });
    this.requests.supersedeReviews(taskId, versionId);
    await this.finalize(taskId, versionId);
    return this.get(versionId);
  }
  registerSession(sessionId: string, commandId: string, title: string, path: string): void {
    const run = this.runs.bySession(sessionId);
    if (!run || run.stopIntent) throw new TaskServiceError('INVALID_REQUEST', '当前任务执行不能提交成果。');
    const task = this.tasks.get(run.taskId);
    if (task.currentRunId !== run.runId || task.status !== 'running' || !title.trim() || !path.trim() || isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new TaskServiceError('INVALID_REQUEST', '成果提交意图越出当前任务边界。');
    if (run.treeTasks?.some(child => !satisfiesTaskDependency(this.tasks.get(child.taskId).status) && !run.childResults?.some(result => result.taskId === child.taskId))) throw new TaskServiceError('INVALID_REQUEST', '仍有子任务尚未交付或登记成果候选。');
    this.tasks.facts(() => this.runs.save({ ...run, artifactCandidate: { commandId, title: title.trim(), path } }));
  }
  private async sourceFile(root: string, path: string): Promise<Buffer> {
    if (isAbsolute(path) || path.includes('\0')) throw new TaskServiceError('INVALID_REQUEST', '成果文件必须在任务目录内。');
    const target = resolve(root, path);
    const inside = relative(root, target);
    if (!inside || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) throw new TaskServiceError('INVALID_REQUEST', '成果文件越出任务目录。');
    let current = root;
    for (const part of inside.split(sep)) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new TaskServiceError('INVALID_REQUEST', '成果不能引用符号链接。');
    }
    const stat = await lstat(target);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new TaskServiceError('INVALID_REQUEST', '成果不是普通文本或超过阅读上限。');
    const bytes = await readFile(target);
    if (bytes.length > MAX_BYTES) throw new TaskServiceError('INVALID_REQUEST', '成果超过阅读上限。');
    return bytes;
  }
  private async finalize(taskId: string, versionId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    const version = this.get(versionId);
    const run = this.runs.get(version.runId);
    if (!run?.stopConfirmed || run.status !== 'settled' || task.currentRunId !== run.runId || version.status !== 'submitted' || task.artifactVersionId !== versionId || ['done', 'cancelled'].includes(task.status)) return;
    if (run.treeTasks?.length && !this.readyForDelivery(task, run)) throw new TaskServiceError('INVALID_REQUEST', '子任务或依赖已变化，整合成果暂不能交付。');
    const { content } = await this.read(versionId);
    let machine = task.acceptanceCriteria === '非空文本';
    if (task.acceptanceCriteria === '有效 JSON') { try { JSON.parse(content); machine = true; } catch { machine = false; } }
    const canComplete = task.status !== 'paused' && !task.acceptance && machine && run.toolFailures === 0 && !this.requests.pending(taskId) && task.dependencyIds.every((id) => satisfiesTaskDependency(this.tasks.get(id).status));
    if (canComplete) {
      this.tasks.transition(taskId, { commandId: `artifact-verified:${versionId}`, key: versionId, kind: 'verified', summary: '成果通过已声明的服务端结构自检。' }, (current) => {
        if (run.treeTasks?.length && !this.readyForDelivery(current, run)) throw new TaskServiceError('TASK_CONFLICT', '子任务或依赖已变化，不能完成整体成果。');
        if (current.artifactVersionId !== versionId || current.currentRunId !== run.runId || ['done', 'cancelled', 'paused'].includes(current.status)) throw new TaskServiceError('TASK_CONFLICT', '成果候选已变化。');
        this.versions.save({ ...version, status: 'accepted', checks: [...version.checks, { name: task.acceptanceCriteria, passed: true, evidence: '服务端按声明的结构规则核对，运行已停止且没有工具失败。' }] });
        return { ...current, status: 'done', completedAt: new Date().toISOString(), reason: '固定成果版本通过服务端自检。', nextStep: '查看成果。' };
      });
    } else this.requests.create(taskId, 'review', `请验收「${version.title}」版本 ${version.version}。${!task.acceptance && !machine ? '当前验收要求需要人工判断。' : ''}`, `artifact-review:${versionId}`, versionId);
  }
  private async prepareReview(request: HumanRequest, input: DecideHumanRequest): Promise<(task: Task) => Task> {
    if (!request.artifactVersionId || !['accept', 'changes'].includes(input.decision)) throw new TaskServiceError('INVALID_REQUEST', '成果审核决定无效。');
    if (input.decision === 'changes' && !input.answer?.trim()) throw new TaskServiceError('INVALID_REQUEST', '请填写修改意见。');
    const { version } = await this.read(request.artifactVersionId);
    return (task) => {
      const run = this.runs.get(version.runId);
      if (task.artifactVersionId !== version.versionId || task.currentRunId !== version.runId || request.runId !== version.runId || !run?.stopConfirmed || task.status === 'cancelled') throw new TaskServiceError('TASK_CONFLICT', '成果版本或执行状态已变化，不能审核旧候选。');
      if (input.decision === 'accept' && run.treeTasks?.length && !this.readyForDelivery(task, run)) throw new TaskServiceError('INVALID_REQUEST', '子任务或依赖尚未满足，不能验收整体成果。');
      if (input.decision === 'accept' && this.requests.pending(task.taskId, request.requestId)) throw new TaskServiceError('INVALID_REQUEST', '还有其他待处理请求，请先处理后再验收。');
      if (input.decision === 'accept' && task.dependencyIds.some((id) => !satisfiesTaskDependency(this.tasks.get(id).status))) throw new TaskServiceError('INVALID_REQUEST', '前置任务尚未满足依赖，不能以验收绕过依赖。');
      this.versions.save({ ...version, status: input.decision === 'accept' ? 'accepted' : 'changes', feedback: input.answer?.trim() ?? '' });
      return input.decision === 'accept'
        ? { ...task, status: 'done', completedAt: new Date().toISOString(), reason: `成果版本 ${version.version} 已由用户验收。`, nextStep: '查看已验收成果。' }
        : { ...task, status: 'paused', pauseSource: task.pauseSource === 'user' ? 'user' : 'human', feedback: input.answer?.trim() ?? '', reason: '修改意见已保存，旧版本与审核记录保留。', nextStep: '按原边界修改并提交新版本。' };
    };
  }
  dispose(): void { this.disposed = true; this.unsubscribe(); }
}
