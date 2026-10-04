import { Check } from 'typebox/value';
import { RunsQuerySchema, runDisplayState, isRunAnomaly, type RunsQuery, type RunsSnapshot, type RunSnapshot, type Task, type TaskRun } from '@multivac/contracts';
import { TaskServiceError } from './task-service.js';

export class RunsService {
  constructor(
    private readonly read: () => { version: number; rows: { task: Task; run: TaskRun | null; sessionAvailable: boolean }[] },
    private readonly now: () => number = Date.now,
    private readonly processCounts?: () => { processesRunning: number; processesRecovery: number },
  ) {}

  list(query: RunsQuery = {}): RunsSnapshot {
    if (!Check(RunsQuerySchema, query)) throw new TaskServiceError('INVALID_REQUEST', '运行分页参数无效。');
    const { rows, version } = this.read();
    const now = this.now();
    const items: RunSnapshot[] = rows.map(({ task, run, sessionAvailable }) => {
      const state = runDisplayState(task, run);
      const startedAt = run && run.hasStarted !== false ? run.startedAt ?? run.createdAt : null;
      return {
        taskId: task.taskId, runId: run?.runId ?? null, sessionId: run?.sessionId ?? null,
        title: task.title, revision: task.revision, state, anomaly: isRunAnomaly(state) || !!run?.noProgressSince && state === 'running',
        reason: task.reason || run?.reason || '尚无可验证的过程记录。', nextStep: task.nextStep,
        startedAt, endedAt: run?.stopConfirmed ? run.updatedAt : null,
        elapsedMs: !startedAt ? null : run?.stopConfirmed ? run.elapsedMs ?? null : Math.max(0, now - Date.parse(startedAt)),
        lastTool: run?.lastTool ?? null, lastToolAt: run?.lastToolAt ?? null,
        canPause: ['queued', 'running', 'waiting', 'recovery'].includes(task.status) && !run?.stopIntent,
        taskAvailable: !task.deletedAt, sessionAvailable,
      };
    }).filter((item) => item.state !== 'settled');
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
      nextOffset: offset + limit < items.length ? offset + limit : null, counts: { ...counts, ...this.processCounts?.() } };
  }
}
