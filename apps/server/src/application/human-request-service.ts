import { createHash, randomUUID } from 'node:crypto';
import { Check } from 'typebox/value';
import { DecideHumanRequestSchema, HumanRequestQuerySchema, UNKNOWN_CHANGE_ORIGIN, type DecideHumanRequest, type HumanRequest, type HumanRequestQuery, type HumanRequestList, type Task, type WorkbenchChangeOrigin } from '@multivac/contracts';
import type { HumanRequestRepository } from '../modules/tasks/human-request.js';
import type { TaskRunRepository } from '../modules/tasks/task.js';
import { TaskService, TaskServiceError, fingerprint } from './task-service.js';
import type { TaskExecutionService } from './task-execution-service.js';
import type { WorkbenchEvents } from './workbench-events.js';
import type { AssistantEventStream } from './assistant-event-stream.js';
import type { ToolAuthorizationService } from './tool-authorization-service.js';

export interface HumanRequestOptions {
  tasks: TaskService; runs: TaskRunRepository; requests: HumanRequestRepository;
  execution: TaskExecutionService; events: WorkbenchEvents; assistantEvents: AssistantEventStream;
  authorization: Pick<ToolAuthorizationService, 'list' | 'decide'>;
}

/** 用户可从界面或全局对话回应任务请求；对话端口不能处理权限授权。 */
export class HumanRequestService {
  private readonly unsubscribe: () => void;
  private readonly unsubscribeTask: () => void;
  private review: ((request: HumanRequest, input: DecideHumanRequest) => Promise<(task: Task) => Task>) | undefined;
  constructor(private readonly options: HumanRequestOptions) {
    options.execution.setPendingRequest((id) => this.pending(id));
    this.unsubscribe = options.assistantEvents.subscribe((event) => {
      if (event.type !== 'assistant.authorization.requested' && event.type !== 'assistant.authorization.resolved') return;
      const source = event.data.request;
      const run = options.runs.bySession(source.sessionId);
      if (!run || source.commandId !== run.commandId) return;
      const requestId = `authorization:${source.requestId}`;
      const existing = options.requests.get(requestId);
      const request: HumanRequest = {
        requestId, taskId: run.taskId, runId: run.runId, sessionId: run.sessionId, kind: 'authorization',
        revision: (existing?.revision ?? 0) + 1, status: source.status === 'pending' ? 'pending' : ['approved', 'denied'].includes(source.status) ? 'answered' : 'invalidated',
        question: `是否允许 ${source.toolName} 访问 ${source.targetPath}？`, artifactVersionId: null, authorizationRequestId: source.requestId,
        decision: source.status === 'denied' ? 'deny' : source.status === 'approved' ? source.approval?.scope ?? 'once' : null,
        answer: '', reason: source.status, createdAt: source.createdAt, updatedAt: source.decidedAt ?? source.createdAt,
      };
      options.tasks.transition(run.taskId, { commandId: `authorization-event:${randomUUID()}`, key: requestId, kind: 'authorization', summary: source.status === 'pending' ? '执行正在等待工具授权。' : '工具授权已有处理结果。' }, (task) => {
        options.requests.save(request);
        if (task.status === 'cancelled' || run.stopIntent === 'cancel') return task;
        return { ...task, status: source.status === 'pending' ? 'waiting' : task.pauseSource === 'user' ? 'paused' : 'running', reason: source.status === 'pending' ? request.question : '工具授权结果已交回原执行上下文。' };
      });
      options.events.publish({ type: 'request.changed', origin: UNKNOWN_CHANGE_ORIGIN, request });
    });
    this.unsubscribeTask = options.events.subscribe((event) => {
      if (event.type !== 'task.changed') return;
      const run = event.task.currentRunId ? options.runs.get(event.task.currentRunId) : null;
      if (event.task.status === 'cancelled' || run?.stopIntent === 'cancel') this.invalidate(event.task.taskId);
      if (event.task.status === 'recovery' && !this.list(event.task.taskId).some((request) => request.kind === 'recovery' && request.status === 'pending')) this.create(event.task.taskId, 'recovery', '如何处理上次未确认的执行？请先核对停止与副作用结果。', `recovery:${event.task.currentRunId ?? event.task.taskId}`);
    });
    for (const run of options.runs.active()) if (options.tasks.get(run.taskId).status === 'recovery') this.create(run.taskId, 'recovery', '上次执行结果不明，请核对旧执行停止与副作用。', `recovery:${run.runId}`);
  }
  list(taskId?: string): HumanRequest[] { return this.options.requests.list(taskId).map((request) => ({ ...request, stopConfirmed: request.runId ? this.options.runs.get(request.runId)?.stopConfirmed ?? false : true })); }
  page(query: HumanRequestQuery = {}): HumanRequestList {
    if (!Check(HumanRequestQuerySchema, query)) throw new TaskServiceError('INVALID_REQUEST', '人工请求查询条件无效。');
    if (query.taskId) this.options.tasks.get(query.taskId);
    const page = this.options.requests.page(query);
    return { ...page, requests: page.requests.map((request) => this.get(request.requestId)) };
  }
  get(id: string): HumanRequest {
    const request = this.options.requests.get(id);
    if (!request) throw new TaskServiceError('NOT_FOUND', '人工请求不存在。');
    return { ...request, stopConfirmed: request.runId ? this.options.runs.get(request.runId)?.stopConfirmed ?? false : true };
  }
  pending(taskId: string): boolean { return this.list(taskId).some((request) => request.status === 'pending'); }
  setReview(verify: NonNullable<HumanRequestService['review']>): void { this.review = verify; }

