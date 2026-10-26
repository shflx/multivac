import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Check } from 'typebox/value';
import { UsageStatisticsSchema } from '@multivac/contracts';
import { SqliteUsageRepository } from '../src/storage/sqlite-usage-repository.js';
import { ModelUsageService } from '../src/application/model-usage-service.js';
import { UsageStatisticsService } from '../src/application/usage-statistics-service.js';
import { measuredUsage } from '../src/modules/usage/model-usage.js';

const identity = (sessionId: string) => ({ sessionId, sessionTitle: '新会话', source: 'session' as const, projectId: null, projectKnown: true, projectName: null });
const response = () => ({ role: 'assistant', stopReason: 'stop', usage: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40, totalTokens: 100 } });

test('独立账本不读取旧记录和旧覆盖元数据，新调用才进入统计', () => {
  const db = new DatabaseSync(':memory:');
  try {
    // 故意放入无法解析的旧内容，确保新查询没有旧账本读取或兼容分支。
    db.exec(`CREATE TABLE model_usage (request_id TEXT PRIMARY KEY, started_at TEXT, session_id TEXT, measured INTEGER, record_json TEXT);
      INSERT INTO model_usage VALUES ('old', NULL, 'old', 1, 'invalid old record');
      CREATE TABLE model_usage_meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO model_usage_meta VALUES ('historyUnplaced', '999'), ('collectionFailure', '旧错误');`);
    const repo = new SqliteUsageRepository(db);
    const usage = new ModelUsageService(repo, identity, () => '2026-10-13T08:00:00.000Z');
    const statistics = new UsageStatisticsService(usage, () => undefined, () => '2026-10-13T12:00:00.000Z');
    const empty = statistics.query(30, 'UTC');
    assert.equal(empty.summary.requests, 0);
    assert.equal(empty.summary.total, 0);
    assert.deepEqual(empty.warnings, []);
    assert.equal(Check(UsageStatisticsSchema, empty), true);
    const message = response();
    const finish = usage.begin('new', 'pi-new', { provider: 'p', id: 'm' });
    finish(message); finish(message);
    const result = statistics.query(30, 'UTC');
    assert.equal(result.summary.requests, 1);
    assert.equal(result.summary.total, 100);
    assert.equal(result.dailyAverage, 100);
    assert.equal(result.statisticsDays, 1);
    assert.deepEqual(result.warnings, []);
    assert.equal(Check(UsageStatisticsSchema, result), true);
    assert.deepEqual(message, response());
    assert.equal((db.prepare('SELECT count(*) AS count FROM model_usage').get()!).count, 1);
  } finally { db.close(); }
});

test('新账本和首次采集时间在重开后保留，不在重启时重新起算', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-token-usage-'));
  const path = join(root, 'usage.sqlite');
  let db = new DatabaseSync(path);
  try {
    const usage = new ModelUsageService(new SqliteUsageRepository(db), identity, () => '2026-10-12T08:00:00.000Z');
    usage.begin('s', 'pi', { provider: 'p', id: 'm' })(response());
    usage.begin('failed', 'pi', { provider: 'p', id: 'm' })(undefined, new Error('request failed'));
    usage.begin('cancelled', 'pi', { provider: 'p', id: 'm' })(undefined, { name: 'AbortError' });
    usage.begin('pending', 'pi', { provider: 'p', id: 'm' });
    const pending = usage.repository.records().find(item => item.outcome === 'pending')!;
    db.close(); db = new DatabaseSync(path);
    const restarted = new ModelUsageService(new SqliteUsageRepository(db), identity, () => '2026-10-13T08:00:00.000Z');
    assert.equal(restarted.repository.collectionStartedAt(), '2026-10-12T08:00:00.000Z');
    const statistics = new UsageStatisticsService(restarted, () => undefined, () => '2026-10-13T12:00:00.000Z');
    const result = statistics.query(30, 'UTC');
    assert.equal(result.statisticsDays, 2);
    assert.equal(result.summary.requests, 4);
    assert.equal(result.summary.measuredRequests, 1);
    assert.equal(result.summary.missingRequests, 0);
    assert.equal(result.summary.total, 100);
    assert.equal(result.dailyAverage, 50);
    assert.deepEqual(result.warnings, []);
    assert.equal(Check(UsageStatisticsSchema, result), true);
    // 不清库、不结算历史 pending；真实终态补入同一请求后查询立即生效，重放不重计。
    const completed = { ...pending, ...measuredUsage(response()) };
    restarted.repository.put(completed);
    restarted.repository.put(completed);
    restarted.repository.put(pending);
    const refreshed = statistics.query(30, 'UTC');
    assert.equal(refreshed.summary.requests, 4);
    assert.equal(refreshed.summary.measuredRequests, 2);
    assert.equal(refreshed.summary.missingRequests, 0);
    assert.equal(refreshed.summary.total, 200);
    assert.equal(refreshed.dailyAverage, 100);
    assert.deepEqual(refreshed.warnings, []);
    assert.equal(Check(UsageStatisticsSchema, refreshed), true);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test('未接入采集时不登记启用时间，当前采集写入异常有明确提示', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const repo = new SqliteUsageRepository(db);
    const disabled = new ModelUsageService(repo, identity, undefined, false);
    disabled.begin('s', 'pi', { provider: 'p', id: 'm' })(response());
    assert.equal(repo.collectionStartedAt(), null);
    assert.equal(repo.records().length, 0);
    assert.match(disabled.warning!, /没有接入/);
    const usage = new ModelUsageService(repo, identity);
    db.exec(`CREATE TRIGGER fail_usage BEFORE INSERT ON token_usage_request BEGIN SELECT RAISE(FAIL, 'test failure'); END;`);
    usage.begin('s', 'pi', { provider: 'p', id: 'm' })(response());
    const result = new UsageStatisticsService(usage, () => undefined).query(7, 'UTC');
    assert.match(result.warnings.join(''), /记录发生错误/);
    assert.equal(result.dailyAverage, null);
    assert.equal(result.delta, null);
  } finally { db.close(); }
});
