import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_WORKSPACE_ID } from '@multivac/contracts';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { SESSION_ACTIVITY_MIGRATION, SqliteSessionRegistryRepository } from '../src/storage/sqlite-session-registry-repository.js';

test('长历史活动时间走逆序索引，保留事件口径、创建时间回退和列表排序', t => {
  const root = mkdtempSync(join(tmpdir(), 'multivac-activity-query-'));
  const path = join(root, 'app.sqlite');
  const store = new SqliteAssistantStore(path);
  const db = new DatabaseSync(path);
  try {
    const createdAt = '2026-01-01T00:00:00.000Z';
    for (const id of ['a', 'b']) {
      store.sessions.insertIfAbsent({ sessionId: id, title: id, kind: 'work', workspaceId: DEFAULT_WORKSPACE_ID,
        createdAt, workingDirectory: { kind: 'session-temp', path: root } });
      store.bindings.insertIfAbsent({ assistantSessionId: id, harness: 'pi', runtimeSessionRef: `${root}/${id}.jsonl`, runtimeSessionId: `pi-${id}`, updatedAt: createdAt });
    }
    const seed = `WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n < 50000)
      INSERT INTO assistant_event_projection(source_key, assistant_id, event_type, payload_json, occurred_at)
      SELECT 'event-' || n, 'a', CASE WHEN n % 5 = 0 THEN 'assistant.context.compacted' ELSE 'assistant.message.delta' END,
        '{}', strftime('%Y-%m-%dT%H:%M:%fZ', '2026-05-01', '-' || n || ' seconds') FROM seq;`;
    const timed = (operation: () => void) => { const start = performance.now(); operation(); return performance.now() - start; };
    const write = (indexed: boolean) => {
      db.exec('DELETE FROM assistant_event_projection');
      db.exec('DROP INDEX IF EXISTS assistant_event_projection_latest_activity');
      if (indexed) db.exec(SESSION_ACTIVITY_MIGRATION);
      return timed(() => db.exec(seed));
    };
    const oldWrite = write(false);
    const legacy = db.prepare(`SELECT max(occurred_at) AS at FROM assistant_event_projection WHERE assistant_id = ?
      AND event_type IN ('assistant.command.handed_to_pi', 'assistant.message.delta', 'assistant.turn.started', 'assistant.turn.ended', 'assistant.tool.ended')`);
    const expected = legacy.get('a')!.at;
    const before = timed(() => { for (let i = 0; i < 50; i++) legacy.get('a'); });
    const newWrite = write(true);
    const prepare = db.prepare.bind(db);
    let plan: string[] = [];
    db.prepare = sql => {
      if (sql.includes('ORDER BY e.occurred_at')) plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all('a').map(row => String(row.detail));
      return prepare(sql);
    };
    const repo = new SqliteSessionRegistryRepository(db);
    assert.equal(repo.get('a')?.lastActivityAt, expected);
    assert.ok(plan.some(detail => /SEARCH e USING (?:COVERING )?INDEX assistant_event_projection_latest_activity/.test(detail)), plan.join('\n'));
    assert.ok(!plan.some(detail => detail.includes('TEMP B-TREE')), plan.join('\n'));
    db.prepare = prepare;
    const after = timed(() => { for (let i = 0; i < 50; i++) repo.get('a'); });
    assert.deepEqual(repo.list(DEFAULT_WORKSPACE_ID, 'work').map(session => [session.sessionId, session.lastActivityAt]), [['a', expected], ['b', createdAt]]);
    t.diagnostic(`50 次旧聚合/新完整读取：${before.toFixed(2)}/${after.toFixed(2)} ms；5 万次写入（旧/新）：${oldWrite.toFixed(2)}/${newWrite.toFixed(2)} ms`);
  } finally { db.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
