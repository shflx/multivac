import { satisfiesTaskDependency } from '@multivac/contracts';
import { randomUUID } from 'node:crypto';
import { DEFAULT_TASK_BUDGET } from '@multivac/contracts';
import { Check } from 'typebox/value';
import { DEFAULT_WORKSPACE_ID, TaskControlSchema, UNKNOWN_CHANGE_ORIGIN, type Task, type TaskBudget, type TaskControl, type TaskReceipt, type TaskRun, type WorkingDirectory, type AssistantCommandReceipt, type AssistantPublicEvent, type WorkbenchChangeOrigin } from '@multivac/contracts';
import type { TaskRunRepository } from '../modules/tasks/task.js';
import type { AssistantTurnCommandService } from './assistant-turn-command-service.js';
import type { AssistantEventStream } from './assistant-event-stream.js';
import { TaskService, TaskServiceError, fingerprint } from './task-service.js';
import { taskBudgetBalance, taskBudgetExhaustion, taskBudgetUsage } from './task-budget.js';

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
  /** 任务未记录预算时采用的默认值（执行时长跟随偏好）；缺省用固定默认值。 */
  defaultBudget?: () => TaskBudget;
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
  private wakeScheduler: (() => void) | undefined;
  private assertOwner: (() => void) | undefined;
  private readonly budgetStops = new Set<string>();
  private pendingRequest: ((taskId: string) => boolean) | undefined;

  constructor(private readonly options: TaskExecutionOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.unsubscribe = options.events.subscribe((event) => this.project(event));
  }
  attachScheduler(wake: () => void, assertOwner: () => void): void { this.wakeScheduler = wake; this.assertOwner = assertOwner; }
  setPendingRequest(check: (taskId: string) => boolean): void { this.pendingRequest = check; }
  async stopForHuman(taskId: string, expectedRunId?: string): Promise<void> {
    const task = this.options.tasks.get(taskId);
    if (!this.pendingRequest?.(taskId) || (expectedRunId && task.currentRunId !== expectedRunId)) return;
    const run = task.currentRunId ? this.options.runs.get(task.currentRunId) : null;
    if (!run || run.stopConfirmed || task.pauseSource === 'user') return;
    await this.control(taskId, { commandId: `human-stop:${run.runId}`, revision: task.revision, action: 'pause' }, UNKNOWN_CHANGE_ORIGIN, 'human');
  }
  root(task: Task): Task {
    let current = task;
    const seen = new Set<string>();
    while (current.parentTaskId) {
      if (seen.has(current.taskId)) throw new TaskServiceError('INVALID_REQUEST', '任务树存在循环。');
      seen.add(current.taskId); current = this.options.tasks.get(current.parentTaskId);
    }
    return current;
  }
  budget(rootId: string) {
    const task = this.options.tasks.get(rootId);
    return taskBudgetBalance(this.options.runs.tree(rootId), task.budget ?? this.options.defaultBudget?.() ?? DEFAULT_TASK_BUDGET, Date.parse(this.now()));
  }
  private budgetReason(run: TaskRun): string {
    return taskBudgetExhaustion(this.budget(run.rootTaskId ?? run.taskId), run.hasStarted === false);
  }
  startQueued(runId: string): void {
    this.assertOwner?.();
    const run = this.options.runs.get(runId);
    if (!run || run.hasStarted || run.stopIntent || run.stopConfirmed || run.ownerId !== this.ownerId) return;
    if (this.options.tasks.get(run.taskId).humanOnly) return;
    const budget = this.budget(run.rootTaskId ?? run.taskId);
    if (budget.remainingRuns < 1 || !(budget.remainingMillis > 0) || budget.remainingBytes < 1) return;
    this.updateRun(runId, 'preparing', (current, task) => { current.hasStarted = true; current.startedAt = this.now(); return { ...task, reason: '准备独立目录与执行模型。' }; });
    this.launch(runId);
  }
  nativeLease(sessionId: string, phase: 'starting' | 'settled', marker: string, bytes: number): number {
    if (this.disposed) { if (phase === 'settled') return 0; throw new Error('任务执行器已停止。'); }
    this.assertOwner?.();
    let remaining = 0;
    this.options.tasks.facts(() => {
      const run = this.options.runs.bySession(sessionId);
      if (!run || run.ownerId !== this.ownerId || run.stopConfirmed) throw new Error('任务执行租约已失效。');
      const task = this.options.tasks.get(run.taskId);
      const pending = run.nativePendingIds ?? [];
      if (phase === 'starting') {
        if (task.currentRunId !== run.runId || task.status !== 'running' || run.stopIntent) throw new Error('任务当前不能执行工具。');
        const budget = this.budget(run.rootTaskId ?? run.taskId);
        if (bytes > budget.remainingBytes || budget.remainingBytes < 1 || !(budget.remainingMillis > 0)) throw new Error('任务共享预算已耗尽。');
        run.nativePendingIds = [...pending, marker];
        remaining = budget.remainingBytes - bytes;
      } else run.nativePendingIds = pending.filter((id) => id !== marker);
      run.outputBytes = (run.outputBytes ?? 0) + bytes;
      this.options.runs.save(run);
    });
    return remaining;
  }
  async stopForBudget(runId: string): Promise<void> {
    if (this.budgetStops.has(runId)) return;
    this.budgetStops.add(runId);
    try {
      const run = this.options.runs.get(runId);
      if (!run || run.stopIntent || run.stopConfirmed) return;
      const task = this.options.tasks.get(run.taskId);
      await this.control(task.taskId, { commandId: `budget-stop:${runId}`, revision: task.revision, action: 'pause' }, UNKNOWN_CHANGE_ORIGIN, 'budget');
    } finally { this.budgetStops.delete(runId); }
  }

  async control(taskId: string, input: TaskControl, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN, pauseSource: 'user' | 'human' | 'budget' = 'user'): Promise<TaskReceipt> {
    this.assertOwner?.();
    if (!Check(TaskControlSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '任务控制参数无效。');
    let runToStart: string | null = null;
    let runToStop: string | null = null;
    const renewBudget = input.action === 'resume' && pauseSource === 'user';
    const summary = renewBudget ? '已补充执行额度，受理任务继续请求。'
      : input.action === 'pause' && pauseSource === 'budget' ? '执行额度已用完，正在暂停任务。'
      : `已受理任务${{ start: '启动', pause: '暂停', resume: '继续', cancel: '取消' }[input.action]}请求。`;
    const result = this.options.tasks.transition(taskId, { commandId: input.commandId, revision: input.revision, key: fingerprint({ taskId, ...input }), kind: input.action, summary }, (task) => {
      const previous = task.currentRunId ? this.options.runs.get(task.currentRunId) : null;
      if (previous?.stopIntent === 'cancel' && input.action !== 'cancel') throw new TaskServiceError('INVALID_REQUEST', '取消意图不能被暂停或继续覆盖。');
      if (['done', 'cancelled'].includes(task.status)) throw new TaskServiceError('INVALID_REQUEST', '任务已处于终态。');
      if (input.action === 'start' || input.action === 'resume') {
        if (task.humanOnly) throw new TaskServiceError('INVALID_REQUEST', '“我来处理”的任务不能由 Agent 执行。');
        if (this.pendingRequest?.(taskId)) throw new TaskServiceError('INVALID_REQUEST', '先处理原人工请求，不能通过启动绕过。');
        if (previous && !previous.stopConfirmed) throw new TaskServiceError('INVALID_REQUEST', '旧执行尚未确认停止，不能启动冲突执行。');
        if (previous && (previous.pendingToolIds.length || previous.nativePendingIds?.length)) throw new TaskServiceError('INVALID_REQUEST', '仍有未核对工具副作用，不能启动新执行。');
        if (!['idle', 'paused', 'failed', 'waiting'].includes(task.status)) throw new TaskServiceError('INVALID_REQUEST', '任务当前不能启动或继续。');
        if (!this.wakeScheduler && task.dependencyIds.some((id) => !satisfiesTaskDependency(this.options.tasks.get(id).status))) throw new TaskServiceError('INVALID_REQUEST', '前置任务尚未进入审核中或已完成。');
        const prompt = this.prompt(task);
        if (Buffer.byteLength(prompt, 'utf8') > 12 * 1024) throw new TaskServiceError('INVALID_REQUEST', '目标与范围超过单次执行上下文上限，请缩小任务。');
        const sameBoundary = previous?.directory && previous.goal === task.goal && previous.scope === task.scope && previous.projectId === task.projectId;
        const runId = randomUUID();
        const at = this.now();
        const rootTask = this.root(task);
        const run: TaskRun = {
          ...(renewBudget ? { budgetRenewal: {
            limit: this.options.defaultBudget?.() ?? DEFAULT_TASK_BUDGET,
            previousLimit: rootTask.budget ?? this.options.defaultBudget?.() ?? DEFAULT_TASK_BUDGET,
            used: taskBudgetUsage(this.options.runs.tree(rootTask.taskId), Date.parse(at)),
          } } : {}),
          rootTaskId: rootTask.taskId, ownerPid: process.pid, schedulerManaged: this.wakeScheduler !== undefined, hasStarted: false,
          outputBytes: 0, elapsedMs: 0, nativeLeaseFenced: true, nativePendingIds: [],
          runId, taskId, sessionId: sameBoundary && !previous.redoRequested ? previous.sessionId : randomUUID(), commandId: `task-run:${runId}`,
          status: 'preparing', stopIntent: null, stopConfirmed: false, ownerId: this.ownerId,
          directory: sameBoundary ? previous.directory : null, baseline: sameBoundary ? previous.baseline : null,
          goal: task.goal, scope: task.scope, projectId: task.projectId, pendingToolIds: [], toolFailures: 0,
          lastEventCursor: 0,
          piSessionId: null, piEntryId: null, reason: renewBudget ? '执行额度已补充，准备继续任务。' : '准备执行环境。', createdAt: at, updatedAt: at,
        };
        this.options.runs.save(run);
        runToStart = runId;
        return { ...task, status: 'queued', pauseSource: null, currentRunId: runId, sessionId: run.sessionId, reason: run.reason, nextStep: '依赖与预算满足后启动。' };
      }
      if (input.action === 'pause' && !['queued', 'running', 'waiting', 'recovery'].includes(task.status)) throw new TaskServiceError('INVALID_REQUEST', '任务当前不能暂停。');
      if (previous && !previous.stopConfirmed) {
        if (pauseSource === 'budget') previous.budgetStopReason = this.budgetReason(previous);
        if (previous.hasStarted === false && previous.ownerId === this.ownerId && !this.active.has(previous.runId)) {
          previous.stopIntent = input.action; previous.stopConfirmed = true;
          previous.status = input.action === 'cancel' ? 'cancelled' : 'paused';
          previous.reason = pauseSource === 'budget' ? `任务已暂停：${previous.budgetStopReason}。已有工作已保留，点击“继续任务”可补充额度并继续。` : '排队中的任务已停止，尚未开始执行。';
          previous.updatedAt = this.now(); this.options.runs.save(previous);
          return { ...task, status: previous.status, pauseSource: input.action === 'pause' ? pauseSource : null, reason: previous.reason, nextStep: input.action === 'pause' ? '点击“继续任务”补充执行额度并继续。' : '记录保留。' };
        }
        previous.stopIntent = input.action;
        previous.status = 'stopping';
        previous.updatedAt = this.now();
        previous.reason = input.action === 'cancel' ? '正在取消任务，等待执行停止。' : pauseSource === 'budget' ? `${previous.budgetStopReason}，正在暂停任务。` : '正在暂停任务，等待当前执行停止。';
        this.options.runs.save(previous);
        runToStop = previous.runId;
        return { ...task, pauseSource: input.action === 'pause' ? pauseSource : null, reason: pauseSource === 'human' ? task.reason : previous.reason, nextStep: '等待停止确认。' };
      }
      return { ...task, status: input.action === 'cancel' ? 'cancelled' : 'paused', pauseSource: input.action === 'pause' ? pauseSource : null, reason: input.action === 'cancel' ? '任务已取消，已有记录与文件已保留。' : '任务已暂停，已有工作已保留。点击“继续任务”可继续推进。', nextStep: input.action === 'cancel' ? '查看保留的记录。' : '点击“继续任务”补充执行额度并继续。' };
    }, origin);
    if (runToStart) { if (this.wakeScheduler) this.wakeScheduler(); else this.startQueued(runToStart); }
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
    return `任务：${task.title}\n目标：${task.goal}\n范围：${task.scope || '仅本任务独立目录'}\n验收要求：${task.acceptanceCriteria || '提交可核对的成果与证据'}\n用户回应：${task.feedback ?? '无'}\n` +
      '在任务独立目录完成工作，保留来源与验证证据。原生任务工具拒绝目录外访问、网络和创建子进程；不要绕过这些限制。Git 状态和差异使用 inspect_task_git；任务已要求提交代码时，用 commit_task_code 指定本次文件与提交信息创建本地提交，不用 bash 执行 git。本地提交不等于远端发布。运行结束不等于任务完成。需要澄清时调用 request_task_input；成果写为独立文件并调用 submit_task_result 登记相对路径与标题，说明实际完成、未完成和验证失败的部分。';
  }

  private launch(runId: string): void {
    if (this.disposed || this.active.has(runId)) return;
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => this.execute(runId, controller.signal)).catch(() => {
      // 无法提交结果时保留非终态租约；不以异常丢失事实为由重新执行。
    }).finally(() => this.active.delete(runId));
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
        return { ...task, status: 'queued', reason: '正在核对模型准入。', nextStep: '等待真实执行开始。' };
      });
      receipt = await this.options.runtime(run.sessionId).commands.send({ commandId: run.commandId, assistantSessionId: run.sessionId, text: this.prompt(task), contextRefs: [] }, { signal });
    } catch (error) { failure = signal.aborted ? undefined : error instanceof Error ? error.message : '任务执行失败。'; }
    if (this.disposed) return;
    this.updateRun(runId, 'settled', (run, task) => {
      // Pi 返回只是本轮结果；若工具没有结束事实，保留租约并等待恢复确认。
      run.stopConfirmed = (run.nativePendingIds ?? []).length === 0 && (run.pendingToolIds.length === 0 || this.options.confirmedStopped?.(run.sessionId) === true);
      run.elapsedMs = Math.max(0, Date.parse(this.now()) - Date.parse(run.startedAt ?? run.createdAt));
      if (run.stopConfirmed && run.pendingToolIds.length) {
        run.toolFailures += run.pendingToolIds.length;
        run.pendingToolIds = [];
      }
      run.piSessionId = receipt?.piSessionId ?? run.piSessionId;
      run.piEntryId = receipt?.piEntryId ?? null;
      const outcome = receipt?.terminalOutcome;
      if (!run.stopConfirmed) {
        run.status = 'recovery'; run.reason = '暂时无法确认所有工具都已停止，需要先核对执行结果。已有工作已保留。';
        return { ...task, status: 'recovery', reason: run.reason, nextStep: '核对旧执行停止与副作用结果。' };
      }
      if (run.stopIntent) {
        run.status = run.stopIntent === 'cancel' ? 'cancelled' : 'paused';
        run.reason = run.stopIntent === 'cancel' ? '任务已取消，执行已停止，已有工作已保留。' : task.pauseSource === 'budget'
          ? `任务已暂停：${run.budgetStopReason ?? this.budgetReason(run)}。执行已停止，已有工作已保留，点击“继续任务”可补充额度并继续。`
          : task.pauseSource === 'human' ? '执行已暂停，等待你处理任务中的请求。' : '任务已暂停，已有工作已保留。点击“继续任务”可继续推进。';
        if (run.stopIntent === 'pause' && task.pauseSource === 'human') return { ...task, status: 'waiting', nextStep: '等待用户处理原人工请求。' };
        return { ...task, status: run.status, reason: run.reason, nextStep: run.stopIntent === 'cancel' ? '查看已有记录和目录。' : '点击“继续任务”补充执行额度并继续。' };
      }
      run.status = failure || outcome !== 'succeeded' ? 'failed' : 'settled';
      run.reason = failure ?? receipt?.error?.message ?? (run.status === 'settled' ? '本轮执行已结束，尚未判定长期任务完成。' : '本轮执行未成功。');
      return { ...task, status: run.status === 'failed' ? 'failed' : 'waiting', reason: run.reason, nextStep: run.status === 'failed' ? '检查失败原因后继续。' : '提交成果与验证证据。' };
    });
  }

  private updateRun(runId: string, kind: string, change: (run: TaskRun, task: Task) => Task): void {
    this.assertOwner?.();
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
    if (this.options.runs.get(runId)?.stopConfirmed) return;
    this.updateRun(runId, 'stop-unknown', (run, task) => {
      run.stopConfirmed = false; run.status = 'recovery'; run.reason = `${run.budgetStopReason ? `${run.budgetStopReason}。` : ''}暂停请求已收到，但暂时无法确认执行已停止。请先核对上一轮执行结果，再继续任务。`;
      return { ...task, status: 'recovery', reason: run.reason, nextStep: '核对旧执行停止与副作用结果。' };
    });
  }

  private project(event: AssistantPublicEvent): void {
    const run = this.options.runs.active().find((candidate) => candidate.sessionId === event.assistantSessionId && candidate.commandId === event.commandId && candidate.ownerId === this.ownerId);
    if (!run) return;
    const cursor = Number(event.cursor);
    if (!Number.isSafeInteger(cursor) || cursor <= (run.lastEventCursor ?? 0)) return;
    if (event.type === 'assistant.command.handed_to_pi' && event.data.dispatchMode === 'prompt') {
      this.updateRun(run.runId, 'started', (current, task) => { current.lastEventCursor = cursor; return { ...task, status: 'running', reason: '已开始推进任务目标。', nextStep: '等待运行结果与成果提交。' }; });
    }
    if (event.type === 'assistant.message.delta') this.options.tasks.facts(() => {
      const current = this.options.runs.get(run.runId)!;
      if (cursor <= (current.lastEventCursor ?? 0)) return;
      current.lastEventCursor = cursor; current.outputBytes = (current.outputBytes ?? 0) + Buffer.byteLength(event.data.delta, 'utf8'); this.options.runs.save(current);
    });
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
