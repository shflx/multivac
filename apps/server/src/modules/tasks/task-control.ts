import type { AssistantCommandReceipt, Task, TaskControl, TaskRun } from '@multivac/contracts';
import { TaskServiceError } from './task-error.js';

/**
 * 任务与运行的具名状态转换。
 * 这里只计算下一状态与拒绝原因，不读写存储、不调用执行器；调用方在任务事实事务内保存结果，
 * 停止等待、进程清理与通知在事务外按返回的意图处理。
 */

export type TaskPauseSource = NonNullable<Task['pauseSource']>;
type StopAction = 'pause' | 'cancel';

const STARTABLE: readonly Task['status'][] = ['idle', 'paused', 'failed', 'waiting', 'recovery'];
const PAUSABLE: readonly Task['status'][] = ['queued', 'running', 'waiting', 'recovery'];

function invalid(message: string): never { throw new TaskServiceError('INVALID_REQUEST', message); }

/** 任何控制动作的共同前提：取消意图不可被覆盖，终态任务不再受理控制。 */
export function assertControllable(task: Task, run: TaskRun | null, action: TaskControl['action']): void {
  if (run?.stopIntent === 'cancel' && action !== 'cancel') invalid('取消意图不能被暂停或继续覆盖。');
  if (task.status === 'done' || task.status === 'cancelled') invalid('任务已处于终态。');
}

export interface StartAdmission {
  action: 'start' | 'resume';
  /** 待处理人工请求或未终结外发操作。 */
  pendingRequest: boolean;
  /** 由调度器统一核对依赖时为 true；直接启动时须在此核对。 */
  schedulerManaged: boolean;
  dependenciesSatisfied: () => boolean;
}

/** 启动或继续的准入：旧执行必须已证明停止且工具副作用已核对，人工门禁未解除时拒绝。 */
export function assertCanStart(task: Task, previous: TaskRun | null, admission: StartAdmission): void {
  if (task.humanOnly) invalid('“我来处理”的任务不能由 Agent 执行。');
  if (admission.pendingRequest) invalid('先处理原人工请求，不能通过启动绕过。');
  if (previous && !previous.stopConfirmed) invalid('旧执行尚未确认停止，不能启动冲突执行。');
  if (previous && (previous.pendingToolIds.length || previous.nativePendingIds?.length)) invalid('仍有未核对工具副作用，不能启动新执行。');
  if (task.status === 'recovery' && (!previous || admission.action !== 'resume')) invalid('恢复任务须核对原执行记录后使用继续操作。');
  if (!STARTABLE.includes(task.status)) invalid('任务当前不能启动或继续。');
  if (!admission.schedulerManaged && !admission.dependenciesSatisfied()) invalid('前置任务尚未进入审核中或已完成。');
}

export interface StopRequest {
  task: Task;
  /** 任务当前运行；没有或已证明停止时直接改变任务状态。 */
  run: TaskRun | null;
  action: StopAction;
  pauseSource: TaskPauseSource;
  /** 运行属于本执行器、尚未启动且没有在途执行，可直接确认停止。 */
  unstartedHere: boolean;
  /** 运行属于本执行器；旧服务遗留的运行进入恢复核对。 */
  ownedHere: boolean;
  /** 预算暂停时的耗尽原因。 */
  budgetReason?: string;
  now: string;
}

export interface StopDecision {
  task: Task;
  /** 需要保存的运行；null 表示没有运行需要更新。 */
  run: TaskRun | null;
  /** 停止意图已保存，调用方须在事务外中止执行并等待停止证明。 */
  awaitStop: boolean;
}

/**
 * 暂停或取消请求：先保存停止意图，再由调用方停止执行。
 * 只有尚未开始的排队运行能直接确认停止；其余运行等待执行终结后的停止证明（见 settleRun）。
 */
