import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SubagentQueries } from '../src/application/subagent-queries.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import type { AssistantSessionBindingRepository } from '../src/modules/sessions/assistant-session.js';
import { SqliteSubagentRepository, SUBAGENT_MIGRATION } from '../src/storage/sqlite-subagent-repository.js';
import { SqliteUsageRepository } from '../src/storage/sqlite-usage-repository.js';
import { subagentRecord } from './fixtures/subagent-record.js';

test('子智能体空页不查询用量；当前页走用量索引且保留缺失语义', () => {
  const db = new DatabaseSync(':memory:');
  const adapter = new FakeCoordinatorAdapter();
  try {
    db.exec(SUBAGENT_MIGRATION);
    const runs = new SqliteSubagentRepository(db);
    const usage = new SqliteUsageRepository(db);
    for (const id of ['complete', 'partial', 'absent']) runs.save(subagentRecord(id, '.'));
    db.exec(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n < 20000)
      INSERT INTO token_usage_request SELECT 'old-' || n, 'now', 1,
        '{"subagentRunId":"off-page","tokens":{"total":100}}' FROM seq;`);
    const put = db.prepare('INSERT INTO token_usage_request VALUES (?, ?, ?, ?)');
    for (const [i, [id, total]] of [['complete', 15], ['complete', 25], ['partial', 17], ['partial', null]].entries()) {
      put.run(`usage-${i}`, 'now', Number(total !== null), JSON.stringify({ subagentRunId: id, tokens: total === null ? null : { total } }));
    }
    const prepare = db.prepare.bind(db);
    const plans: string[][] = [];
    db.prepare = sql => {
      if (sql.includes('FROM token_usage_request')) {
        const ids = ['partial', 'complete', 'absent'].slice(0, sql.split('?').length - 1);
        plans.push(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...ids).map(row => String(row.detail)));
      }
      return prepare(sql);
    };
    const client = new SubagentQueries(runs, {} as AssistantSessionBindingRepository, adapter, id => id, usage);
    assert.deepEqual(client.page({ offset: 3, limit: 2 }), { items: [], total: 3, nextOffset: null });
    assert.equal(plans.length, 0);
    const first = client.page({ offset: 0, limit: 2 });
    assert.deepEqual(first.items.map(item => [item.id, item.totalTokens]), [['partial', null], ['complete', 40]]);
    assert.equal(first.nextOffset, 2);
    assert.equal(plans.length, 1);
    assert.ok(plans[0]!.some(plan => plan.includes('SEARCH token_usage_request USING INDEX token_usage_subagent_run')), plans[0]!.join('\n'));
    assert.equal(client.page({ offset: 2, limit: 2 }).items[0]?.totalTokens, null);
  } finally { adapter.dispose(); db.close(); }
});
