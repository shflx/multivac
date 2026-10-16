// 冻结于 87ab69f3302b91c238ce9e95d45af99fc944d5c6，仅供独立性能比较。
// 不复用新查询或新服务算法，以便回归能发现范围和统计的变化。
import { Check } from 'typebox/value';
import { TaskSchema, TaskRunSchema, RunsQuerySchema, isActiveRun, runDisplayState, isRunAnomaly } from '@multivac/contracts';

export const LEGACY_OVERVIEW_SQL = `SELECT t.record_json AS task_json, r.record_json AS run_json, (s.session_id IS NOT NULL AND s.archived_at IS NULL) AS session_available
  FROM task t LEFT JOIN task_run r ON r.run_id=json_extract(t.record_json, '$.currentRunId')
  LEFT JOIN assistant_session_registry s ON s.session_id=r.session_id
  WHERE json_extract(t.record_json, '$.deletedAt') IS NULL
    AND (r.task_id IS NULL OR r.task_id=t.task_id)
    AND (t.status NOT IN ('idle', 'done', 'cancelled') OR r.stop_confirmed=0)`;
export const VERSION_SQL = 'SELECT coalesce(max(event_id), 0) AS version FROM task_event';
export function legacyOverview(db) {
  const rows = db.prepare(LEGACY_OVERVIEW_SQL).all();
  const version = Number(db.prepare(VERSION_SQL).get().version);
  return { version, rows: rows.map(row => {
    const task = JSON.parse(row.task_json), run = row.run_json ? JSON.parse(row.run_json) : null;
    if (!Check(TaskSchema, task) || (run && !Check(TaskRunSchema, run))) throw new Error('旧查询完整事实校验失败');
    return { task, run, sessionAvailable: !!row.session_available };
  }) };
}
export function legacyProcessCounts(repository, activeOnly = false) {
  const items = repository.visible().map(record => record.public)
    .sort((a, b) => Number(['exited', 'failed'].includes(a.state)) - Number(['exited', 'failed'].includes(b.state)));
  return { processesRunning: items.filter(item => ['starting', 'running', 'stopping'].includes(item.state)).length,
    processesRecovery: activeOnly ? 0 : items.filter(item => item.state === 'recovery').length };
}
export class LegacyRunsService {
  constructor(read, now, processCounts) { this.read = read; this.now = now; this.processCounts = processCounts; }
  list(query = {}) {
    if (!Check(RunsQuerySchema, query)) throw new Error('运行分页参数无效。');
    const { rows, version } = this.read();
    const now = this.now();
    const items = rows.map(({ task, run, sessionAvailable }) => {
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
    }).filter(item => query.activeOnly ? isActiveRun(item) : item.state !== 'settled');
    items.sort((a, b) => Number(b.anomaly) - Number(a.anomaly) || a.taskId.localeCompare(b.taskId));
    const counts = { running: 0, queued: 0, anomalies: 0, waiting: 0 };
    for (const item of items) {
      if (item.anomaly) counts.anomalies++;
      if (['running', 'preparing', 'stopping'].includes(item.state)) counts.running++;
      if (item.state === 'queued') counts.queued++;
      if (item.state === 'waiting') counts.waiting++;
    }
    const offset = query.offset ?? 0, limit = query.limit ?? 100;
    const highlights = [...items.filter(item => item.anomaly).slice(0, 5), ...items.filter(item => !item.anomaly && ['preparing', 'running', 'stopping'].includes(item.state)).slice(0, 5)];
    return { version, observedAt: new Date(now).toISOString(), items: items.slice(offset, offset + limit), highlights, total: items.length,
      nextOffset: offset + limit < items.length ? offset + limit : null, counts: { ...counts, ...this.processCounts?.(query.activeOnly) } };
  }
}