export function requestStop(request: StopRequest): StopDecision {
  const { task, run, action, pauseSource } = request;
  if (action === 'pause' && !PAUSABLE.includes(task.status)) invalid('任务当前不能暂停。');
  const nextPauseSource = action === 'pause' ? pauseSource : null;

  if (!run || run.stopConfirmed) {
    return {
      task: {
        ...task, status: action === 'cancel' ? 'cancelled' : 'paused', pauseSource: nextPauseSource,
        reason: action === 'cancel' ? '任务已取消，已有记录与文件已保留。' : '任务已暂停，已有工作已保留。点击“继续任务”可继续推进。',
        nextStep: action === 'cancel' ? '查看保留的记录。' : '点击“继续任务”补充执行额度并继续。',
      },
      run: null, awaitStop: false,
    };
  }

  const next: TaskRun = { ...run, stopIntent: action, updatedAt: request.now };
  if (pauseSource === 'budget' && request.budgetReason !== undefined) next.budgetStopReason = request.budgetReason;

  if (run.hasStarted === false && request.unstartedHere) {
    next.stopConfirmed = true;
    next.status = action === 'cancel' ? 'cancelled' : 'paused';
    next.reason = pauseSource === 'budget'
      ? `任务已暂停：${next.budgetStopReason}。已有工作已保留，点击“继续任务”可补充额度并继续。`
      : '排队中的任务已停止，尚未开始执行。';
    return {
      task: { ...task, status: next.status, pauseSource: nextPauseSource, reason: next.reason, nextStep: action === 'pause' ? '点击“继续任务”补充执行额度并继续。' : '记录保留。' },
      run: next, awaitStop: false,
    };
  }

  // 旧服务的运行不再接收本执行器的结算事件，保留 recovery 以便退出凭据继续对账。
  next.status = request.ownedHere ? 'stopping' : 'recovery';
  next.reason = action === 'cancel' ? '正在取消任务，等待执行停止。'
    : pauseSource === 'budget' ? `${next.budgetStopReason}，正在暂停任务。`
    : '正在暂停任务，等待当前执行停止。';
  return {
    task: { ...task, pauseSource: nextPauseSource, reason: pauseSource === 'human' ? task.reason : next.reason, nextStep: '等待停止确认。' },
    run: next, awaitStop: true,
  };
}

/**
 * 父任务取消并证明停止后，释放仍由父运行处理、尚未交付的子任务：去掉执行归属，转为用户暂停，成果与记录保留。
 * 不属于该父运行、已交付或已取消的子任务返回 null，不做改动。
 */
export function releaseFromCancelledParent(child: Task, parent: { taskId: string; runId: string }, delivered: boolean): Task | null {
  if (child.executionTaskId !== parent.taskId || child.currentRunId !== parent.runId || delivered || child.status === 'cancelled') return null;
  const { executionTaskId: _owner, executionProgress: _progress, ...rest } = child;
  return { ...rest, status: 'paused', pauseSource: 'user', reason: '父任务执行已结束，子任务尚未交付。', nextStep: '核对已有成果后决定是否独立继续。' };
}

/** 父运行停止时仍在处理、尚未登记成果的子项标为暂停进度，等待继续父任务；其余子任务返回 null。 */
export function pauseUnfinishedChild(child: Task, runId: string): Task | null {
  if (child.currentRunId !== runId || child.status !== 'waiting' || child.executionProgress !== 'processing') return null;
  return { ...child, executionProgress: 'paused', nextStep: '继续父任务完成该子项。' };
}

/** 父任务整体审核期间子任务被退回：父任务转为用户暂停，整体成果需要重新核对。 */
export function returnParentForChildChanges(parent: Task): Task {
  return { ...parent, status: 'paused', pauseSource: 'user', reason: '子任务被退回，整体成果需重新核对。', nextStep: '继续父任务，处理子任务反馈并重新提交整体成果。' };
}

/** 一轮执行的终结结果，由执行器在 Pi 命令返回或失败后收集。 */
export interface ExecutionOutcome {
  receipt?: AssistantCommandReceipt | undefined;
  failure?: string | undefined;
  endedAt: string;
  cleanupError?: string;
  finalizationError?: string;
  /** 已进入恢复核对（停止未证明或收尾异常）。 */
  recovery?: boolean;
}

/** 把执行终结结果写入运行记录；只保存错误摘要与检查点，不复制模型正文。 */
export function recordExecutionResult(run: TaskRun, outcome: ExecutionOutcome): void {
  run.executionEndedAt = outcome.endedAt;
  const failure = outcome.failure ?? outcome.receipt?.error?.message;
  if (failure !== undefined) run.executionError = failure.slice(0, 4000);
  if (outcome.cleanupError !== undefined) run.cleanupError = outcome.cleanupError;
  if (outcome.finalizationError !== undefined) run.finalizationError = outcome.finalizationError;
  run.runtimeSessionId = outcome.receipt?.runtimeSessionId ?? run.runtimeSessionId;
  run.runtimeEntryId = outcome.receipt?.runtimeEntryId ?? run.runtimeEntryId;
}

