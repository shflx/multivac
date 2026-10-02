import { randomUUID } from 'node:crypto';
import { Check } from 'typebox/value';
import { DEFAULT_WORKSPACE_ID, TaskControlSchema, UNKNOWN_CHANGE_ORIGIN, type Task, type TaskControl, type TaskReceipt, type TaskRun, type WorkingDirectory, type AssistantCommandReceipt, type AssistantPublicEvent, type WorkbenchChangeOrigin } from '@multivac/contracts';
import type { TaskRunRepository } from '../modules/tasks/task.js';
import type { AssistantTurnCommandService } from './assistant-turn-command-service.js';
import type { AssistantEventStream } from './assistant-event-stream.js';
import { TaskService, TaskServiceError, fingerprint } from './task-service.js';

export interface TaskExecutionRuntime {
  commands: Pick<AssistantTurnCommandService, 'send' | 'cancel' | 'currentPromptCommandId'>;
}
export interface TaskExecutionOptions {
  tasks: TaskService;
  runs: TaskRunRepository;
  prepare: (task: Task, runId: string, signal: AbortSignal) => Promise<{ directory: WorkingDirectory; baseline: string | null }>;
  createSession: (input: { sessionId: string; title: string; workspaceId: string; workingDirectory: WorkingDirectory }) => Promise<unknown>;
  runtime: (sessionId: string) => TaskExecutionRuntime;
  events: AssistantEventStream;
  now?: () => string;
  stopTimeoutMs?: number;
  confirmedStopped?: (sessionId: string) => boolean;
}

/** Task 的执行意图与 Pi 命令分开持久化；一次执行结束不会写成长期任务完成。 */
export class TaskExecutionService {
  readonly ownerId = randomUUID();
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly unsubscribe: () => void;
  private disposed = false;
  private readonly now: () => string;

  constructor(private readonly options: TaskExecutionOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.unsubscribe = options.events.subscribe((event) => this.project(event));
  }

