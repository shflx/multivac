import { Check } from 'typebox/value';
import { RunsQuerySchema, isActiveRun, runDisplayState, isRunAnomaly, type RunsQuery, type RunsSnapshot, type RunSnapshot, type Task, type TaskRun } from '@multivac/contracts';
import { TaskServiceError } from './task-service.js';

/**
 * 运行记录可能先于真实执行收敛（停止未在时限内确认而转入恢复核对，或本轮已结算但会话仍在忙），
 * 任务会话仍在执行时以运行时事实为准：有停止意图显示停止中，否则显示执行中。
 */
function liveRunState(state: RunSnapshot['state'], run: TaskRun | null, sessionRunning: boolean): RunSnapshot['state'] {
  if (!run || !sessionRunning || isActiveRun({ state })) return state;
  return run.stopIntent ? 'stopping' : 'running';
}

export class RunsService {
  constructor(
    private readonly read: () => { version: number; rows: { task: Task; run: TaskRun | null; sessionAvailable: boolean }[] },
    private readonly now: () => number = Date.now,
    private readonly processCounts?: (activeOnly?: boolean) => { processesRunning: number; processesRecovery: number },
    /** 只读查询任务会话运行时是否仍在执行（含重试与压缩）；不创建运行时。 */
    private readonly sessionRunning: (sessionId: string) => boolean = () => false,
  ) {}

  list(query: RunsQuery = {}): RunsSnapshot {
    if (!Check(RunsQuerySchema, query)) throw new TaskServiceError('INVALID_REQUEST', '运行分页参数无效。');
    const { rows, version } = this.read();
    const now = this.now();
    const items: RunSnapshot[] = rows.map(({ task, run, sessionAvailable }) => {
      const live = !!run && this.sessionRunning(run.sessionId);
      const state = liveRunState(runDisplayState(task, run), run, live);
      const ended = !!run?.stopConfirmed && !live;
      const startedAt = run && run.hasStarted !== false ? run.startedAt ?? run.createdAt : null;
      return {
        taskId: task.taskId, runId: run?.runId ?? null, sessionId: run?.sessionId ?? null,
        title: task.title, revision: task.revision, state, anomaly: isRunAnomaly(state) || !!run?.noProgressSince && state === 'running',
        reason: task.reason || run?.reason || '尚无可验证的过程记录。', nextStep: task.nextStep,
        startedAt, endedAt: ended ? run!.updatedAt : null,
        elapsedMs: !startedAt ? null : ended ? run!.elapsedMs ?? null : Math.max(0, now - Date.parse(startedAt)),
        lastTool: run?.lastTool ?? null, lastToolAt: run?.lastToolAt ?? null,
        canPause: ['queued', 'running', 'waiting', 'recovery'].includes(task.status) && !run?.stopIntent,
        taskAvailable: !task.deletedAt, sessionAvailable,
      };
    }).filter((item) => query.activeOnly ? isActiveRun(item) : item.state !== 'settled');
    items.sort((a, b) => Number(b.anomaly) - Number(a.anomaly) || a.taskId.localeCompare(b.taskId));
    const counts = { running: 0, queued: 0, anomalies: 0, waiting: 0 };
    for (const item of items) {
      if (item.anomaly) counts.anomalies++;
      if (['running', 'preparing', 'stopping'].includes(item.state)) counts.running++;
      if (item.state === 'queued') counts.queued++;
      if (item.state === 'waiting') counts.waiting++;
    }
    const offset = query.offset ?? 0, limit = query.limit ?? 100;
    const highlights = [...items.filter((item) => item.anomaly).slice(0, 5), ...items.filter((item) => !item.anomaly && ['preparing', 'running', 'stopping'].includes(item.state)).slice(0, 5)];
    return { version, observedAt: new Date(now).toISOString(), items: items.slice(offset, offset + limit), highlights, total: items.length,
      nextOffset: offset + limit < items.length ? offset + limit : null, counts: { ...counts, ...this.processCounts?.(query.activeOnly) } };
  }
}
