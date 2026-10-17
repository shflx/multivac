import { skillInvocation } from '@multivac/contracts';
import { satisfiesTaskDependency } from '@multivac/contracts';
import { randomUUID } from 'node:crypto';
import { DEFAULT_AGENT_ID, DEFAULT_TASK_BUDGET } from '@multivac/contracts';
import { Check } from 'typebox/value';
import { DEFAULT_WORKSPACE_ID, TaskControlSchema, UNKNOWN_CHANGE_ORIGIN, type Task, type TaskBudget, type TaskControl, type TaskReceipt, type TaskRun, type WorkingDirectory, type AssistantCommandReceipt, type AssistantPublicEvent, type WorkbenchChangeOrigin } from '@multivac/contracts';
import type { TaskRunRepository } from '../modules/tasks/task.js';
import type { HumanRequestRepository } from '../modules/tasks/human-request.js';
import type { AssistantTurnCommandService } from './assistant-turn-command-service.js';
import type { AssistantEventStream } from './assistant-event-stream.js';
import { TaskService, fingerprint } from './task-service.js';
import { TaskServiceError } from '../modules/tasks/task-error.js';
import { renderTaskExecutionPrompt, type TaskPromptContext } from './task-execution-prompt.js';
import { taskBudgetBalance, taskBudgetExhaustion, taskBudgetUsage } from './task-budget.js';
import { diagnosticError } from './execution-diagnostics.js';
import { assertCanStart, assertControllable, recordExecutionResult, requestStop, settleRun, type ExecutionOutcome, type TaskPauseSource } from '../modules/tasks/task-control.js';
import type { TaskFacts } from '../modules/tasks/task-facts.js';

/** 待结算的一轮执行：终结结果之外，记录日志与清理的进行状态，仅存于内存。 */
interface PendingFinalization extends ExecutionOutcome {
  logged?: boolean;
  persistenceLogged?: boolean;
  cleanup?: Promise<boolean> | undefined;
}

export interface TaskExecutionRuntime {
  commands: Pick<AssistantTurnCommandService, 'send' | 'cancel' | 'currentPromptCommandId'>;
}
export interface TaskExecutionOptions {
  tasks: TaskService;
  runs: TaskRunRepository;
  /** 用已保存的人工回应装配继续消息；不依赖发起继续请求的界面或内存标记。 */
  requests?: Pick<HumanRequestRepository, 'list'>;
  prepare: (task: Task, runId: string, signal: AbortSignal) => Promise<{ directory: WorkingDirectory; baseline: string | null }>;
  createSession: (input: { sessionId: string; title: string; workspaceId: string; workingDirectory: WorkingDirectory }) => Promise<unknown>;
  runtime: (sessionId: string) => TaskExecutionRuntime;
  events: AssistantEventStream;
  /** 任务未记录预算时采用的默认值（执行时长跟随偏好）；缺省用固定默认值。 */
  defaultBudget?: () => TaskBudget;
  now?: () => string;
  stopTimeoutMs?: number;
  /** 首响应或输出静默上限；工具和人工等待不计入，由事件刷新活动时间。 */
  requestIdleTimeoutMs?: number;
  stopRequiredProcesses?: (runId: string) => Promise<boolean>;
  requiredProcessesStopped?: (runId: string) => boolean;
  directoryOccupied?: (directory: string) => boolean;
  confirmedStopped?: (sessionId: string) => boolean;
  /** 启动或继续前核对执行智能体可用（存在且模型可用）；不可用时抛错，任务保持原状态。 */
  admitAgent?: (agentId: string) => Promise<void>;
  /**
   * 运行确认停止并结算后固定本轮成果候选；由成果服务提供，完成或失败都已记录到任务后才返回。
   * 结算是必需的业务步骤，不经界面通知触发。
   */
  settleArtifacts: (taskId: string) => Promise<void>;
}

/** 控制命令写入任务事件的摘要。 */
function controlSummary(action: TaskControl['action'], pauseSource: TaskPauseSource, renewBudget: boolean): string {
  if (renewBudget) return '已补充执行额度，受理任务继续请求。';
  if (action === 'pause' && pauseSource === 'budget') return '执行额度已用完，正在暂停任务。';
  return `已受理任务${{ start: '启动', pause: '暂停', resume: '继续', cancel: '取消' }[action]}请求。`;
}

