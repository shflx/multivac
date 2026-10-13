import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { SqliteUsageRepository } from '../src/storage/sqlite-usage-repository.js';
import { ModelUsageService } from '../src/application/model-usage-service.js';
import { UsageHistoryBackfill } from '../src/application/usage-history-backfill.js';
import type { CoordinatorSessionBinding } from '@multivac/contracts';

const old = () => ({ title: '旧会话', source: 'unknown' as const, projectId: null, projectKnown: false, projectName: null });
const assistant = (timestamp: number) => ({ role: 'assistant', provider: 'p', model: 'm', timestamp, stopReason: 'stop',
  usage: { input: 20, cacheRead: 10, cacheWrite: 5, output: 5, totalTokens: 40 } });

test('历史全entries回补、分支外记录、重复回补和损坏尾部，不改写Pi文件', async () => {
  await mkdir(resolve('.tmp'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp/usage-history-'));
  const db = new DatabaseSync(':memory:');
  try {
    const repo = new SqliteUsageRepository(db, '2026-10-01T00:00:00.000Z');
    const path = join(root, 'pi.jsonl');
    const binding: CoordinatorSessionBinding = { assistantSessionId: 's', piSessionId: 'pi', piSessionPath: path, updatedAt: '2026-10-01T00:00:00.000Z' };
    const text = [JSON.stringify({ type: 'session', id: 'pi' }),
      JSON.stringify({ type: 'message', id: 'a', parentId: null, message: assistant(Date.parse('2026-09-01T01:00:00Z')) }),
      JSON.stringify({ type: 'message', id: 'b', parentId: null, message: assistant(Date.parse('2026-09-01T02:00:00Z')) }), '{incomplete'].join('\n');
    await writeFile(path, text);
    const backfill = new UsageHistoryBackfill(repo, root);
    await backfill.scan([binding], old); await backfill.scan([binding], old);
    assert.equal(repo.records().length, 2);
    assert.equal(repo.records().reduce((sum, record) => sum + record.tokens!.total, 0), 80);
    assert.ok(repo.records().every(record => !record.projectKnown && record.source === 'unknown'));
    assert.equal(await readFile(path, 'utf8'), text);
    assert.equal(repo.meta('history'), 'partial');
    assert.match(repo.meta('historyReasons')!, /损坏/);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test('实时响应标记与历史回补共用身份，启用后无标记条目不冒险重复计入', async () => {
  await mkdir(resolve('.tmp'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp/usage-marker-'));
  const db = new DatabaseSync(':memory:');
  const repo = new SqliteUsageRepository(db, '2026-10-01T00:00:00.000Z');
  const service = new ModelUsageService(repo, sessionId => ({ sessionId, sessionTitle: '真实会话', source: 'session', projectId: 'p', projectName: '原项目', projectKnown: true }), () => '2026-10-02T00:00:00.000Z');
  try {
    const message = assistant(Date.parse('2026-10-02T00:00:00Z'));
    service.begin('s', 'pi', { provider: 'p', id: 'm' })(message);
    const path = join(root, 'pi.jsonl');
    await writeFile(path, [JSON.stringify({ type: 'session', id: 'pi' }),
      JSON.stringify({ type: 'message', id: 'a', message }),
      JSON.stringify({ type: 'message', id: 'b', message: assistant(Date.parse('2026-10-03T00:00:00Z')) })].join('\n'));
    const binding = { assistantSessionId: 's', piSessionId: 'pi', piSessionPath: path, updatedAt: '2026-10-01T00:00:00.000Z' };
    const backfill = new UsageHistoryBackfill(repo, root);
    await backfill.scan([binding], old); await backfill.scan([binding], old);
    assert.equal(repo.records().length, 1);
    assert.equal(repo.records()[0].projectId, 'p');
    assert.equal(repo.records()[0].tokens!.total, 40);
    assert.match(repo.meta('historyReasons')!, /无稳定调用标记/);
  } finally { service.close(); db.close(); await rm(root, { recursive: true, force: true }); }
});

test('绑定头不匹配、时间缺失与目录外文件有明确覆盖说明', async () => {
  await mkdir(resolve('.tmp'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp/usage-invalid-'));
  const db = new DatabaseSync(':memory:');
  try {
    const repo = new SqliteUsageRepository(db, '2026-10-01T00:00:00.000Z');
    const path = join(root, 'wrong.jsonl');
    await writeFile(path, JSON.stringify({ type: 'session', id: 'another-pi' }));
    await new UsageHistoryBackfill(repo, root).scan([{ assistantSessionId: 's', piSessionId: 'pi', piSessionPath: path, updatedAt: '2026-10-01T00:00:00.000Z' }], old);
    assert.equal(repo.records().length, 0);
    assert.match(repo.meta('historyReasons')!, /文件头/);
    await writeFile(path, [JSON.stringify({ type: 'session', id: 'pi' }), JSON.stringify({ type: 'message', id: 'no-time', message: { ...assistant(0), timestamp: null } })].join('\n'));
    await new UsageHistoryBackfill(repo, root).scan([{ assistantSessionId: 's', piSessionId: 'pi', piSessionPath: path, updatedAt: '2026-10-01T00:00:00.000Z' }], old);
    assert.equal(repo.meta('historyUnplaced'), '1');
    assert.equal(repo.records().length, 0);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
