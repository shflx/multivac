import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { Agent, request } from 'node:http';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIXED_TIME } from './runs-fixed-time.mjs';

const BASELINE = '0704c05f8f3f8fb279d70b0b0fe21af210a54056';
const sessionId = 'status-load-session';
const paths = { runs: '/api/runs?activeOnly=true', processes: '/api/processes?activeOnly=true',
  selection: `/api/sessions/${sessionId}/model-selection`, access: '/api/model-access',
  subagents: '/api/subagents?limit=10', light: '/api/task-groups' };
const scenarios = [{ windows: 1, events: 1 }, { windows: 4, events: 1 }, { windows: 4, events: 30 }];
const load = (root, file) => import(pathToFileURL(join(root, file)).href);
function stats(values) {
  if (!values.length) return { n: 0, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { n: values.length, p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) };
}

function http(base, path, { method = 'GET', body, signal, agent } = {}) {
  const start = performance.now();
  return new Promise((resolveRequest, reject) => {
    const req = request(base + path, { method, signal, agent, headers: body && { 'content-type': 'application/json' } }, res => {
      const ttfb = performance.now() - start;
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString();
          assert.ok(res.statusCode < 300, `${res.statusCode} ${path}: ${text.slice(0, 400)}`);
          resolveRequest({ ttfb, value: text ? JSON.parse(text) : null });
        } catch (error) { reject(error); }
      });
    });
    req.on('error', error => reject(Object.assign(new Error(`${path}: ${error.message}`, { cause: error }), { code: error.code })));
    req.setTimeout(30_000, () => req.destroy(new Error(`HTTP 超时：${path}`)));
    req.end(body && JSON.stringify(body));
  });
}