  create(taskId: string, kind: HumanRequest['kind'], question: string, commandId: string, artifactVersionId: string | null = null, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): HumanRequest {
    question = question.trim();
    const requestId = createHash('sha256').update(`${taskId}:${commandId}`).digest('hex');
    const existing = this.options.requests.get(requestId);
    if (existing) {
      if (existing.question !== question || existing.kind !== kind || existing.artifactVersionId !== artifactVersionId) throw new TaskServiceError('COMMAND_ID_CONFLICT', '同一请求命令不能用于不同内容。');
      return existing;
    }
    if (!question.trim() || question.length > 4000) throw new TaskServiceError('INVALID_REQUEST', '请求问题为空或超过限制。');
    let created: HumanRequest | undefined;
    this.options.tasks.transition(taskId, { commandId, key: fingerprint({ kind, question, artifactVersionId }), kind: 'request', summary: question }, (task) => {
      if (['done', 'cancelled'].includes(task.status)) throw new TaskServiceError('INVALID_REQUEST', '终态任务不能创建推进请求。');
      const run = task.currentRunId ? this.options.runs.get(task.currentRunId) : null;
      if (run?.stopIntent === 'cancel') throw new TaskServiceError('INVALID_REQUEST', '任务正在取消。');
      const pending = this.options.requests.list(taskId).find((request) => request.status === 'pending' && request.kind === kind && request.artifactVersionId === artifactVersionId);
      if (pending) { created = pending; return task; }
      const at = new Date().toISOString();
      created = { requestId, taskId, runId: run?.runId ?? null, sessionId: task.sessionId, kind, revision: 1, status: 'pending', question: question.trim(), artifactVersionId, authorizationRequestId: null, decision: null, answer: '', reason: '', createdAt: at, updatedAt: at };
      this.options.requests.save(created);
      let status: Task['status'] = kind === 'review' ? 'review' : kind === 'recovery' ? 'recovery' : task.pauseSource === 'user' ? 'paused' : 'waiting';
      if (kind === 'review' && task.status === 'paused' && task.pauseSource === 'user') status = 'paused';
      return { ...task, status, pauseSource: task.pauseSource === 'user' ? 'user' : 'human', reason: question, nextStep: '等待用户处理原请求。' };
    }, origin);
    const request = created ?? this.get(requestId);
    this.options.events.publish({ type: 'request.changed', origin, request });
    if (kind === 'clarification') queueMicrotask(() => { void this.options.execution.stopForHuman(taskId, request.runId ?? undefined).catch(() => undefined); });
    return request;
  }
  askSession(sessionId: string, commandId: string, question: string): HumanRequest {
    const run = this.options.runs.bySession(sessionId);
    if (!run || run.stopConfirmed || run.stopIntent) throw new TaskServiceError('INVALID_REQUEST', '当前没有可提问的任务执行。');
    return this.create(run.taskId, 'clarification', question, commandId);
  }

  /** 全局对话转交用户明确给出的决定，授权请求始终留在界面通道。 */
  async respond(id: string, input: DecideHumanRequest, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): Promise<HumanRequest> {
    if (this.get(id).kind === 'authorization' || ['once', 'session', 'project'].includes(input.decision)) {
      throw new TaskServiceError('INVALID_REQUEST', '权限授权只能由用户在界面中处理。');
    }
    return this.decide(id, input, origin);
  }