/** Task 的执行意图与 Pi 命令分开持久化；一次执行结束不会写成长期任务完成。 */
export class TaskExecutionService {
  readonly ownerId = randomUUID();
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly unsubscribe: () => void;
  private disposed = false;
  private closing = false;
  private readonly now: () => string;
  private wakeScheduler: (() => void) | undefined;
  private assertOwner: (() => void) | undefined;
  private readonly budgetStops = new Set<string>();
  private readonly finalizations = new Map<string, PendingFinalization>();
  private readonly finalizing = new Set<string>();
  private readonly reconciliationTimer: ReturnType<typeof setInterval>;

  constructor(private readonly options: TaskExecutionOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.unsubscribe = options.events.subscribe((event) => this.project(event));
    this.reconciliationTimer = setInterval(() => { void this.reconcileFinalizations(); }, 1000);
    this.reconciliationTimer.unref();
  }
  attachScheduler(wake: () => void, assertOwner: () => void): void { this.wakeScheduler = wake; this.assertOwner = assertOwner; }
  async stopForHuman(taskId: string, expectedRunId?: string): Promise<void> {
    const task = this.options.tasks.get(taskId);
    if (!this.options.tasks.pendingRequest(taskId) || (expectedRunId && task.currentRunId !== expectedRunId)) return;
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
    if (this.closing) return;
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
    if (this.closing && phase === 'starting') throw new Error('任务执行器正在关闭，不能启动新工具。');
    this.assertOwner?.();
    let remaining = 0;
    this.options.tasks.facts((facts) => {
      const run = facts.runs.bySession(sessionId);
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
      run.lastActivityAt = this.now();
      run.outputBytes = (run.outputBytes ?? 0) + bytes;
      facts.runs.save(run);
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

  private releaseCancelledChildren(taskId: string): void {
    const task = this.options.tasks.get(taskId);
    const run = task.currentRunId ? this.options.runs.get(task.currentRunId) : null;
    if (task.status !== 'cancelled' || !run?.stopConfirmed || run.taskId !== taskId) return;
    for (const child of run.treeTasks ?? []) {
      const current = this.options.tasks.get(child.taskId);
      if (current.executionTaskId !== taskId || current.currentRunId !== run.runId || satisfiesTaskDependency(current.status) || current.status === 'cancelled') continue;
      this.options.tasks.transition(child.taskId, { commandId: `tree-release:${run.runId}:${child.taskId}`, key: run.runId, kind: 'tree-release', summary: '父任务已取消并确认停止，子任务成果和记录保留。' }, value => {
        const { executionTaskId: _owner, executionProgress: _progress, ...rest } = value;
        return { ...rest, status: 'paused', pauseSource: 'user', reason: '父任务执行已结束，子任务尚未交付。', nextStep: '核对已有成果后决定是否独立继续。' };
      });
    }
  }

  private treeScope(task: Task, previous: TaskRun | null): Task[] {
    const children = previous?.treeTasks ?? this.options.tasks.descendants(task.taskId);
    const all = [task, ...children];
    const byId = new Map(all.map(item => [item.taskId, item]));
    for (const snapshot of children) {
      const child = this.options.tasks.get(snapshot.taskId);
      if (child.projectId !== task.projectId) throw new TaskServiceError('INVALID_REQUEST', '子任务项目与父任务执行环境不一致。');
      if (previous?.treeTasks && ['goal', 'scope', 'parentTaskId', 'dependencyIds', 'humanOnly', 'acceptance', 'acceptanceCriteria'].some(key =>
        fingerprint(child[key as keyof Task]) !== fingerprint(snapshot[key as keyof Task]))) throw new TaskServiceError('TASK_CONFLICT', `子任务「${child.title}」边界已变化。`);
      const owner = this.options.tasks.executionOwner(child.taskId);
      const run = child.currentRunId ? this.options.runs.get(child.currentRunId) : null;
      if (owner && owner.taskId !== task.taskId || run && run.taskId !== task.taskId && (!run.stopConfirmed || run.pendingToolIds.length || run.nativePendingIds?.length)) throw new TaskServiceError('TASK_CONFLICT', `子任务「${child.title}」已有其他执行。`);
      if (child.status === 'cancelled' || (!previous?.treeTasks && ['failed', 'paused', 'recovery', 'running', 'queued', 'waiting'].includes(child.status))) throw new TaskServiceError('INVALID_REQUEST', `请先处理子任务「${child.title}」的 ${child.status} 状态。`);
      if (this.options.tasks.pendingRequest(child.taskId) && child.status !== 'review') throw new TaskServiceError('INVALID_REQUEST', `子任务「${child.title}」有未解决请求。`);
    }
    const visiting = new Set<string>(); const visited = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new TaskServiceError('INVALID_REQUEST', '子任务依赖与父任务整合顺序存在循环。');
      if (visited.has(id)) return;
      visiting.add(id);
      const item = byId.get(id);
      if (item) {
        const dependencies = new Set(item.dependencyIds);
        let ancestor = item.parentTaskId ? byId.get(item.parentTaskId) : undefined;
        while (ancestor) { ancestor.dependencyIds.forEach(dep => dependencies.add(dep)); ancestor = ancestor.parentTaskId ? byId.get(ancestor.parentTaskId) : undefined; }
        for (const dep of dependencies) if (byId.has(dep)) visit(dep);
        for (const child of children) if (child.parentTaskId === id) visit(child.taskId);
      }
      visiting.delete(id); visited.add(id);
    };
    all.forEach(item => visit(item.taskId));
    return children;
  }

  async control(taskId: string, input: TaskControl, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN, pauseSource: TaskPauseSource = 'user'): Promise<TaskReceipt> {
    if (this.closing) throw new TaskServiceError('TASK_CONFLICT', '任务执行器正在关闭。');
    this.assertOwner?.();
    if (!Check(TaskControlSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '任务控制参数无效。');
    const starting = input.action === 'start' || input.action === 'resume';
    if (starting && this.options.admitAgent && !this.options.tasks.commandRecorded(input.commandId)) {
      await this.options.admitAgent(this.options.tasks.get(taskId).agentId ?? DEFAULT_AGENT_ID);
    }

    // 用户主动继续时补充执行额度；预算、人工或环境触发的继续不补充。
    const renewBudget = input.action === 'resume' && pauseSource === 'user';
    let launch = null as { runId: string; children: Task[] } | null;
    let stopRunId = null as string | null;
    const command = { commandId: input.commandId, revision: input.revision, key: fingerprint({ taskId, ...input }), kind: input.action, summary: controlSummary(input.action, pauseSource, renewBudget) };
    const result = this.options.tasks.transition(taskId, command, (task, facts) => {
      const treeOwner = this.options.tasks.executionOwner(taskId);
      if (treeOwner) throw new TaskServiceError('TASK_CONFLICT', `由父任务「${treeOwner.title}」统一执行，请控制父任务。`);
      const previous = task.currentRunId ? facts.runs.get(task.currentRunId) : null;
      assertControllable(task, previous, input.action);

      if (input.action === 'start' || input.action === 'resume') {
        assertCanStart(task, previous, {
          action: input.action,
          pendingRequest: this.options.tasks.pendingRequest(taskId),
          schedulerManaged: this.wakeScheduler !== undefined,
          dependenciesSatisfied: () => task.dependencyIds.every((id) => satisfiesTaskDependency(this.options.tasks.get(id).status)),
        });
        const planned = this.planRun(task, previous, renewBudget, facts);
        launch = { runId: planned.run.runId, children: planned.children };
        return planned.task;
      }

      const live = previous && !previous.stopConfirmed ? previous : null;
      const decision = requestStop({
        task, run: previous, action: input.action, pauseSource, now: this.now(),
        unstartedHere: live?.ownerId === this.ownerId && !this.active.has(live.runId),
        ownedHere: live?.ownerId === this.ownerId,
        ...(live && pauseSource === 'budget' ? { budgetReason: this.budgetReason(live) } : {}),
      });
      if (decision.run) facts.runs.save(decision.run);
      if (decision.awaitStop) stopRunId = decision.run!.runId;
      return decision.task;
    }, origin);

    // 以下均在事务提交之后：发布子任务绑定、释放取消后的子任务、启动或等待停止。
    this.options.tasks.publishExecutionChildren(launch?.children ?? [], origin);
    this.releaseCancelledChildren(taskId);
    if (launch) {
      if (this.wakeScheduler) this.wakeScheduler();
      else this.startQueued(launch.runId);
    }
    if (stopRunId) await this.awaitStop(stopRunId);
    return result;
  }

  /** 为启动或继续创建新的运行记录并绑定子任务；在任务事实事务内执行，不启动任何外部操作。 */
  private planRun(task: Task, previous: TaskRun | null, renewBudget: boolean, facts: TaskFacts): { task: Task; run: TaskRun; children: Task[] } {
    const treeTasks = this.treeScope(task, previous?.taskId === task.taskId ? previous : null);
    // 目标、范围与项目都未变时沿用原目录；用户要求安全重做时换新会话。
    const sameBoundary = previous?.taskId === task.taskId && previous?.directory && previous.goal === task.goal && previous.scope === task.scope && previous.projectId === task.projectId;
    const sessionId = sameBoundary && !previous.redoRequested ? previous.sessionId : randomUUID();
    const prompt = this.prompt(task, { childCount: treeTasks.length, resumed: previous !== null }, previous, sessionId);
    if (Buffer.byteLength(prompt, 'utf8') > 12 * 1024) throw new TaskServiceError('INVALID_REQUEST', '目标与范围超过单次执行上下文上限，请缩小任务。');
    if (sameBoundary && this.options.directoryOccupied?.(previous!.directory!.path)) throw new TaskServiceError('TASK_CONFLICT', '目录仍被托管进程占用，请先停止并核对。');

    const runId = randomUUID();
    const at = this.now();
    const rootTask = this.root(task);
    const defaultBudget = this.options.defaultBudget?.() ?? DEFAULT_TASK_BUDGET;
    const run: TaskRun = {
      ...(renewBudget ? { budgetRenewal: {
        limit: defaultBudget,
        previousLimit: rootTask.budget ?? defaultBudget,
        used: taskBudgetUsage(this.options.runs.tree(rootTask.taskId), Date.parse(at)),
      } } : {}),
      treeTasks,
      // 沿用原目录时，只带上尚未交付且未被退回的子任务候选。
      childResults: sameBoundary ? (previous.childResults ?? [])
        .filter(result => !satisfiesTaskDependency(this.options.tasks.get(result.taskId).status) && this.options.tasks.get(result.taskId).status !== 'paused')
        .map(result => ({ ...result, commandId: `tree-result:${runId}:${result.taskId}` })) : [],
      rootTaskId: rootTask.taskId, ownerPid: process.pid, schedulerManaged: this.wakeScheduler !== undefined, hasStarted: false,
      outputBytes: 0, elapsedMs: 0, nativeLeaseFenced: true, nativePendingIds: [],
      agentId: task.agentId ?? DEFAULT_AGENT_ID,
      runId, taskId: task.taskId, sessionId, commandId: `task-run:${runId}`,
      status: 'preparing', stopIntent: null, stopConfirmed: false, ownerId: this.ownerId,
      directory: sameBoundary ? previous.directory : null, baseline: sameBoundary ? previous.baseline : null,
      goal: task.goal, scope: task.scope, projectId: task.projectId, pendingToolIds: [], toolFailures: 0,
      lastEventCursor: 0,
      piSessionId: null, piEntryId: null, reason: renewBudget ? '执行额度已补充，准备继续任务。' : '准备执行环境。', createdAt: at, updatedAt: at,
    };
    facts.runs.save(run);
    const children = this.options.tasks.bindExecutionChildren(run);
    const { executionTaskId: _owner, executionProgress: _progress, ...rest } = task;
    return { run, children, task: { ...rest, status: 'queued', pauseSource: null, currentRunId: runId, sessionId: run.sessionId, reason: run.reason, nextStep: '依赖与预算满足后启动。' } };
  }

  /**
   * 停止意图已保存后，中止本轮执行并等待其终结。
   * abort 回执不是停止证明：超时或无法确认时进入恢复核对，保留租约，不启动冲突执行。
   */
  private async awaitStop(runId: string): Promise<void> {
    this.active.get(runId)?.controller.abort();
    const run = this.options.runs.get(runId)!;
    const stopping = (async () => {
      try {
        const runtime = this.options.runtime(run.sessionId);
        // 即使取消本身悬挂，也独立等待原执行终结。
        if (runtime.commands.currentPromptCommandId()) void runtime.commands.cancel({ commandId: `task-stop:${run.runId}`, assistantSessionId: run.sessionId }).catch(() => undefined);
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
    if (!stopped) this.unknownStop(runId);
  }

  private prompt(task: Task, context: TaskPromptContext, previous: TaskRun | null, sessionId: string): string {
    // 只有已确认停止、保留 Pi 上下文的原会话才发送增量；旧记录缺少证据时保守装配完整说明。
    const inboxResponses = previous?.sessionId === sessionId && previous.stopConfirmed && previous.piSessionId && previous.piEntryId
      ? this.options.requests?.list(task.taskId).filter(request =>
        request.runId === previous.runId && request.sessionId === sessionId && request.status === 'answered' &&
        request.kind !== 'authorization' && request.decision !== null &&
        ['answer', 'use_scope', 'deny', 'continue', 'changes'].includes(request.decision))
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.requestId.localeCompare(right.requestId)) ?? []
      : [];
    return (task.skill ? skillInvocation(task.skill) : '') + renderTaskExecutionPrompt(task, { ...context, inboxResponses });
  }

  private launch(runId: string): void {
    if (this.disposed || this.closing || this.active.has(runId)) return;
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => this.execute(runId, controller.signal)).catch(error => {
      // 记录收尾故障，保留待核对结果；后续只重试结算，不重发模型或工具。
      this.finalizationFailed(runId, error);
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
        current.status = 'running'; current.requestStartedAt = this.now(); current.reason = '已进入真实执行会话。';
        return { ...task, status: 'queued', reason: '正在核对模型准入。', nextStep: '等待真实执行开始。' };
      });
      const previous = this.options.runs.list(task.taskId).find(previous => previous.runId !== run.runId) ?? null;
      const text = this.prompt(task, {
        childCount: run.treeTasks?.length ?? 0,
        resumed: previous !== null,
      }, previous, run.sessionId);
      const timeoutMs = this.options.requestIdleTimeoutMs ?? REQUEST_IDLE_TIMEOUT_MS;
      const watchdog = setInterval(() => {
        try { this.checkRequestTimeout(runId, timeoutMs); }
        catch (error) { console.error('任务请求超时核对失败，原执行租约保留。', { runId, ...diagnosticError(error) }); }
      }, Math.min(1000, Math.max(1, timeoutMs)));
      const clearWatchdog = () => clearInterval(watchdog);
      signal.addEventListener('abort', clearWatchdog, { once: true });
      try {
        receipt = await this.options.runtime(run.sessionId).commands.send({ commandId: run.commandId, assistantSessionId: run.sessionId, text, contextRefs: [] }, { signal });
      } finally { clearWatchdog(); signal.removeEventListener('abort', clearWatchdog); }
    } catch (error) {
      failure = signal.aborted && error instanceof Error && error.name === 'AbortError' ? undefined : error instanceof Error ? error.message : '任务执行失败。';
    }
    if (this.disposed || this.closing) return;
    this.finalizations.set(runId, { receipt, failure, endedAt: this.now() });
    await this.finalize(runId);
  }

  /** 已结束执行只做资源核对与结算；这个入口不会再次调用 send。 */
  async reconcileFinalizations(): Promise<void> {
    if (this.disposed || this.closing) return;
    await Promise.all([...this.finalizations.keys()].map(async runId => {
      try { await this.finalize(runId); }
      catch (error) { this.finalizationFailed(runId, error); }
    }));
  }

  private async finalize(runId: string): Promise<void> {
    if (this.finalizing.has(runId) || this.disposed || this.closing) return;
    const pending = this.finalizations.get(runId);
    if (!pending) return;
    this.finalizing.add(runId);
    try {
      const before = this.options.runs.get(runId);
      if (!before || before.ownerId !== this.ownerId || this.options.tasks.get(before.taskId).currentRunId !== runId) {
        this.finalizations.delete(runId); return;
      }
      // 先保存执行终结事实，再停止资源；停止失败不再遗留 running。
      if (!before.executionEndedAt) {
        try {
          this.updateRun(runId, 'execution-ended', (run, task) => {
            recordExecutionResult(run, pending);
            run.status = 'stopping';
            return { ...task, status: 'waiting', reason: '本轮执行已结束，正在核对依赖资源停止。', nextStep: '等待资源停止核对。' };
          });
        } catch (error) {
          // 落盘故障不阻止清理实际资源；停止凭据仍须成功保存后才能放行恢复。
          this.finalizationFailed(runId, error);
        }
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      // 同一停止调用在途时复用它，超时也不重复发送停止。
      pending.cleanup ??= Promise.resolve().then(() => {
        if (pending.recovery && this.options.requiredProcessesStopped?.(runId) === true) return true;
        return this.options.stopRequiredProcesses?.(runId) ?? true;
      }).catch(error => {
        pending.cleanupError = (error instanceof Error ? error.message : '依赖资源停止失败。').slice(0, 4000);
        this.logFinalizationFailure(runId, pending, error);
        return false;
      });
      const cleanup = pending.cleanup;
      let processesStopped: boolean;
      try {
        const result = await Promise.race([
          cleanup.then(stopped => ({ stopped })),
          new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), this.options.stopTimeoutMs ?? 60000); }),
        ]);
        processesStopped = result?.stopped === true;
        if (result !== null) pending.cleanup = undefined;
      } finally { if (timer) clearTimeout(timer); }
      if (this.disposed || this.closing) return;
      if (!processesStopped) pending.recovery = true;
      this.updateRun(runId, 'settled', (run, task) => settleRun(run, task, {
        outcome: pending, processesStopped, now: this.now(),
        toolsStopped: () => this.options.confirmedStopped?.(run.sessionId) === true,
        budgetReason: () => this.budgetReason(run),
      }));
      const settled = this.options.runs.get(runId);
      if (settled?.stopConfirmed) {
        this.finalizations.delete(runId);
        if (settled.status === 'settled') await this.options.settleArtifacts(settled.taskId);
      }
    } finally { this.finalizing.delete(runId); }
  }