async function serve(root) {
  const directory = mkdtempSync(join(tmpdir(), 'multivac-status-load-'));
  const dataDir = join(directory, 'data');
  const authDir = join(dataDir, 'pi');
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(authDir, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'synthetic-status-load-only' } }), { mode: 0o600 });
  // 真实 Pi 本地解析，无用户凭据、外部模型调用或外部目录刷新。
  const env = { MULTIVAC_MODE: 'development', MULTIVAC_DATA_DIR: dataDir, MULTIVAC_WORK_ROOT: join(directory, 'work'),
    MULTIVAC_TRASH_DIR: join(directory, 'trash'), MULTIVAC_HARNESS: 'pi' };
  Object.assign(process.env, env, { PI_OFFLINE: '1' });
  delete process.env.MULTIVAC_FAKE_ASSISTANT;
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  const scope = new AsyncLocalStorage();
  const [{ createMultivacApplication }, { SqliteManagedProcessRepository }, { SqliteUsageRepository },
    { AssistantOperationLock }, { SqliteSubagentRepository }, { subagentRecord }, { SessionManager }] = await Promise.all([
    load(root, 'apps/server/src/bootstrap/application.ts'), load(root, 'apps/server/src/storage/sqlite-managed-process-repository.ts'),
    load(root, 'apps/server/src/storage/sqlite-usage-repository.ts'), load(root, 'apps/server/src/application/assistant-operation-lock.ts'),
    load(root, 'apps/server/src/storage/sqlite-subagent-repository.ts'), load(root, 'apps/server/tests/fixtures/subagent-record.ts'),
    import('@earendil-works/pi-coding-agent'),
  ]);
  const decode = SqliteManagedProcessRepository.prototype.decode;
  SqliteManagedProcessRepository.prototype.decode = function (row) {
    const entry = scope.getStore(); if (entry) entry.processRows++;
    return decode.call(this, row);
  };
  const records = SqliteUsageRepository.prototype.records;
  SqliteUsageRepository.prototype.records = function (...args) {
    const rows = records.apply(this, args);
    const entry = scope.getStore(); if (entry) entry.usageRows += rows.length;
    return rows;
  };
  const open = SessionManager.open;
  SessionManager.open = function (...args) { const entry = scope.getStore(); if (entry) entry.parses++; return open.apply(this, args); };
  const run = AssistantOperationLock.prototype.run;
  AssistantOperationLock.prototype.run = function (operation) {
    const entry = scope.getStore(); const start = performance.now();
    return run.call(this, () => { if (entry?.kind === 'selection') entry.lockWaitMs += performance.now() - start; return operation(); });
  };

  const app = createMultivacApplication(env);
  // 合成进程没有真实 PID，只供查询；后台观测不能把夹具改成恢复态。
  app.managedProcesses.observe = async () => {};
  let db, transcript, leaf, sequence = 0;
  const nextMessage = () => {
    const id = `load-${++sequence}`;
    const line = JSON.stringify({ type: 'message', id, parentId: leaf, timestamp: FIXED_TIME,
      message: { role: 'user', content: '固定消息', timestamp: Date.parse(FIXED_TIME) } }) + '\n';
    leaf = id;
    return line;
  };
  const json = (res, value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  let samples = [], origins = 0;
  let heldStatus = null;
  const [handler] = app.server.listeners('request');
  app.server.removeListener('request', handler);
  app.server.on('request', (req, res) => {
    if (req.url === '/__load/reset') { samples = []; origins = performance.now(); histogram.reset(); json(res, {}); return; }
    if (req.url === '/__load/stats') {
      json(res, { samples, loopMs: { p95: histogram.percentile(95) / 1e6, max: histogram.max / 1e6 } }); return;
    }
    if (req.url === '/__load/append') {
      appendFileSync(transcript, nextMessage());
      json(res, {}); return;
    }
    // 让真实 HTTP 请求留在服务端；不暂停事件循环，也不改产品协议。
    if (req.url === '/__load/hold-status') { heldStatus = []; json(res, {}); return; }
    if (req.url === '/__load/held-status') { json(res, { total: heldStatus?.length ?? 0 }); return; }
    if (req.url === '/__load/release-status') {
      const held = heldStatus ?? [];
      heldStatus = null;
      for (const dispatch of held) dispatch();
      json(res, { total: held.length }); return;
    }
    const kind = Object.keys(paths).find(key => req.url.split('?')[0] === paths[key].split('?')[0]);
    if (!kind) { void handler.call(app.server, req, res); return; }
    const entry = { kind, arrivedMs: performance.now() - origins, processRows: 0, usageRows: 0, parses: 0, lockWaitMs: 0 };
    samples.push(entry);
    const dispatch = () => scope.run(entry, () => handler.call(app.server, req, res));
    if (heldStatus && (kind === 'runs' || kind === 'processes')) heldStatus.push(dispatch);
    else void dispatch();
  });
  try {
    await app.ready;
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`;
    await http(base, '/api/sessions', { method: 'POST', body: { sessionId, title: '固定压测会话' } });
    for (let i = 0; i < 3; i++) await http(base, '/api/model-settings/profiles', { method: 'POST', body: {
      commandId: `load-profile-${i}`, revision: i, profile: { profileId: `fixture-${i}`, provider: 'openai',
        modelId: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o'][i], protocol: 'openai-responses', displayName: `测试模型 ${i}`, endpoint: null },
    } });
    db = new DatabaseSync(app.paths.databasePath);
    transcript = db.prepare('SELECT runtime_session_ref FROM assistant_session_binding WHERE assistant_id = ?').get(sessionId).runtime_session_ref;
    leaf = SessionManager.open(transcript, authDir, directory).getLeafId();
    const processRows = new SqliteManagedProcessRepository(db);
    const subagents = new SqliteSubagentRepository(db);
    db.exec('BEGIN');
    for (let i = 0; i <= 10_000; i++) {
      const id = `load-process-${i}`;
      processRows.save({ commandId: id, fingerprint: id, directory: '.', token: id, pid: null, ownerId: 'load',
        public: { processId: id, taskId: null, runId: null, sessionId, name: id, command: 'synthetic', revision: 1,
          state: i === 0 ? 'running' : 'exited', mode: 'background', requiredWhileRunning: false, startedAt: null,
          endedAt: null, port: null, reason: '', exitCode: i === 0 ? null : 0 } });
    }
    const child = subagentRecord('load-subagent', '.');
    child.run.parentSessionId = sessionId; child.run.status = 'succeeded'; child.run.stopConfirmed = true;
    subagents.save(child);
    db.exec(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n < 20000)
      INSERT INTO token_usage_request SELECT 'usage-' || n, '${FIXED_TIME}', 1,
        '{"tokens":{"total":8},"subagentRunId":"unrelated"}' FROM seq;
      INSERT INTO token_usage_request VALUES ('current', '${FIXED_TIME}', 1, '{"tokens":{"total":8},"subagentRunId":"load-subagent"}');
      WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n < 50000)
      INSERT INTO assistant_event_projection(source_key, assistant_id, event_type, payload_json, occurred_at)
      SELECT 'event-' || n, '${sessionId}', 'assistant.message.delta', '{}', '${FIXED_TIME}' FROM seq;
      COMMIT;`);
    const digest = createHash('sha256');
    for (const table of ['managed_process', 'token_usage_request', 'assistant_event_projection', 'subagent_run']) {
      for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) digest.update(JSON.stringify(row)).update('\n');
    }
    // 避免利用用户状态；仅对合成会话注入固定普通消息历史。
    appendFileSync(transcript, Array.from({ length: 5_000 }, nextMessage).join(''));
    await Promise.all(Object.values(paths).map(path => http(base, path)));
    histogram.enable();
    process.send({ base, digest: digest.digest('hex') });
    await once(process, 'message');
  } finally {
    histogram.disable(); db?.close(); app.server.closeAllConnections();
    await new Promise(resolveClose => app.server.close(resolveClose));
    await app.close(); rmSync(directory, { recursive: true, force: true });
    process.disconnect?.();
  }
}

