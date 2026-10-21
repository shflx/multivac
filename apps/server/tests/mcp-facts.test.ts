import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { GLOBAL_ASSISTANT_SESSION_ID, type McpCall } from '@multivac/contracts';
import { mcpCanonical, mcpFingerprint, validateMcpTransport } from '../src/modules/mcp/mcp.js';
import { MCP_MIGRATION } from '../src/storage/sqlite-mcp-repository.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { mcpAt, mcpFixture, mcpTemporaryDirectory } from './fixtures/mcp-fixture.js';

test('MCP 事务原子提交、稳定回执与并发 revision 冲突', () => {
  const f = mcpFixture();
  try {
    const command = mcpFingerprint({ enabled: false });
    const first = f.repository.commit('disable', command, mcpAt, tx => tx.put('service', { ...f.service, revision: 2, enabled: false }, 1));
    assert.deepEqual(f.repository.commit('disable', command, mcpAt, () => assert.fail('不得重放')), first);
    assert.throws(() => f.repository.commit('disable', mcpFingerprint('different'), mcpAt, () => {}), /参数不一致/);
    assert.throws(() => f.repository.commit('stale', mcpFingerprint('stale'), mcpAt, tx => tx.put('service', { ...f.service, revision: 2 }, 1)), /已变化/);
    assert.throws(() => f.repository.commit('rollback', mcpFingerprint('rollback'), mcpAt, tx => {
      tx.put('account', { ...f.account, revision: 2, state: 'revoked' }, 1);
      throw new Error('回滚');
    }), /回滚/);
    assert.equal(f.repository.get('account', 'account')?.revision, 1);
    assert.equal(f.repository.receipt('rollback', mcpFingerprint('rollback')), null);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM mcp_event WHERE command_id=?').get('rollback')?.n, 0);
    assert.deepEqual(f.repository.serviceVersion('service', f.service.configVersion), f.service.transport);
  } finally { f.close(); }
});

test('MCP JSON、身份绑定、私有字段与不可变目录受到校验', () => {
  const f = mcpFixture();
  try {
    assert.equal(mcpCanonical({ z: 1, a: [2, false] }), mcpCanonical({ a: [2, false], z: 1 }));
    assert.throws(() => mcpFingerprint({ token: undefined }), /有限的 JSON/);
    assert.throws(() => validateMcpTransport({ kind: 'streamable-http', url: 'https://example.test/mcp?token=secret' }), /配置无效/);
    assert.throws(() => f.repository.commit('secret', mcpFingerprint('secret'), mcpAt, tx => tx.put('account', { ...f.account, revision: 2, token: 'secret' } as typeof f.account, 1)), /配置无效/);
    assert.throws(() => f.repository.commit('bad-account', mcpFingerprint('bad-account'), mcpAt, tx => tx.put('catalog', { ...f.catalog, catalogId: 'wrong', accountRevision: 99 }, 0)), /账号身份/);
    assert.throws(() => f.repository.commit('directory', mcpFingerprint('directory'), mcpAt, tx => tx.put('catalog', { ...f.catalog, revision: 2 }, 1)), /迁移冲突/);
    assert.equal(JSON.stringify(f.repository.list('account')).includes('secret'), false);
  } finally { f.close(); }
});

test('MCP 取消意图、未知结果与真实终态分开，未知不能自动重置执行', () => {
  const f = mcpFixture();
  try {
    const call: McpCall = { callId: 'call', revision: 1, identity: f.identity, argumentsFingerprint: mcpFingerprint({}), authorizationId: null,
      state: 'prepared', errorCode: null, startedAt: null, finishedAt: null, resultRef: null, resultText: null };
    f.repository.commit('prepare', mcpFingerprint('prepare'), mcpAt, tx => tx.put('call', call, 0));
    for (const [i, state] of (['running', 'cancel-requested', 'unknown'] as const).entries()) {
      const previous = f.repository.get('call', 'call')!;
      f.repository.commit(`state-${i}`, mcpFingerprint(state), mcpAt, tx => tx.put('call', { ...previous, revision: previous.revision + 1, state }, previous.revision));
    }
    const unknown = f.repository.get('call', 'call')!;
    assert.equal(unknown.state, 'unknown');
    assert.throws(() => f.repository.commit('replay', mcpFingerprint('replay'), mcpAt, tx => tx.put('call', { ...unknown, revision: 5, state: 'running' }, 4)), /迁移冲突/);
  } finally { f.close(); }
});

test('MCP 迁移可重放，旧数据库升级前备份且保留原业务数据', () => {
  const root = mcpTemporaryDirectory('migration-');
  const dbPath = path.join(root, 'test.sqlite');
  try {
    const first = new SqliteAssistantStore(dbPath); first.close();
    const db = new DatabaseSync(dbPath);
    // MCP 固定属于第 51 版；后续追加迁移不能改变旧库夹具的回退位置。
    const mcpMigrationVersion = 51;
    db.exec('DROP TABLE mcp_event; DROP TABLE mcp_command; DROP TABLE mcp_service_version; DROP TABLE mcp_fact;');
    db.prepare('DELETE FROM schema_migrations WHERE version>=?').run(mcpMigrationVersion); db.close();
    const upgraded = new SqliteAssistantStore(dbPath);
    assert.deepEqual(upgraded.mcp.list('service'), []);
    assert.ok(upgraded.sessions.get(GLOBAL_ASSISTANT_SESSION_ID));
    upgraded.close();
    assert.ok(readdirSync(root).some(file => file.endsWith('.bak')));
    const replay = new DatabaseSync(dbPath); replay.exec(MCP_MIGRATION); replay.exec(MCP_MIGRATION); replay.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