  async control(taskId: string, input: TaskControl, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): Promise<TaskReceipt> {
    if (!Check(TaskControlSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '任务控制参数无效。');
    let runToStart: string | null = null;
    let runToStop: string | null = null;
    const result = this.options.tasks.transition(taskId, { commandId: input.commandId, revision: input.revision, key: fingerprint({ taskId, ...input }), kind: input.action, summary: `已受理任务${{ start: '启动', pause: '暂停', resume: '继续', cancel: '取消' }[input.action]}请求。` }, (task) => {
      const previous = task.currentRunId ? this.options.runs.get(task.currentRunId) : null;
      if (previous?.stopIntent === 'cancel' && input.action !== 'cancel') throw new TaskServiceError('INVALID_REQUEST', '取消意图不能被暂停或继续覆盖。');
      if (['done', 'cancelled'].includes(task.status)) throw new TaskServiceError('INVALID_REQUEST', '任务已处于终态。');
      if (input.action === 'start' || input.action === 'resume') {
        if (previous && !previous.stopConfirmed) throw new TaskServiceError('INVALID_REQUEST', '旧执行尚未确认停止，不能启动冲突执行。');
        if (!['idle', 'paused', 'failed', 'waiting'].includes(task.status)) throw new TaskServiceError('INVALID_REQUEST', '任务当前不能启动或继续。');
        if (task.dependencyIds.some((id) => this.options.tasks.get(id).status !== 'done')) throw new TaskServiceError('INVALID_REQUEST', '前置任务尚未完成。');
        const prompt = this.prompt(task);
        if (Buffer.byteLength(prompt, 'utf8') > 12 * 1024) throw new TaskServiceError('INVALID_REQUEST', '目标与范围超过单次执行上下文上限，请缩小任务。');
        const sameBoundary = previous?.directory && previous.goal === task.goal && previous.scope === task.scope && previous.projectId === task.projectId;
        const runId = randomUUID();
        const at = this.now();
        const run: TaskRun = {
          runId, taskId, sessionId: sameBoundary ? previous.sessionId : randomUUID(), commandId: `task-run:${runId}`,
          status: 'preparing', stopIntent: null, stopConfirmed: false, ownerId: this.ownerId,
          directory: sameBoundary ? previous.directory : null, baseline: sameBoundary ? previous.baseline : null,
          goal: task.goal, scope: task.scope, projectId: task.projectId, pendingToolIds: [], toolFailures: 0,
          lastEventCursor: 0,
          piSessionId: null, piEntryId: null, reason: '准备执行环境。', createdAt: at, updatedAt: at,
        };
        this.options.runs.save(run);
        runToStart = runId;
        return { ...task, status: 'queued', currentRunId: runId, sessionId: run.sessionId, reason: run.reason, nextStep: '核对执行目录与模型后启动。' };
      }
      if (input.action === 'pause' && !['queued', 'running', 'waiting'].includes(task.status)) throw new TaskServiceError('INVALID_REQUEST', '任务当前不能暂停。');
      if (previous && !previous.stopConfirmed) {
        previous.stopIntent = input.action;
        previous.status = 'stopping';
        previous.updatedAt = this.now();
        previous.reason = input.action === 'cancel' ? '取消已受理，正在停止真实执行。' : '暂停已受理，正在保存与停止真实执行。';
        this.options.runs.save(previous);
        runToStop = previous.runId;
        return { ...task, reason: previous.reason, nextStep: '等待停止确认。' };
      }
      return { ...task, status: input.action === 'cancel' ? 'cancelled' : 'paused', reason: input.action === 'cancel' ? '任务已取消，已有记录与目录保留。' : '任务已由用户暂停。', nextStep: input.action === 'cancel' ? '查看保留的记录。' : '由用户继续执行。' };
    }, origin);
    if (runToStart) this.launch(runToStart);
    if (runToStop) {
      this.active.get(runToStop)?.controller.abort();
      const run = this.options.runs.get(runToStop)!;
      const stopping = (async () => {
        try {
          const runtime = this.options.runtime(run.sessionId);
          if (runtime.commands.currentPromptCommandId()) await runtime.commands.cancel({ commandId: `task-stop:${run.runId}`, assistantSessionId: run.sessionId });
        } catch { /* 准备阶段可能尚无会话；仍须等当前执行 Promise 收尾，不能提前释放租约。 */ }
        const active = this.active.get(run.runId);
        if (active) await active.promise;
        else if (!this.options.runs.get(run.runId)?.stopConfirmed) this.unknownStop(run.runId);
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stopped = await Promise.race([
        stopping.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), this.options.stopTimeoutMs ?? 60000); }),
      ]);
      if (timer) clearTimeout(timer);
      if (!stopped) this.unknownStop(runToStop);
      return result;
    }
    return result;
  }

  private prompt(task: Task): string {
    return `任务：${task.title}\n目标：${task.goal}\n范围：${task.scope || '仅本任务独立目录'}\n验收要求：${task.acceptanceCriteria || '提交可核对的成果与证据'}\n` +
      '在任务独立目录完成工作，保留来源与验证证据。原生任务工具拒绝目录外访问、网络和创建子进程；不要绕过这些限制。运行结束不等于任务完成，请将成果写为独立文件，说明实际完成、未完成和验证失败的部分。';
  }

  private launch(runId: string): void {
    if (this.disposed || this.active.has(runId)) return;
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => this.execute(runId, controller.signal)).finally(() => this.active.delete(runId));
    this.active.set(runId, { controller, promise });
  }

  private async execute(runId: string, signal: AbortSignal): Promise<void> {
    let receipt: AssistantCommandReceipt | undefined;
    let failure: string | undefined;
    try {
      let run = this.options.runs.get(runId)!;
      const task = this.options.tasks.get(run.taskId);
      if (!run.directory) {
        const prepared = await this.options.prepare(task, runId, signal);
        this.updateRun(runId, 'prepared', (current, task) => {
          current.directory = prepared.directory; current.baseline = prepared.baseline;
          return task;
        });
      }
      signal.throwIfAborted();
      run = this.options.runs.get(runId)!;
      if (!run.directory) throw new Error('没有可用的任务独立目录。');
      await this.options.createSession({ sessionId: run.sessionId, title: task.title, workspaceId: task.projectId ?? DEFAULT_WORKSPACE_ID, workingDirectory: run.directory });
      signal.throwIfAborted();
      this.updateRun(runId, 'dispatching', (current, task) => {
        current.status = 'running'; current.reason = '已进入真实执行会话。';
        return { ...task, status: 'running', reason: current.reason, nextStep: '等待执行结果与成果提交。' };
      });
      receipt = await this.options.runtime(run.sessionId).commands.send({ commandId: run.commandId, assistantSessionId: run.sessionId, text: this.prompt(task), contextRefs: [] }, { signal });
    } catch (error) { failure = signal.aborted ? undefined : error instanceof Error ? error.message : '任务执行失败。'; }
    if (this.disposed) return;
    this.updateRun(runId, 'settled', (run, task) => {
      // Pi 返回只是本轮结果；若工具没有结束事实，保留租约并等待恢复确认。
      run.stopConfirmed = run.pendingToolIds.length === 0 || this.options.confirmedStopped?.(run.sessionId) === true;
      if (run.stopConfirmed && run.pendingToolIds.length) {
        run.toolFailures += run.pendingToolIds.length;
        run.pendingToolIds = [];
      }
      run.piSessionId = receipt?.piSessionId ?? run.piSessionId;
      run.piEntryId = receipt?.piEntryId ?? null;
      const outcome = receipt?.terminalOutcome;
      if (!run.stopConfirmed) {
        run.status = 'recovery'; run.reason = '工具停止事实不完整，旧执行租约仍保留。';
        return { ...task, status: 'recovery', reason: run.reason, nextStep: '核对旧执行停止与副作用结果。' };
      }
      if (run.stopIntent) {
        run.status = run.stopIntent === 'cancel' ? 'cancelled' : 'paused';
        run.reason = run.stopIntent === 'cancel' ? '真实执行已停止，任务已取消。' : '真实执行已停止，用户暂停保留。';
        return { ...task, status: run.status, reason: run.reason, nextStep: run.stopIntent === 'cancel' ? '查看已有记录和目录。' : '由用户继续执行。' };
      }
      run.status = failure || outcome !== 'succeeded' ? 'failed' : 'settled';
      run.reason = failure ?? receipt?.error?.message ?? (run.status === 'settled' ? '本轮执行已结束，尚未判定长期任务完成。' : '本轮执行未成功。');
      return { ...task, status: run.status === 'failed' ? 'failed' : 'waiting', reason: run.reason, nextStep: run.status === 'failed' ? '检查失败原因后继续。' : '提交成果与验证证据。' };
    });
  }

  private updateRun(runId: string, kind: string, change: (run: TaskRun, task: Task) => Task): void {
    const run = this.options.runs.get(runId);
    if (!run || run.ownerId !== this.ownerId || this.disposed) return;
    this.options.tasks.transition(run.taskId, { commandId: `run-event:${randomUUID()}`, key: fingerprint({ runId, kind }), kind, summary: `运行记录：${kind}。` }, (task) => {
      if (task.currentRunId !== runId) return task;
      const current = this.options.runs.get(runId)!;
      const next = change(current, task);
      current.updatedAt = this.now();
      this.options.runs.save(current);
      return next;
    });
  }

  private unknownStop(runId: string): void {
    this.updateRun(runId, 'stop-unknown', (run, task) => {
      run.stopConfirmed = false; run.status = 'recovery'; run.reason = '停止结果尚不能确认，未释放执行租约。';
      return { ...task, status: 'recovery', reason: run.reason, nextStep: '核对旧执行停止与副作用结果。' };
    });
  }

  private project(event: AssistantPublicEvent): void {
    const run = this.options.runs.active().find((candidate) => candidate.sessionId === event.assistantSessionId && candidate.commandId === event.commandId && candidate.ownerId === this.ownerId);
    if (!run) return;
    const cursor = Number(event.cursor);
    if (!Number.isSafeInteger(cursor) || cursor <= (run.lastEventCursor ?? 0)) return;
    if (event.type === 'assistant.tool.started' || event.type === 'assistant.tool.ended') {
      this.updateRun(run.runId, event.type, (current, task) => {
        if (cursor <= (current.lastEventCursor ?? 0)) return task;
        current.lastEventCursor = cursor;
        if (event.type === 'assistant.tool.started') current.pendingToolIds = [...new Set([...current.pendingToolIds, event.data.toolCallId])];
        else {
          current.pendingToolIds = current.pendingToolIds.filter((id) => id !== event.data.toolCallId);
          if (event.data.isError) current.toolFailures += 1;
        }
        return { ...task, reason: current.pendingToolIds.length ? `正在执行工具，${current.pendingToolIds.length} 项待结束。` : '正在推进任务目标。' };
      });
    }
  }

  async idle(): Promise<void> { await Promise.all([...this.active.values()].map((entry) => entry.promise)); }
  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    for (const entry of this.active.values()) entry.controller.abort();
  }
}
