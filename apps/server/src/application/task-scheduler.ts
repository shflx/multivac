import { satisfiesTaskDependency } from '@multivac/contracts';
import { randomUUID } from 'node:crypto';
import { freemem } from 'node:os';
import type { Task } from '@multivac/contracts';
import type { TaskRunRepository, TaskRuntimeRepository } from '../modules/tasks/task.js';
import { TaskService, TaskServiceError } from './task-service.js';
import { TaskExecutionService } from './task-execution-service.js';
import type { WorkbenchEvents } from './workbench-events.js';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
const PRIORITY = { high: 0, medium: 1, low: 2 };

/** 单服务调度所有任务；呈现列数与浏览器连接数不参与资源分配。 */
export class TaskScheduler {
  private scheduled = false;
  private disposed = false;
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly tasks: TaskService, private readonly execution: TaskExecutionService, private readonly runs: TaskRunRepository, private readonly runtime: TaskRuntimeRepository, events: WorkbenchEvents) {
    tasks.facts(() => {
      const previous = runtime.owner();
      if (previous && previous.ownerId !== execution.ownerId && alive(previous.pid)) throw new TaskServiceError('TASK_CONFLICT', '已有服务实例拥有任务调度权。');
      runtime.claim(execution.ownerId, process.pid);
    });
    execution.attachScheduler(() => this.wake(), () => this.assertOwner());
    this.recover();
    this.unsubscribe = events.subscribe((event) => { if (event.type === 'task.changed') this.wake(); });
    this.timer = setInterval(() => this.wake(), 1000);
    this.timer.unref();
    this.wake();
  }
  assertOwner(): void {
    if (this.disposed || this.runtime.owner()?.ownerId !== this.execution.ownerId) throw new TaskServiceError('TASK_CONFLICT', '任务调度租约已失效。');
  }
  /** 监护退出凭据补齐后只解除旧租约，保留恢复状态，绝不自动重发执行。 */
  reconcileProcessExits(): void {
    for (const run of this.runs.active()) {
      if (run.ownerId === this.execution.ownerId || run.status !== 'recovery' || run.ownerPid === undefined || alive(run.ownerPid)
        || run.nativeLeaseFenced !== true || run.nativePendingIds?.length || !this.execution.requiredProcessesStopped(run.runId)) continue;
      this.tasks.transition(run.taskId, { commandId: `process-proof:${run.runId}`, key: run.runId, kind: 'recovery-proof', summary: '托管退出凭据已补齐，等待用户恢复决定。' }, (task) => {
        run.stopConfirmed = true; this.runs.save(run);
        return { ...task, reason: '旧执行与依赖进程均已确认停止，检查点保留，等待用户恢复决定。' };
      });
    }
  }
  private recover(): void {
    for (const old of this.runs.active()) {
      if (old.ownerId === this.execution.ownerId) continue;
      this.tasks.transition(old.taskId, { commandId: `recovery:${randomUUID()}`, key: old.runId, kind: 'recovery', summary: '服务启动时核对上次执行记录。' }, (task) => {
        if (old.schedulerManaged && old.hasStarted === false && !old.stopIntent && task.status === 'queued') {
          old.ownerId = this.execution.ownerId; old.ownerPid = process.pid; this.runs.save(old); return task;
        }
        const parentStopped = old.ownerPid !== undefined && !alive(old.ownerPid);
        old.stopConfirmed = this.execution.requiredProcessesStopped(old.runId) && parentStopped && old.nativeLeaseFenced === true && (old.nativePendingIds ?? []).length === 0;
        old.status = 'recovery'; old.reason = old.stopConfirmed ? '旧服务已停止，检查点保留，等待用户恢复决定。' : '旧执行停止或副作用结果未确认，保留原租约。';
        this.runs.save(old);
        return { ...task, status: 'recovery', pauseSource: 'environment', reason: old.reason, nextStep: '核对检查点、工具结果与恢复请求。' };
      });
    }
  }
  wake(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.disposed) return;
      try { this.drain(); }
      catch { this.dispose(); }
    });
  }
  private waiting(task: Task, reason: string): void {
    if (task.reason === reason) return;
    this.tasks.transition(task.taskId, { commandId: `queue:${randomUUID()}`, key: reason, kind: 'queued', summary: reason }, (current) => ({ ...current, reason, nextStep: '等待依赖、预算与执行资源满足条件。' }));
  }
  drain(): void {
    this.assertOwner();
    this.execution.observeProgress();
    const queued: Task[] = [];
    let offset = 0;
    do {
      const page = this.tasks.list({ status: 'queued', limit: 100, offset });
      queued.push(...page.tasks);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    } while (true);
    queued.sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || a.createdAt.localeCompare(b.createdAt) || a.taskId.localeCompare(b.taskId));
    for (const task of queued) {
      if (task.humanOnly) continue;
      const run = task.currentRunId ? this.runs.get(task.currentRunId) : null;
      if (!run || run.hasStarted || run.stopIntent || run.stopConfirmed || run.ownerId !== this.execution.ownerId) continue;
      const dependency = task.dependencyIds.map((id) => this.tasks.get(id)).find((dep) => !satisfiesTaskDependency(dep.status));
      if (dependency) { this.waiting(task, `等待前置任务「${dependency.title}」进入审核中或已完成；当前 ${dependency.status}。`); continue; }
      const budget = this.execution.budget(run.rootTaskId ?? task.taskId);
      if (budget.remainingRuns < 1 || !(budget.remainingMillis > 0) || budget.remainingBytes < 1) { this.waiting(task, '共享执行预算不足，尚未启动。'); continue; }
      const conflict = run.directory && this.runs.active().some((other) => other.runId !== run.runId && other.directory?.path === run.directory?.path);
      if (conflict) { this.waiting(task, '目录仍被未确认停止的执行占用。'); continue; }
      if (freemem() < 64 * 1024 * 1024) { this.waiting(task, '可用内存不足，任务继续排队。'); continue; }
      this.execution.startQueued(run.runId);
    }
    for (const run of this.runs.active()) {
      if (!run.hasStarted || run.ownerId !== this.execution.ownerId || run.stopIntent) continue;
      const budget = this.execution.budget(run.rootTaskId ?? run.taskId);
      if (!(budget.remainingMillis > 0) || budget.remainingBytes < 0) void this.execution.stopForBudget(run.runId).catch(() => undefined);
    }
  }
  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer); this.unsubscribe(); this.runtime.release(this.execution.ownerId);
  }
}
