import { isActiveManagedProcess, runIndicatorState } from '@multivac/contracts';
import type { ProcessesState } from './processes-store.js';
import type { RunsState } from './runs-store.js';
import { runSummary } from './run-presentation.js';

/** 进程总数和明细共用已确认的活跃首页；任务及恢复统计保留原有口径。 */
export function runIndicatorView(runs: RunsState, processes: ProcessesState) {
  const confirmed = !!runs.data && !!processes.overview;
  const error = runs.error || processes.error;
  const refreshing = runs.loading || processes.loading;
  // 已有成功快照时，普通刷新不改变已确认状态；错误持续到成功核对。
  const checking = !confirmed || (!!error && refreshing);
  const counts = { running: 0, queued: 0, anomalies: 0, waiting: 0, ...runs.data?.counts, processesRunning: processes.overview?.total ?? 0 };
  const state = runIndicatorState(counts);
  const label = error ? (runs.data || processes.overview ? '状态待核对' : '状态不可用')
    : checking ? '读取中'
    : { idle: '空闲', ok: '运行中', attention: '需要留意' }[state];
  const summary = confirmed ? `${runSummary(counts)}${error ? '（上次确认结果）' : ''}` : error ? '暂时无法核对最新运行状态' : '正在读取运行事实';
  return {
    counts, state, label, summary, error, checking, refreshing, confirmed,
    activeProcesses: processes.overview?.processes.filter(isActiveManagedProcess) ?? [],
    empty: confirmed && !error && !counts.running && !counts.processesRunning && !counts.processesRecovery,
  };
}