async function measure(root, base, scenario, rounds) {
  const [{ RunsStore }, { ProcessesStore }, scheduler] = await Promise.all([
    load(root, 'apps/web/src/features/runs/runs-store.ts'), load(root, 'apps/web/src/features/runs/processes-store.ts'),
    load(root, 'apps/web/src/features/runs/status-refresh.ts').catch(error => {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      return null;
    }),
  ]);
  const agents = Array.from({ length: scenario.windows + 1 }, () => new Agent({ keepAlive: false }));
  const lightAgent = agents.at(-1);
  const pending = new Set();
  const windows = agents.slice(0, -1).map(agent => {
    const read = path => (_offset, signal) => {
      const result = http(base, path, { signal, agent }).then(r => r.value);
      pending.add(result); void result.then(() => pending.delete(result), () => pending.delete(result));
      return result;
    };
    const stores = [new RunsStore(read(paths.runs)), new ProcessesStore(read(paths.processes))];
    const refresh = stores.map(store => scheduler?.scheduleStatusRefresh(store) ?? { queue: () => void store.refresh(), dispose() {} });
    return { agent, refresh };
  });
  const lightTtfb = [], lightScheduledTtfb = [];
  await http(base, '/__load/reset');
  try {
    for (let round = 0; round < rounds; round++) {
      await http(base, '/__load/append');
      const start = performance.now() + 20;
      const at = offset => delay(Math.max(0, start + offset - performance.now()));
      // 客户端有独立事件循环；同时报告计划时间到响应头，区分客户端调度迟到。
      const light = Promise.all(Array.from({ length: 45 }, async (_, n) => {
        await at(n * 10); const scheduled = start + n * 10;
        const { ttfb } = await http(base, paths.light, { agent: lightAgent });
        lightTtfb.push(ttfb); lightScheduledTtfb.push(performance.now() - scheduled);
      }));
      const status = Promise.all(Array.from({ length: scenario.events }, async (_, n) => {
        await at(n * 8);
        for (const window of windows) for (const source of window.refresh) source.queue();
      }));
      await at(1);
      const auxiliary = windows.flatMap(({ agent }) => [paths.selection, paths.access, paths.subagents].map(path => http(base, path, { agent })));
      await Promise.all([light, status, ...auxiliary]);
      await Promise.allSettled([...pending]);
    }
    const { value: server } = await http(base, '/__load/stats');
    const count = kind => server.samples.filter(sample => sample.kind === kind).length;
    const select = server.samples.filter(sample => sample.kind === 'selection');
    return { ...scenario, rounds, requests: Object.fromEntries(Object.keys(paths).map(kind => [kind, count(kind)])),
      processRows: server.samples.reduce((n, sample) => n + sample.processRows, 0), usageRows: server.samples.reduce((n, sample) => n + sample.usageRows, 0),
      selectionParses: select.reduce((n, sample) => n + sample.parses, 0), selectionLockMs: stats(select.map(sample => sample.lockWaitMs)),
      loopMs: server.loopMs, lightTtfbMs: stats(lightTtfb), lightScheduledTtfbMs: stats(lightScheduledTtfb), raw: { ...server, lightTtfb, lightScheduledTtfb } };
  } finally {
    for (const window of windows) for (const source of window.refresh) source.dispose();
    for (const agent of agents) agent.destroy();
  }
}

