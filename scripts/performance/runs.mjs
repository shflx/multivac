import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { cpus, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { RunsService } from '../../apps/server/dist/application/runs-service.js';
import { TaskService } from '../../apps/server/dist/application/task-service.js';
import { createTaskRequestHandler } from '../../apps/server/dist/adapters/http/task-routes.js';
import { runOverviewSql } from '../../apps/server/dist/storage/sqlite-task-run-repository.js';
import { SqliteManagedProcessRepository } from '../../apps/server/dist/storage/sqlite-managed-process-repository.js';
import { createDataset, OBSERVED_TIME } from './runs-dataset.mjs';
import { LEGACY_OVERVIEW_SQL, VERSION_SQL, LegacyRunsService, legacyOverview, legacyProcessCounts } from './runs-baseline.mjs';

// 独立脚本，无子进程、不读取用户数据库。先构建服务及契约，再直接运行此文件。
const BASELINE = '87ab69f3302b91c238ce9e95d45af99fc944d5c6';
function setting(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} 无效`);
  return value;
}
const samples = setting('RUNS_PERF_SAMPLES', 30, 10, 1000), warmup = 5;
const rounds = setting('RUNS_PERF_ROUNDS', 3, 2, 20);
const intervalMs = setting('RUNS_PERF_INTERVAL_MS', 5000, 100, 10000);
const port = setting('RUNS_PERF_PORT', 38471, 1024, 65535);
const outputBase = resolve('artifacts/runs-performance');
mkdirSync(outputBase, { recursive: true });
const output = mkdtempSync(join(outputBase, 'sample-'));
const databases = join(output, 'databases');
mkdirSync(databases);
const report = {
  baseline: BASELINE, status: 'running', startedAt: new Date().toISOString(),
  environment: { node: process.version, versions: process.versions, platform: process.platform, arch: process.arch, release: release(),
    cpu: cpus()[0]?.model, logicalCpus: cpus().length, locale: Intl.DateTimeFormat().resolvedOptions().locale },
  settings: { samples, warmup, rounds, intervalMs, port, sizes: [100, 1000, 10000], profiles: ['mixed-history', 'waiting-heavy'],
    sqlite: { journalMode: 'wal', synchronous: 'normal', cacheKiB: 20000, analyzed: true },
    lightPaths: ['/api/task-groups', '/api/tasks?ids=task:000000&limit=1'], lightIntervalMs: 100 },
  limits: ['暖缓存，同进程客户端和服务，HTTP包含收包与JSON解析；不等同跨进程或浏览器测量。',
    '轮询覆盖runs接口；未模拟进程列表的独立轮询、SSE及真实Pi执行。',
    '绝对计划时间用于记录客户端定时器迟到，避免只报告发送后的网络耗时。',
    '合成数据只能验证该数据下的开销，不能证明此前线上长延迟的根因。'],
  implementationHashes: Object.fromEntries([
    'apps/server/src/application/runs-service.ts', 'apps/server/dist/application/runs-service.js',
    'apps/server/src/modules/tasks/run-overview.ts', 'apps/server/dist/modules/tasks/run-overview.js',
    'apps/server/src/storage/sqlite-task-run-repository.ts', 'apps/server/dist/storage/sqlite-task-run-repository.js',
    'apps/server/src/storage/sqlite-managed-process-repository.ts', 'apps/server/dist/storage/sqlite-managed-process-repository.js',
    'packages/contracts/src/runs.ts', 'packages/contracts/dist/runs.js',
    'scripts/performance/runs-baseline.mjs', 'scripts/performance/runs-dataset.mjs', 'scripts/performance/runs.mjs',
  ].map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
  datasets: [],
};
function save() {
  writeFileSync(join(output, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  const lines = ['# 运行接口性能比较', '', `状态：${report.status}；基线：${BASELINE}`, '',
    '耗时单位为毫秒；完整环境、SQL、查询计划、固定数据摘要与原始样本见 results.json。', '',
    '| 规模/数据 | 范围/阶段 | 旧中位数 | 新中位数 | 旧p95 | 新p95 | 旧最大 | 新最大 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
  const number = value => Number(value).toFixed(3);
  for (const dataset of report.datasets) {
    for (const [scope, metrics] of Object.entries(dataset.measurements)) {
      for (const [stage, pair] of Object.entries(metrics)) {
        if (!pair?.legacy?.medianMs) continue;
        lines.push(`| ${dataset.size}/${dataset.profile} | ${scope}/${stage} | ${number(pair.legacy.medianMs)} | ${number(pair.optimized.medianMs)} | ${number(pair.legacy.p95Ms)} | ${number(pair.optimized.p95Ms)} | ${number(pair.legacy.maxMs)} | ${number(pair.optimized.maxMs)} |`);
      }
    }
  }
  lines.push('', '| 规模/数据 | 窗口 | 轻量接口 | 旧请求p95 | 新请求p95 | 旧计划至完成p95 | 新计划至完成p95 |',
    '| --- | ---: | --- | ---: | ---: | ---: | ---: |');
  for (const dataset of report.datasets) {
    for (const [windows, variants] of Object.entries(dataset.load)) {
      if (!variants.legacy || !variants.optimized) continue;
      for (const key of ['groups', 'task']) lines.push(`| ${dataset.size}/${dataset.profile} | ${windows} | ${key} | ${number(variants.legacy[key].request.p95Ms)} | ${number(variants.optimized[key].request.p95Ms)} | ${number(variants.legacy[key].scheduledLatency.p95Ms)} | ${number(variants.optimized[key].scheduledLatency.p95Ms)} |`);
    }
  }
  lines.push('', ...report.limits.map(limit => `- ${limit}`), '');
  if (report.failure) lines.push(`执行失败：${report.failure.message}`, '');
  writeFileSync(join(output, 'summary.md'), lines.join('\n'));
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { n: values.length, medianMs: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
    p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: sorted.at(-1), rawMs: values };
}
async function paired(operations) {
  const result = { legacy: [], optimized: [] };
  for (let i = 0; i < warmup; i++) { await operations.legacy(); await operations.optimized(); }
  for (let i = 0; i < samples; i++) {
    for (const key of i % 2 ? ['optimized', 'legacy'] : ['legacy', 'optimized']) {
      const start = performance.now(); await operations[key](); result[key].push(performance.now() - start);
    }
  }
  const legacy = stats(result.legacy), optimized = stats(result.optimized);
  return { legacy, optimized, medianSpeedup: legacy.medianMs / optimized.medianMs };
}
function captureSql(db, operation) {
  const statements = [];
  operation(new SqliteManagedProcessRepository({ prepare(sql) { statements.push(sql); return db.prepare(sql); } }));
  assert.equal(statements.length, 1);
  return statements[0];
}
async function request(base, path) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, path);
  return response.json();
}
async function load(base, windows) {
  const start = performance.now() + 30, duration = rounds * intervalMs;
  const records = { runs: [], groups: [], task: [] };
  async function timed(path, due, target) {
    await delay(Math.max(0, due - performance.now()));
    const sentAt = performance.now();
    await request(base, path);
    const end = performance.now();
    target.push({ dueMs: due - start, schedulingDelayMs: sentAt - due, requestMs: end - sentAt, scheduledLatencyMs: end - due });
  }
  // 每窗口同一时刻刷新，覆盖聚焦/重连后多个窗口同时读取的情形。
  const clients = Array.from({ length: windows }, () => (async () => {
    for (let round = 0; round < rounds; round++) await timed('/api/runs?activeOnly=true&limit=100', start + round * intervalMs, records.runs);
  })());
  for (const [key, path] of [['groups', '/api/task-groups'], ['task', '/api/tasks?ids=task:000000&limit=1']]) {
    clients.push((async () => {
      for (let tick = 0; tick < Math.ceil(duration / 100); tick++) await timed(path, start + tick * 100, records[key]);
    })());
  }
  await Promise.all(clients);
  return Object.fromEntries(Object.entries(records).map(([key, entries]) => [key, { raw: entries,
    ...(entries.length ? { request: stats(entries.map(row => row.requestMs)), scheduledLatency: stats(entries.map(row => row.scheduledLatencyMs)),
      schedulingDelay: stats(entries.map(row => row.schedulingDelayMs)) } : {}) }]));
}
let handler;
const server = createServer((req, res) => {
  Promise.resolve(handler(req, res)).then(handled => { if (!handled) { res.writeHead(404); res.end(); } })
    .catch(error => { res.writeHead(500); res.end(String(error)); });
});
let listening = false;
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  listening = true;
  const base = `http://127.0.0.1:${port}`;
  for (const size of report.settings.sizes) {
    for (const profile of report.settings.profiles) {
      const before = createDataset(join(databases, `${size}-${profile}-legacy.sqlite`), size, profile, false);
      const after = createDataset(join(databases, `${size}-${profile}-optimized.sqlite`), size, profile, true);
      try {
        assert.equal(before.digest, after.digest);
        const now = () => OBSERVED_TIME;
        const reads = { legacy: () => legacyOverview(before.db), optimized: activeOnly => after.runs.overview(activeOnly) };
        const processReads = { legacy: activeOnly => legacyProcessCounts(before.processes, activeOnly), optimized: activeOnly => after.processes.counts(activeOnly) };
        const services = { legacy: new LegacyRunsService(reads.legacy, now, processReads.legacy), optimized: new RunsService(reads.optimized, now, processReads.optimized) };
        const handlers = Object.fromEntries([['legacy', before], ['optimized', after]].map(([key, dataset]) => [key,
          createTaskRequestHandler(new TaskService({ repository: dataset.tasks, requireProject: () => null }), undefined, undefined, services[key])]));
        const processSql = {
          legacy: captureSql(before.db, repo => repo.visible()),
          optimized: captureSql(after.db, repo => repo.counts()),
        };
        const result = { size, profile, digest: before.digest, facts: before.facts,
          sqliteVersion: before.db.prepare('SELECT sqlite_version() version').get().version,
          queries: { legacyTasks: LEGACY_OVERVIEW_SQL, optimizedActive: runOverviewSql(true), optimizedAll: runOverviewSql(false), processes: processSql },
          plans: { legacyTasks: before.db.prepare(`EXPLAIN QUERY PLAN ${LEGACY_OVERVIEW_SQL}`).all(),
            optimizedActive: after.db.prepare(`EXPLAIN QUERY PLAN ${runOverviewSql(true)}`).all(),
            optimizedAll: after.db.prepare(`EXPLAIN QUERY PLAN ${runOverviewSql(false)}`).all(),
            legacyProcesses: before.db.prepare(`EXPLAIN QUERY PLAN ${processSql.legacy}`).all(),
            optimizedProcesses: after.db.prepare(`EXPLAIN QUERY PLAN ${processSql.optimized}`).all() },
          correctness: {}, measurements: {}, load: {} };
        report.datasets.push(result);
        for (const activeOnly of [undefined, false, true]) {
          for (const offset of [0, 1, 99, 100, Math.max(0, size - 37), size + 1]) {
            const query = { ...(activeOnly === undefined ? {} : { activeOnly }), offset, limit: 37 };
            assert.deepEqual(services.optimized.list(query), services.legacy.list(query));
          }
        }
        assert.equal(result.facts.backgroundExited, size);
        result.correctness = { result: 'passed', comparedQueries: 18, includes: 'items/highlights/total/counts/nextOffset/version/observedAt', backgroundExited: size };
        for (const activeOnly of [false, true]) {
          const key = activeOnly ? 'active' : 'all', query = { activeOnly, limit: 100 };
          const sql = { legacy: LEGACY_OVERVIEW_SQL, optimized: runOverviewSql(activeOnly) };
          const snapshots = { legacy: reads.legacy(), optimized: reads.optimized(activeOnly) };
          const counts = { legacy: processReads.legacy(activeOnly), optimized: processReads.optimized(activeOnly) };
          const compute = { legacy: new LegacyRunsService(() => snapshots.legacy, now, () => counts.legacy),
            optimized: new RunsService(() => snapshots.optimized, now, () => counts.optimized) };
          const rows = { legacy: before.db.prepare(sql.legacy).all(), optimized: after.db.prepare(sql.optimized).all() };
          const metric = result.measurements[key] = { returnedRows: { legacy: rows.legacy.length, optimized: rows.optimized.length },
            returnedJsonBytes: Object.fromEntries(Object.entries(rows).map(([variant, values]) => [variant,
              values.reduce((n, row) => n + Buffer.byteLength(row.task_json ?? '') + Buffer.byteLength(row.run_json ?? ''), 0)])) };
          metric.databaseTasks = await paired(Object.fromEntries([['legacy', before], ['optimized', after]].map(([variant, dataset]) => [variant, () => {
            dataset.db.prepare(sql[variant]).all(); dataset.db.prepare(VERSION_SQL).get();
          }])));
          metric.databaseProcesses = await paired({ legacy: () => before.db.prepare(processSql.legacy).all(), optimized: () => after.db.prepare(processSql.optimized).all() });
          metric.repositoryWithDecode = await paired({ legacy: () => reads.legacy(), optimized: () => reads.optimized(activeOnly) });
          metric.processCountsWithDecode = await paired({ legacy: () => processReads.legacy(activeOnly), optimized: () => processReads.optimized(activeOnly) });
          metric.serviceComputeOnly = await paired({ legacy: () => compute.legacy.list(query), optimized: () => compute.optimized.list(query) });
          metric.serviceIncludingReads = await paired({ legacy: () => services.legacy.list(query), optimized: () => services.optimized.list(query) });
          const path = `/api/runs?activeOnly=${activeOnly}&limit=100`;
          handler = handlers.legacy; const legacyResponse = await request(base, path);
          handler = handlers.optimized; assert.deepEqual(await request(base, path), legacyResponse);
          metric.http = await paired({ legacy: () => { handler = handlers.legacy; return request(base, path); },
            optimized: () => { handler = handlers.optimized; return request(base, path); } });
          save();
        }
        // 空闲、单窗口、四窗口分别对照，同一phase只启用一种服务。
        for (const windows of [0, 1, 4]) {
          result.load[windows] = {};
          for (const variant of size === 1000 ? ['optimized', 'legacy'] : ['legacy', 'optimized']) {
            handler = handlers[variant];
            result.load[windows][variant] = await load(base, windows);
            save();
          }
        }
        console.log(JSON.stringify({ size, profile, activeServiceMedianSpeedup: result.measurements.active.serviceIncludingReads.medianSpeedup,
          allServiceMedianSpeedup: result.measurements.all.serviceIncludingReads.medianSpeedup }));
      } finally { before.db.close(); after.db.close(); }
    }
  }
  report.finishedAt = new Date().toISOString(); report.status = 'completed';
} catch (error) {
  report.status = 'failed'; report.failure = { message: String(error), stack: error?.stack }; process.exitCode = 1;
} finally {
  if (listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  // 只清理本脚本新建的数据库目录；结果保留原始样本和数据摘要。
  rmSync(databases, { recursive: true, force: true });
  save();
  console.log(`性能报告：${join(output, 'results.json')}`);
}