  async decide(id: string, input: DecideHumanRequest, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): Promise<HumanRequest> {
    if (!Check(DecideHumanRequestSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '人工决定参数无效。');
    const request = this.get(id);
    if (request.status === 'answered') {
      if (request.decision === input.decision && request.answer === (input.answer?.trim() ?? '')) return request;
      throw new TaskServiceError('TASK_CONFLICT', '请求已有不同决定。');
    }
    if (request.status !== 'pending' || request.revision !== input.revision) throw new TaskServiceError('TASK_CONFLICT', '请求已变化或失效。');
    const task = this.options.tasks.get(request.taskId);
    const run = request.runId ? this.options.runs.get(request.runId) : null;
    if (request.runId && request.runId !== task.currentRunId) throw new TaskServiceError('TASK_CONFLICT', '请求所属运行已变化。');
    if (task.status === 'cancelled' || run?.stopIntent === 'cancel') throw new TaskServiceError('INVALID_REQUEST', '取消中的任务不能通过迟到决定恢复。');
    if (request.kind === 'authorization') {
      if (!['once', 'session', 'project', 'deny'].includes(input.decision) || !request.sessionId || !request.authorizationRequestId) throw new TaskServiceError('INVALID_REQUEST', '授权决定无效。');
      this.options.authorization.decide(request.sessionId, request.authorizationRequestId, input.decision as 'once' | 'session' | 'project' | 'deny', origin);
      return this.get(id);
    }
    if (request.kind === 'clarification' && !['answer', 'deny', 'stop'].includes(input.decision)) throw new TaskServiceError('INVALID_REQUEST', '澄清决定无效。');
    if (request.kind === 'clarification' && input.decision === 'answer' && !input.answer?.trim()) throw new TaskServiceError('INVALID_REQUEST', '请填写回应。');
    if (request.kind === 'recovery' && !['continue', 'stop'].includes(input.decision)) throw new TaskServiceError('INVALID_REQUEST', '恢复决定无效。');
    if (request.kind === 'recovery' && input.decision === 'continue' && !run?.stopConfirmed) throw new TaskServiceError('INVALID_REQUEST', '旧执行停止尚不能确认，用户决定不能绕过此门禁。');
    if (request.kind === 'recovery' && input.decision === 'stop' && run && !run.stopConfirmed) {
      // 先对真实执行发出停止意图；不能以保存用户决定替代停止证明。
      await this.options.execution.control(task.taskId, { commandId: `recovery-stop:${createHash('sha256').update(input.commandId).digest('hex')}`, revision: task.revision, action: 'pause' }, origin);
    }
    const review = request.kind === 'review' ? await this.review?.(request, input) : undefined;
    if (request.kind === 'review' && !review) throw new TaskServiceError('INVALID_REQUEST', '成果审核尚未接入。');
    this.options.tasks.transition(task.taskId, { commandId: input.commandId, key: fingerprint({ id, ...input }), kind: 'decision', summary: '用户已回应人工请求。' }, (current) => {
      const fresh = this.get(id);
      if (fresh.runId && fresh.runId !== current.currentRunId) throw new TaskServiceError('TASK_CONFLICT', '请求所属运行已变化。');
      if (fresh.status !== 'pending' || fresh.revision !== input.revision) throw new TaskServiceError('TASK_CONFLICT', '请求已变化。');
      const answer = input.answer?.trim() ?? '';
      this.options.requests.save({ ...fresh, status: 'answered', revision: fresh.revision + 1, decision: input.decision, answer, updatedAt: new Date().toISOString() });
      if (review) return review(current);
      if (request.kind === 'recovery' && request.runId && !this.options.runs.get(request.runId)?.stopConfirmed) {
        return { ...current, status: 'recovery', pauseSource: 'user', reason: '保持停止请求已保存，旧执行停止尚未确认。', nextStep: '核对旧执行停止与副作用，不能启动新执行。' };
      }
      const stay = current.pauseSource === 'user' || input.decision === 'stop';
      return { ...current, status: 'paused', pauseSource: stay ? 'user' : 'human', feedback: `${request.question}\n用户决定：${input.decision}\n${answer}`, reason: stay ? '回应已保存，用户暂停保持。' : '用户回应已保存，准备按原边界继续。', nextStep: stay ? '由用户继续执行。' : '核对执行条件后继续。' };
    }, origin);
    const decided = this.get(id);
    this.options.events.publish({ type: 'request.changed', origin, request: decided });
    const updated = this.options.tasks.get(task.taskId);
    if (updated.status === 'paused' && updated.pauseSource === 'human' && !this.pending(task.taskId)) {
      try { await this.options.execution.control(task.taskId, { commandId: `decision-resume:${createHash('sha256').update(input.commandId).digest('hex')}`, revision: updated.revision, action: 'resume' }, origin); }
      catch { /* 回应已落盘；预算或旧执行仍不满足条件时保持停止，不伪造继续成功。 */ }
    }
    return decided;
  }
  supersedeReviews(taskId: string, versionId: string): void {
    const superseded = this.list(taskId).filter((request) => request.status === 'pending' && request.kind === 'review' && request.artifactVersionId !== versionId);
    if (!superseded.length) return;
    this.options.tasks.facts(() => {
      for (const request of superseded) this.options.requests.save({ ...request, status: 'invalidated', revision: request.revision + 1, reason: '新成果版本已替换旧候选。', updatedAt: new Date().toISOString() });
    });
    for (const request of superseded) this.options.events.publish({ type: 'request.changed', origin: UNKNOWN_CHANGE_ORIGIN, request: this.get(request.requestId) });
  }
  invalidate(taskId: string): void {
    const pending = this.list(taskId).filter((request) => request.status === 'pending');
    if (!pending.length) return;
    this.options.tasks.facts(() => { for (const request of pending) this.options.requests.save({ ...request, status: 'invalidated', revision: request.revision + 1, reason: '任务已取消。', updatedAt: new Date().toISOString() }); });
    for (const request of pending) this.options.events.publish({ type: 'request.changed', origin: UNKNOWN_CHANGE_ORIGIN, request: this.get(request.requestId) });
  }
  dispose(): void { this.unsubscribe(); this.unsubscribeTask(); }
}