async function checkHeldStatus(base) {
  await http(base, '/__load/hold-status');
  const abort = new AbortController();
  let completed = 0;
  const status = Promise.allSettled([paths.runs, paths.processes].map(path =>
    http(base, path, { agent: false, signal: abort.signal }).finally(() => { completed++; })));
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { value } = await http(base, '/__load/held-status');
      if (value.total === 2) break;
      assert.equal(completed, 0);
      assert.ok(attempt < 99, '未观察到两路 HTTP 查询挂起');
      await delay(10);
    }
    const { ttfb, value } = await http(base, paths.light, { agent: false });
    assert.ok(Array.isArray(value.groups));
    assert.equal(completed, 0, '独立读取必须先于两路状态查询完成');
    const released = await http(base, '/__load/release-status');
    assert.equal(released.value.total, 2);
    assert.ok((await status).every(result => result.status === 'fulfilled'));
    return { held: 2, completedBeforeRelease: 0, lightTtfbMs: ttfb };
  } finally {
    abort.abort();
    await status;
  }
}

if (process.argv[2] === '--server') await serve(process.argv[3]);
else {
  assert.ok(process.argv[2], '用法: node --import tsx scripts/performance/status-load.mjs <基线源码目录> [结果 JSON]');
  const output = resolve(process.argv[3] ?? 'artifacts/status-load.json');
  const result = { baseline: BASELINE, node: process.version, platform: process.platform, arch: process.arch, variants: {} };
  for (const [name, root] of [['baseline', resolve(process.argv[2])], ['current', process.cwd()]]) {
    const child = fork(fileURLToPath(import.meta.url), ['--server', root], { execArgv: ['--import', 'tsx'] });
    const exited = once(child, 'exit');
    try {
      const { base, digest } = await Promise.race([once(child, 'message').then(([message]) => message), exited.then(([code]) => { throw new Error(`压测服务提前退出：${code}`); })]);
      result.variants[name] = { digest, measurements: [] };
      for (const scenario of scenarios) {
        const sample = await measure(root, base, scenario, 4);
        result.variants[name].measurements.push(sample);
        const { raw: _raw, ...summary } = sample;
        console.log(name, JSON.stringify(summary));
      }
      const heldStatus = await checkHeldStatus(base);
      result.variants[name].heldStatus = heldStatus;
      console.log(name, JSON.stringify({ heldStatus }));
    } finally {
      if (child.connected) child.send('stop');
      const [code] = await exited; assert.equal(code, 0);
    }
  }
  assert.equal(result.variants.baseline.digest, result.variants.current.digest, '两组 SQL 初始数据不同');
  mkdirSync(resolve(output, '..'), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
}