  private logFinalizationFailure(runId: string, pending: PendingFinalization, error: unknown): void {
    if (pending.logged) return;
    pending.logged = true;
    console.error('任务收尾失败，保留原执行核对记录。', { runId, ...diagnosticError(error) });
  }

  private finalizationFailed(runId: string, error: unknown): void {
    if (this.disposed || this.closing) return;
    const pending: PendingFinalization = this.finalizations.get(runId) ?? { endedAt: this.now() };
    this.finalizations.set(runId, pending);
    pending.recovery = true;
    pending.finalizationError = (error instanceof Error ? error.message : '任务收尾状态写入失败。').slice(0, 4000);
    this.logFinalizationFailure(runId, pending, error);
    try {
      this.updateRun(runId, 'finalization-failed', (run, task) => {
        recordExecutionResult(run, pending);
        run.status = 'recovery';
        run.reason = '执行已结束，但收尾记录未能完整保存，保留租约并等待核对。';
        return { ...task, status: 'recovery', reason: run.reason, nextStep: '恢复存储后重新核对停止与检查点，不能直接重发执行。' };
      });
    } catch (persistenceError) {
      // 存储持续不可写时不能伪造落盘成功；内存保留结算结果，原持久租约仍阻止新执行。
      if (!pending.persistenceLogged) console.error('任务收尾故障暂无法持久化，将继续核对。', { runId, ...diagnosticError(persistenceError) });
      pending.persistenceLogged = true;
    }
  }