export interface Settlement {
  outcome: ExecutionOutcome;
  /** 依赖进程已确认停止。 */
  processesStopped: boolean;
  /** 仍有未结束工具时，核对会话工具是否已确认停止；仅在需要时调用。 */
  toolsStopped: () => boolean;
  /** 预算暂停的耗尽原因；仅在需要时调用。 */
  budgetReason: () => string;
  now: string;
}

/**
 * 执行终结后的停止确认与结算（会修改传入的 run）。
 * 只有依赖进程、原生工具与会话工具都确认停止，才记录 stopConfirmed；否则保留租约进入恢复核对。
 * 返回任务下一状态；outcome.recovery 在停止未证明时被置为 true，供后续只读对账。
 */
export function settleRun(run: TaskRun, task: Task, settlement: Settlement): Task {
  const { outcome } = settlement;
  recordExecutionResult(run, outcome);
  run.stopConfirmed = settlement.processesStopped && (run.nativePendingIds ?? []).length === 0
    && (run.pendingToolIds.length === 0 || settlement.toolsStopped());
  run.elapsedMs = Math.max(0, Date.parse(settlement.now) - Date.parse(run.startedAt ?? run.createdAt));
  if (run.stopConfirmed && run.pendingToolIds.length) {
    // 停止已证明但工具没有结束事实：按失败计入，不再等待。
    run.toolFailures += run.pendingToolIds.length;
    run.pendingToolIds = [];
  }

  if (!run.stopConfirmed) {
    outcome.recovery = true;
    run.status = 'recovery';
    run.reason = run.cleanupError
      ? `执行已结束，但依赖资源停止失败：${run.cleanupError}。停止尚未确认，已有工作已保留。`
      : '执行已结束，暂时无法确认所有工具及依赖资源都已停止，需要先核对执行结果。已有工作已保留。';
    return { ...task, status: 'recovery', reason: run.reason, nextStep: '核对旧执行停止与副作用结果。' };
  }

  if (run.stopIntent) {
    run.status = run.stopIntent === 'cancel' ? 'cancelled' : 'paused';
    run.reason = run.stopIntent === 'cancel' ? '任务已取消，执行已停止，已有工作已保留。'
      : run.requestTimeout ? '模型请求静默超时，原执行与依赖资源已确认停止，检查点保留，等待用户决定是否继续。'
      : task.pauseSource === 'budget' ? `任务已暂停：${run.budgetStopReason ?? settlement.budgetReason()}。执行已停止，已有工作已保留，点击“继续任务”可补充额度并继续。`
      : task.pauseSource === 'human' ? '执行已暂停，等待你处理任务中的请求。'
      : '任务已暂停，已有工作已保留。点击“继续任务”可继续推进。';
    // 为人工请求而暂停：停止已证明，任务回到等待原请求。
    if (run.stopIntent === 'pause' && task.pauseSource === 'human') return { ...task, status: 'waiting', reason: run.reason, nextStep: '等待用户处理原人工请求。' };
    return { ...task, status: run.status, reason: run.reason, nextStep: run.stopIntent === 'cancel' ? '查看已有记录和目录。' : '点击“继续任务”补充执行额度并继续。' };
  }

  if (outcome.recovery) {
    run.status = 'recovery';
    run.reason = '旧执行与依赖资源均已确认停止，收尾异常记录及检查点保留，等待用户决定是否继续。';
    return { ...task, status: 'recovery', reason: run.reason, nextStep: '核对异常与已有工具结果后，由用户决定是否继续。' };
  }

  const succeeded = !outcome.failure && outcome.receipt?.terminalOutcome === 'succeeded';
  run.status = succeeded ? 'settled' : 'failed';
  run.reason = outcome.failure ?? outcome.receipt?.error?.message ?? (succeeded ? '本轮执行已结束，尚未判定长期任务完成。' : '本轮执行未成功。');
  return { ...task, status: succeeded ? 'waiting' : 'failed', reason: run.reason, nextStep: succeeded ? '提交成果与验证证据。' : '检查失败原因后继续。' };
}
