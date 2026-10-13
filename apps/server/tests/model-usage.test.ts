import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { measuredUsage, type UsageIdentity } from '../src/modules/usage/model-usage.js';
import { SqliteUsageRepository } from '../src/storage/sqlite-usage-repository.js';
import { ModelUsageService } from '../src/application/model-usage-service.js';
import { usageModelRuntime } from '../src/runtime/executors/usage-model-runtime.js';

const response = (extra = {}) => ({ role: 'assistant', stopReason: 'stop', timestamp: 1000,
  usage: { input: 100, cacheWrite: 20, cacheRead: 80, output: 40, reasoning: 10, totalTokens: 240 }, ...extra });
const identity = (sessionId: string): Omit<UsageIdentity, 'provider' | 'modelId' | 'piSessionId'> => ({ sessionId, sessionTitle: sessionId,
  projectId: null, projectKnown: true, projectName: null, source: sessionId === 'global' ? 'multivac' : sessionId === 'task' ? 'task' : 'session' });

test('权威 usage 不依赖费用，缓存写入并入输入，推理不重复相加', () => {
  assert.deepEqual(measuredUsage(response()).tokens, { input: 120, cacheRead: 80, output: 40, total: 240 });
  assert.equal(measuredUsage(response()).raw?.reasoning, 10);
  for (const usage of [undefined, { input: -1 }, { ...response().usage, totalTokens: 241 }, { ...response().usage, reasoning: 41 }, { ...response().usage, input: NaN }]) {
    assert.equal(measuredUsage(response({ usage })).tokens, null);
  }
});

test('失败取消的正数 usage 计入，全零占位与真实成功零值有区别', () => {
  assert.equal(measuredUsage(response({ stopReason: 'aborted' })).tokens?.total, 240);
  assert.equal(measuredUsage(response({ stopReason: 'error' })).tokens?.total, 240);
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  assert.equal(measuredUsage(response({ stopReason: 'error', usage: zero })).tokens, null);
  assert.equal(measuredUsage(response({ stopReason: 'aborted', usage: zero })).tokens, null);
  assert.equal(measuredUsage(response({ usage: zero })).tokens?.total, 0);
});

test('同轮三个来源多次请求、重复终态与仓库恢复不重计，归属冻结', () => {
  const db = new DatabaseSync(':memory:');
  const repo = new SqliteUsageRepository(db, '2026-10-01T00:00:00.000Z');
  const service = new ModelUsageService(repo, identity, () => '2026-10-02T00:00:00.000Z');
  try {
    for (const session of ['global', 'work', 'task']) {
      for (let i = 0; i < 3; i++) {
        const finish = service.begin(session, `pi-${session}`, { provider: 'p', id: 'm' });
        const message = response(); finish(message); finish(message);
      }
    }
    assert.equal(repo.records().length, 9);
    assert.equal(repo.records().reduce((sum, record) => sum + record.tokens!.total, 0), 2160);
    assert.deepEqual(new Set(repo.records().map(record => record.source)), new Set(['multivac', 'session', 'task']));
    const recovered = new SqliteUsageRepository(db);
    for (const record of repo.records()) recovered.put({ ...record, sessionTitle: '改名后', projectId: 'moved', tokens: null });
    assert.equal(recovered.records().length, 9);
    assert.equal(recovered.records()[0].projectId, null);
    assert.notEqual(recovered.records()[0].sessionTitle, '改名后');
  } finally { service.close(); db.close(); }
});

test('运行时只调用一次原实现，complete 与 stream 终态均采集且可保存标记', async () => {
  const db = new DatabaseSync(':memory:');
  const service = new ModelUsageService(new SqliteUsageRepository(db), identity);
  let calls = 0;
  const runtime = {
    complete: async () => { calls++; return response(); },
    stream: () => {
      calls++;
      const message = response();
      return { result: async () => message, async *[Symbol.asyncIterator]() { yield { type: 'done', message }; } };
    },
  } as unknown as ModelRuntime;
  const wrapped = usageModelRuntime(runtime, 'work', 'pi-work', service);
  try {
    const complete = await (wrapped.complete as Function)({ provider: 'p', id: 'm' }, {});
    const stream = (wrapped.stream as Function)({ provider: 'p', id: 'm' }, {});
    for await (const event of stream) assert.ok(event.message.multivacUsage.requestId);
    await stream.result();
    assert.ok(complete.multivacUsage.requestId);
    assert.equal(calls, 2);
    assert.equal(service.repository.records().length, 2);
  } finally { service.close(); db.close(); }
});

test('调用拒绝和未收到终态保留缺失请求，测量回补不能被缺失记录降级', () => {
  const db = new DatabaseSync(':memory:');
  const repo = new SqliteUsageRepository(db);
  const service = new ModelUsageService(repo, identity);
  try {
    service.begin('work', 'pi', { provider: 'p', id: 'm' })(undefined, new Error('cancelled'));
    service.begin('work', 'pi', { provider: 'p', id: 'm' });
    assert.equal(repo.records().length, 2);
    assert.ok(repo.records().every(record => record.tokens === null));
    const pending = repo.records().find(record => record.outcome === 'pending')!;
    repo.put({ ...pending, ...measuredUsage(response()), origin: 'history' });
    repo.put(pending);
    assert.equal(repo.records().find(record => record.requestId === pending.requestId)?.tokens?.total, 240);
  } finally { service.close(); db.close(); }
});