  private updateRun(runId: string, kind: string, change: (run: TaskRun, task: Task) => Task): void {
    this.assertOwner?.();
    const run = this.options.runs.get(runId);
    if (!run || run.ownerId !== this.ownerId || this.disposed || this.closing) return;
    this.options.tasks.transition(run.taskId, { commandId: `run-event:${randomUUID()}`, key: fingerprint({ runId, kind }), kind, summary: `运行记录：${kind}。` }, (task, facts) => {
      if (task.currentRunId !== runId) return task;
      const current = facts.runs.get(runId)!;
      const next = change(current, task);
      current.updatedAt = this.now();
      facts.runs.save(current);
      return next;
    });
    const settled = this.options.runs.get(runId);
    if (settled?.stopConfirmed) {
      for (const child of settled.treeTasks ?? []) {
        const current = this.options.tasks.get(child.taskId);
        if (current.currentRunId !== runId || current.status !== 'waiting' || current.executionProgress !== 'processing') continue;
        this.options.tasks.transition(child.taskId, { commandId: `tree-progress-stop:${runId}:${child.taskId}`, key: runId, kind: 'tree-progress', summary: '父运行已停止，此子任务尚未登记成果，等待继续。' }, value => ({ ...value, executionProgress: 'paused', nextStep: '继续父任务完成该子项。' }));
      }
    }
    this.releaseCancelledChildren(run.taskId);
  }

