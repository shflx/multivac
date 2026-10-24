import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProcessList, ProcessListItem, RunsSnapshot } from '@multivac/contracts';
import { RunsStore } from '../src/features/runs/runs-store.js';
import { ProcessesStore } from '../src/features/runs/processes-store.js';
import { runIndicatorView } from '../src/features/runs/run-indicator-state.js';
import { RunIndicatorContent } from '../src/features/runs/run-indicator.js';
import { STATUS_QUERY_TIMEOUT_MS } from '../src/features/runs/status-query.js';

const snapshot = (version = 1, processesRunning = 1): RunsSnapshot => ({ version, observedAt: '', items: [], highlights: [], total: 0, nextOffset: null,
  counts: { running: 0, queued: 0, anomalies: 0, waiting: 0, processesRunning } });
const process = (mode: 'foreground' | 'background' = 'foreground'): ProcessListItem => ({
  processId: mode, taskId: null, runId: null, sessionId: 'session', revision: 1, name: `${mode} 命令`, command: 'node script.js', state: 'running', mode,
  requiredWhileRunning: false, startedAt: null, endedAt: null, port: null, exitCode: null, reason: '', taskTitle: null, taskAvailable: false, taskRunning: false,
  sessionAvailable: true, sessionTitle: '开发会话',
});
const list = (...processes: ProcessListItem[]): ProcessList => ({ processes, total: processes.length, nextOffset: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function view(runs: RunsStore, processes: ProcessesStore) { return runIndicatorView(runs.snapshot(), processes.snapshot()); }
function html(runs: RunsStore, processes: ProcessesStore) {
  return renderToStaticMarkup(createElement(RunIndicatorContent, {
    runs: { ...runs.snapshot(), store: runs }, processes: { ...processes.snapshot(), store: processes },
    onClose() {}, onOpenSession() {}, onOpenTask() {}, onViewRuns() {},
  }));
}

test('计数为 1 而明细延迟：显示读取提示，不把 runs 的旧进程数当作列表计数', async () => {
  const pending = deferred<ProcessList>();
  const runs = new RunsStore(async () => snapshot());
  const processes = new ProcessesStore(() => pending.promise);
  await runs.refresh();
  const reading = processes.refresh();
  assert.equal(view(runs, processes).label, '读取中');
  assert.equal(view(runs, processes).confirmed, false);
  assert.match(html(runs, processes), /正在读取进程明细/);
  assert.doesNotMatch(html(runs, processes), /1 个进程|没有运行中的任务会话或进程/);
  pending.resolve(list(process())); await reading;
  assert.equal(view(runs, processes).counts.processesRunning, 1);
  assert.match(html(runs, processes), /1 个进程/);
  assert.match(html(runs, processes), /foreground 命令/);
});

test('明细先返回空列表、两来源乱序及短命进程退出：成功后按列表快照显示空闲', async () => {
  const pending = deferred<RunsSnapshot>();
  const runs = new RunsStore(() => pending.promise);
  let current = list();
  const processes = new ProcessesStore(async () => current);
  const reading = runs.refresh(); await processes.refresh();
  assert.match(html(runs, processes), /正在读取任务运行状态/);
  assert.match(html(runs, processes), /没有活跃进程/);
  assert.equal(view(runs, processes).empty, false);
  pending.resolve(snapshot()); await reading;
  assert.equal(view(runs, processes).label, '空闲');
  assert.equal(view(runs, processes).counts.processesRunning, 0);
  assert.doesNotMatch(html(runs, processes), /1 个进程/);
  current = list(process()); await processes.refresh();
  assert.equal(view(runs, processes).label, '运行中');
  current = list(); await processes.refresh();
  assert.equal(view(runs, processes).empty, true);
  assert.doesNotMatch(html(runs, processes), /foreground 命令|1 个进程/);
  assert.equal(runs.snapshot().data?.counts.processesRunning, 1);
});

test('刷新失败保留真实明细及旧结果提示；重试成功前不显示当前空闲', async () => {
  const runs = new RunsStore(async () => snapshot());
  const retry = deferred<ProcessList>();
  let reads = 0;
  const processes = new ProcessesStore(async () => {
    if (++reads === 1) return list(process(), process('background'));
    if (reads === 2) throw Error('刷新失败');
    return retry.promise;
  });
  await Promise.all([runs.refresh(), processes.refresh()]);
  await processes.refresh();
  assert.equal(view(runs, processes).label, '状态待核对');
  assert.match(html(runs, processes), /foreground 命令/);
  assert.match(html(runs, processes), /background 命令/);
  assert.match(html(runs, processes), /刷新失败/);
  assert.match(html(runs, processes), /上次确认结果/);
  const reading = processes.refresh();
  assert.match(html(runs, processes), /正在核对进程状态/);
  assert.equal(view(runs, processes).empty, false);
  retry.resolve(list()); await reading;
  assert.equal(view(runs, processes).label, '空闲');
  assert.doesNotMatch(html(runs, processes), /刷新失败|上次确认结果/);
});

test('首次失败与任务读取失败都有明确提示；任务失败不隐藏进程列表', async () => {
  const runs = new RunsStore(async () => { throw Error('任务读取失败'); });
  const processes = new ProcessesStore(async () => { throw Error('进程读取失败'); });
  await Promise.all([runs.refresh(), processes.refresh()]);
  assert.equal(view(runs, processes).label, '状态不可用');
  assert.match(html(runs, processes), /任务读取失败/);
  assert.match(html(runs, processes), /进程读取失败/);
  assert.doesNotMatch(html(runs, processes), /正在读取|没有运行中的任务会话或进程/);
  const available = new ProcessesStore(async () => list(process())); await available.refresh();
  assert.match(html(runs, available), /foreground 命令/);
  assert.match(html(runs, available), /任务读取失败/);
});

test('重连新查询取消旧读取；迟到成功或失败都不能覆盖新快照', async () => {
  for (const lateFailure of [false, true]) {
    const runs = new RunsStore(async () => snapshot()); await runs.refresh();
    const old = deferred<ProcessList>(), fresh = deferred<ProcessList>();
    const signals: AbortSignal[] = [];
    const processes = new ProcessesStore((_offset, signal) => {
      signals.push(signal); return signals.length === 1 ? old.promise : fresh.promise;
    });
    const first = processes.refresh(), reconnect = processes.refresh();
    assert.equal(signals[0]?.aborted, true);
    fresh.resolve(list()); await reconnect; await first;
    if (lateFailure) old.reject(Error('迟到错误')); else old.resolve(list(process()));
    await Promise.resolve();
    assert.equal(processes.snapshot().overview?.total, 0);
    assert.equal(processes.snapshot().error, '');
    assert.equal(view(runs, processes).label, '空闲');
  }
});

test('挂起超时及取消错误可恢复；保留列表时明确标记旧结果', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const runs = new RunsStore(async () => snapshot()); await runs.refresh();
  let reads = 0;
  const processes = new ProcessesStore(async () => {
    if (++reads === 1) return list(process());
    if (reads === 2) return new Promise(() => {});
    if (reads === 3) throw new DOMException('请求已取消', 'AbortError');
    return list();
  });
  await processes.refresh();
  const hung = processes.refresh();
  assert.match(html(runs, processes), /正在核对进程状态/);
  t.mock.timers.tick(STATUS_QUERY_TIMEOUT_MS); await hung;
  assert.match(html(runs, processes), /超时/);
  assert.match(html(runs, processes), /foreground 命令/);
  await processes.refresh();
  assert.match(html(runs, processes), /请求已取消/);
  assert.equal(view(runs, processes).empty, false);
  await processes.refresh();
  assert.equal(view(runs, processes).label, '空闲');
});

test('运行页翻页不改变弹层列表口径；任务与恢复统计保持原值', async () => {
  const runs = new RunsStore(async () => ({ ...snapshot(), counts: { ...snapshot().counts, running: 2, queued: 3, anomalies: 4, waiting: 5, processesRecovery: 6 } }));
  const offsets: number[] = [];
  const processes = new ProcessesStore(async offset => {
    offsets.push(offset);
    const items = offset ? [{ ...process(), processId: '100', name: '第二页进程' }]
      : Array.from({ length: 100 }, (_, index) => ({ ...process(), processId: String(index), name: `首页进程 ${index}` }));
    return { processes: items, total: 101, nextOffset: offset ? null : 100 };
  });
  await Promise.all([runs.refresh(), processes.refresh(100)]);
  assert.deepEqual(offsets, [0, 100]);
  assert.equal(processes.snapshot().data?.processes[0]?.name, '第二页进程');
  assert.match(html(runs, processes), /首页进程/);
  assert.doesNotMatch(html(runs, processes), /第二页进程/);
  assert.match(html(runs, processes), /共 101 个/);
  const counts = view(runs, processes).counts;
  assert.deepEqual(counts, { running: 2, queued: 3, anomalies: 4, waiting: 5, processesRunning: 101, processesRecovery: 6 });
  assert.equal(view(runs, processes).state, 'attention');
  assert.match(html(runs, processes), /6 个进程正在恢复核对/);
});

test('多窗口独立缓存均在补读后使用各自已确认的列表快照', async () => {
  let current = list(process());
  const windows = [0, 1].map(() => ({ runs: new RunsStore(async () => snapshot()), processes: new ProcessesStore(async () => current) }));
  await Promise.all(windows.flatMap(w => [w.runs.refresh(), w.processes.refresh()]));
  assert.ok(windows.every(w => view(w.runs, w.processes).counts.processesRunning === 1));
  current = list();
  await Promise.all(windows.flatMap(w => [w.processes.refresh(), w.runs.refresh()]));
  assert.ok(windows.every(w => view(w.runs, w.processes).label === '空闲'));
});


test("runs 进程数为零也保留真实前后台进程，启动与停止中的进程继续计数", async () => {
  const runs = new RunsStore(async () => snapshot(1, 0));
  const processes = new ProcessesStore(async () => list({ ...process(), state: "starting" }, { ...process("background"), state: "stopping" }));
  await Promise.all([runs.refresh(), processes.refresh()]);
  assert.equal(view(runs, processes).counts.processesRunning, 2);
  assert.equal(view(runs, processes).state, "ok");
  const content = html(runs, processes);
  for (const text of ["foreground 命令", "background 命令", "启动中", "停止中", "2 个进程"]) assert.ok(content.includes(text));
});

test("分页读取失败时不发布部分首页结果，保留旧快照并终止同轮其他读取", async () => {
  const runs = new RunsStore(async () => snapshot()); await runs.refresh();
  let paging = false;
  let pageSignal: AbortSignal | undefined;
  const processes = new ProcessesStore(async (offset, signal) => {
    if (!paging) return list(process());
    pageSignal = signal;
    if (offset) throw Error("分页读取失败");
    return new Promise(() => {});
  });
  await processes.refresh();
  const previous = processes.snapshot().overview;
  paging = true; await processes.refresh(100);
  assert.equal(pageSignal?.aborted, true);
  assert.equal(processes.snapshot().loading, false);
  assert.equal(processes.snapshot().overview, previous);
  assert.match(html(runs, processes), /分页读取失败/);
  assert.match(html(runs, processes), /foreground 命令/);
});

// 只比较业务显示字段；请求在途与已确认状态分别派生。
function businessView(runs: RunsStore, processes: ProcessesStore) {
  const { label, state, summary, counts, empty, activeProcesses } = view(runs, processes);
  return { label, state, summary, counts, empty, activeProcesses };
}

test('已有成功快照时，两轮同数据刷新保持运行、空闲及恢复核对状态', async () => {
  for (const mode of ['active', 'idle', 'recovery'] as const) {
    const confirmedRuns = { ...snapshot(), counts: { ...snapshot().counts, processesRecovery: mode === 'recovery' ? 1 : 0 } };
    const confirmedProcesses = mode === 'active' ? list(process()) : list();
    let nextRuns: Promise<RunsSnapshot> = Promise.resolve(confirmedRuns);
    let nextProcesses: Promise<ProcessList> = Promise.resolve(confirmedProcesses);
    const runs = new RunsStore(() => nextRuns);
    const processes = new ProcessesStore(() => nextProcesses);
    await Promise.all([runs.refresh(), processes.refresh()]);
    const before = businessView(runs, processes);
    for (let round = 0; round < 2; round++) {
      const pendingRuns = deferred<RunsSnapshot>(), pendingProcesses = deferred<ProcessList>();
      nextRuns = pendingRuns.promise; nextProcesses = pendingProcesses.promise;
      const readingRuns = runs.refresh(), readingProcesses = processes.refresh();
      assert.equal(view(runs, processes).refreshing, true);
      assert.equal(view(runs, processes).checking, false);
      assert.deepEqual(businessView(runs, processes), before);
      pendingRuns.resolve(confirmedRuns); await readingRuns;
      assert.deepEqual(businessView(runs, processes), before);
      pendingProcesses.resolve(confirmedProcesses); await readingProcesses;
      assert.deepEqual(businessView(runs, processes), before);
      assert.equal(view(runs, processes).refreshing, false);
    }
  }
});

test('任一路失败后，另一来源成功和重试在途都不清除错误', async () => {
  for (const source of ['runs', 'processes'] as const) {
    let fail = false;
    const retryRuns = deferred<RunsSnapshot>(), retryProcesses = deferred<ProcessList>();
    let retrying = false;
    const runs = new RunsStore(async () => {
      if (source === 'runs' && fail) { if (retrying) return retryRuns.promise; throw Error('任务读取失败'); }
      return snapshot();
    });
    const processes = new ProcessesStore(async () => {
      if (source === 'processes' && fail) { if (retrying) return retryProcesses.promise; throw Error('进程读取失败'); }
      return list(process());
    });
    await Promise.all([runs.refresh(), processes.refresh()]);
    fail = true; await Promise.all([runs.refresh(), processes.refresh()]);
    assert.equal(view(runs, processes).label, '状态待核对');
    assert.match(view(runs, processes).summary, /上次确认结果/);
    retrying = true;
    const reading = Promise.all([runs.refresh(), processes.refresh()]);
    assert.equal(view(runs, processes).label, '状态待核对');
    assert.equal(view(runs, processes).checking, true);
    assert.equal(view(runs, processes).counts.processesRunning, 1);
    assert.equal(view(runs, processes).empty, false);
    retryRuns.resolve(snapshot(2)); retryProcesses.resolve(list()); await reading;
    assert.equal(view(runs, processes).error, '');
    assert.equal(view(runs, processes).label, source === 'processes' ? '空闲' : '运行中');
  }
});

test('尚无两路快照时，未发起或部分在途都显示读取中', async () => {
  const runs = new RunsStore(async () => snapshot());
  const processes = new ProcessesStore(async () => list());
  assert.equal(view(runs, processes).label, '读取中');
  assert.equal(view(runs, processes).empty, false);
  await runs.refresh();
  assert.equal(view(runs, processes).label, '读取中');
  assert.equal(view(runs, processes).empty, false);
  await processes.refresh();
  assert.equal(view(runs, processes).label, '空闲');
});

test('新运行事实即时更新，任务迟到成功与失败均不能回退新状态', async () => {
  for (const lateFailure of [false, true]) {
    const old = deferred<RunsSnapshot>(), fresh = deferred<RunsSnapshot>();
    let reads = 0;
    const runs = new RunsStore(() => ++reads === 1 ? old.promise : fresh.promise);
    const processes = new ProcessesStore(async () => list()); await processes.refresh();
    const first = runs.refresh(), reconnect = runs.refresh();
    fresh.resolve({ ...snapshot(3), counts: { ...snapshot().counts, running: 2, queued: 1, waiting: 1 } });
    await reconnect; await first;
    assert.equal(view(runs, processes).label, '运行中');
    assert.equal(view(runs, processes).counts.running, 2);
    if (lateFailure) old.reject(Error('迟到任务错误')); else old.resolve(snapshot(1));
    await Promise.resolve();
    assert.equal(view(runs, processes).counts.running, 2);
    assert.equal(view(runs, processes).error, '');
  }
});