  private checkRequestTimeout(runId: string, timeoutMs: number): void {
    if (this.closing || this.disposed) return;
    const run = this.options.runs.get(runId);
    if (!run || this.options.tasks.pendingRequest(run.taskId)) return;
    const timeout = requestIdleTimeout(run, Date.parse(this.now()), timeoutMs);
    if (!timeout) return;
    this.updateRun(runId, 'request-timeout', (current, task) => {
      current.requestTimeout = timeout;
      return task;
    });
    const task = this.options.tasks.get(run.taskId);
    // 保留原执行 Promise 与租约；迟到终结仍走原收尾，绝不重发请求。
    void this.control(task.taskId, { commandId: `request-timeout:${runId}`, revision: task.revision, action: 'pause' }, UNKNOWN_CHANGE_ORIGIN, 'environment')
      .catch(error => {
        console.error('任务超时停止请求未能完整结算，原租约保留。', { runId, ...diagnosticError(error) });
        try { this.unknownStop(runId); }
        catch (persistenceError) { console.error('任务停止核对暂无法持久化。', { runId, ...diagnosticError(persistenceError) }); }
      });
  }

  private unknownStop(runId: string): void {
    if (this.options.runs.get(runId)?.stopConfirmed) return;
    this.updateRun(runId, 'stop-unknown', (run, task) => {
      run.stopConfirmed = false; run.status = 'recovery'; run.reason = `${run.requestTimeout ? '模型请求静默超时。' : ''}${run.budgetStopReason ? `${run.budgetStopReason}。` : ''}停止请求已收到，但暂时无法确认执行已停止。请先核对上一轮执行结果，再继续任务。`;
      return { ...task, status: 'recovery', reason: run.reason, nextStep: '核对旧执行停止与副作用结果。' };
    });
  }

  private project(event: AssistantPublicEvent): void {
    if (this.closing) return;
    const run = this.options.runs.active().find((candidate) => candidate.sessionId === event.assistantSessionId && candidate.commandId === event.commandId && candidate.ownerId === this.ownerId);
    if (!run) return;
    const cursor = Number(event.cursor);
    if (!Number.isSafeInteger(cursor) || cursor <= (run.lastEventCursor ?? 0)) return;
    const turnActivity = event.type === 'assistant.turn.started' || event.type === 'assistant.turn.ended';
    const pulseActivity = ['assistant.thinking.delta', 'assistant.tool.updated', 'assistant.retry.started', 'assistant.retry.ended', 'assistant.compaction.started', 'assistant.compaction.ended'].includes(event.type);
    if ((run.noProgressSince || turnActivity) && (pulseActivity || ['assistant.message.delta', 'assistant.tool.started', 'assistant.tool.ended', 'assistant.turn.started', 'assistant.turn.ended'].includes(event.type))) {
      this.updateRun(run.runId, 'progress-resumed', (current, task) => {
        current.noProgressSince = null; current.lastActivityAt = this.now();
        if (turnActivity || pulseActivity) current.lastEventCursor = cursor;
        return task.status === 'running' && !current.stopIntent ? { ...task, reason: '已观测到新的执行活动。' } : task;
      });
    }
    if (event.type === 'assistant.command.handed_to_pi' && event.data.dispatchMode === 'prompt') {
      this.updateRun(run.runId, 'started', (current, task) => { current.lastEventCursor = cursor; if (current.stopIntent || current.executionEndedAt || task.pauseSource === 'user') return task; return { ...task, status: 'running', reason: '已开始推进任务目标。', nextStep: '等待运行结果与成果提交。' }; });
    }
    // 仅记录活动时间；推理正文、重试内容和工具参数不复制到任务记录。
    if (pulseActivity) this.options.tasks.facts((facts) => {
      const current = facts.runs.get(run.runId)!;
      if (cursor <= (current.lastEventCursor ?? 0)) return;
      current.lastActivityAt = this.now();
      current.lastEventCursor = cursor;
      facts.runs.save(current);
    });
    if (event.type === 'assistant.message.delta') this.options.tasks.facts((facts) => {
      const current = facts.runs.get(run.runId)!;
      if (cursor <= (current.lastEventCursor ?? 0)) return;
      current.lastActivityAt = this.now();
      current.lastEventCursor = cursor;
      current.outputBytes = (current.outputBytes ?? 0) + Buffer.byteLength(event.data.delta, 'utf8');
      facts.runs.save(current);
    });
    if (event.type === 'assistant.tool.started' || event.type === 'assistant.tool.ended') {
      this.updateRun(run.runId, event.type, (current, task) => {
        if (cursor <= (current.lastEventCursor ?? 0)) return task;
        current.lastEventCursor = cursor;
        // 只记录受控工具名与活动时间，不复制参数、输出或模型正文。
        current.lastTool = /^[A-Za-z0-9_.:-]{1,100}$/.test(event.data.toolName) ? event.data.toolName : '工具';
        current.lastToolAt = this.now(); current.lastActivityAt = current.lastToolAt;
        if (event.type === 'assistant.tool.started') current.pendingToolIds = [...new Set([...current.pendingToolIds, event.data.toolCallId])];
        else {
          current.pendingToolIds = current.pendingToolIds.filter((id) => id !== event.data.toolCallId);
          if (event.data.isError) current.toolFailures += 1;
        }
        if (current.stopIntent || current.executionEndedAt || task.pauseSource === 'user') return task;
        return { ...task, reason: current.pendingToolIds.length ? `正在执行工具，${current.pendingToolIds.length} 项待结束。` : '正在推进任务目标。' };
      });
    }
  }

  async idle(): Promise<void> { await Promise.all([...this.active.values()].map((entry) => entry.promise)); }
  requiredProcessesStopped(runId: string): boolean { return this.options.requiredProcessesStopped?.(runId) ?? true; }
  observeProgress(now = Date.now()): void {
    for (const run of this.options.runs.active()) {
      if (run.ownerId !== this.ownerId) continue;
      const since = noProgressSince(this.options.tasks.get(run.taskId), run, now);
      if ((run.noProgressSince ?? null) === since) continue;
      this.updateRun(run.runId, 'progress-observation', (current, task) => {
        current.noProgressSince = since;
        return since ? { ...task, reason: '五分钟未观测到执行活动，疑似无进展；尚未确认卡住或停止。', nextStep: '进入现场核对，必要时由用户暂停。' } : task;
      });
    }
  }
  /** 关闭期间拒绝新副作用，允许已启动的原生工具记账并移除待退出标记。 */
  beginClose(): void {
    if (this.closing) return;
    this.closing = true; this.unsubscribe(); clearInterval(this.reconciliationTimer);
    for (const entry of this.active.values()) entry.controller.abort();
  }
  dispose(): void { this.beginClose(); this.disposed = true; }
}
import { noProgressSince, requestIdleTimeout, REQUEST_IDLE_TIMEOUT_MS } from './run-observation.js';
