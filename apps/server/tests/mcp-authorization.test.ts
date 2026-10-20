import test from 'node:test';
import assert from 'node:assert/strict';
import { McpAuthorizationService } from '../src/application/mcp-authorization-service.js';
import { InboxService } from '../src/application/inbox-service.js';
import type { HumanRequestService } from '../src/application/human-request-service.js';
import type { ToolAuthorizationService } from '../src/application/tool-authorization-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { INBOX_MIGRATION, SqliteInboxRepository } from '../src/storage/sqlite-inbox-repository.js';
import { mcpFingerprint } from '../src/modules/mcp/mcp.js';
import { validateMcpArguments } from '../src/modules/mcp/arguments.js';
import { mcpAt, mcpFixture } from './fixtures/mcp-fixture.js';

function fixture() {
  const f = mcpFixture(); let clock = Date.parse(mcpAt), allowed = true, catalog = f.catalog;
  const permits = new McpAuthorizationService(f.repository, { catalog: () => catalog, allowsUnclassified: () => false, async verify() { if (!allowed) throw new Error('宿主拒绝'); } }, () => {}, () => clock);
  f.db.exec(INBOX_MIGRATION);
  const inbox = new InboxService({ list: () => [] } as unknown as HumanRequestService, { all: () => [] } as unknown as ToolAuthorizationService,
    new SqliteInboxRepository(f.db), new WorkbenchEvents(), undefined, undefined, permits);
  return { ...f, permits, inbox, deny: () => { allowed = false; }, advance: () => { clock += 11 * 60_000; }, changeCatalog: () => { catalog = { ...catalog, version: mcpFingerprint('changed') }; } };
}

test('MCP readOnlyHint 不授予分类或执行许可；真实 Inbox 决定固定本次身份参数', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.permits.request(f.identity, {}), /尚未由用户确认/);
    f.permits.confirmClassification('user-classification', f.identity, ['read']);
    const request = await f.permits.request(f.identity, {});
    const repeated = await f.permits.request(f.identity, {});
    assert.equal(repeated.requestId, request.requestId);
    assert.equal(f.inbox.page().pendingCount, 1);
    assert.deepEqual(f.inbox.get(`mcp:${request.requestId}`).mcp?.arguments, {});
    await assert.rejects(f.permits.authorize(request.requestId, f.identity, {}), /不适用于/);
    await assert.rejects(f.inbox.respond(`mcp:${request.requestId}`, { commandId: 'model-approve', revision: 1, decision: 'once' }), /只能由用户在界面/);
    const decided = await f.inbox.decide(`mcp:${request.requestId}`, { commandId: 'real-ui', revision: 1, decision: 'once' });
    assert.equal(decided.mcp?.status, 'allowed');
    assert.equal(f.inbox.page().pendingCount, 0);
    await f.permits.authorize(request.requestId, f.identity, {});
    await assert.rejects(f.permits.authorize(request.requestId, f.identity, { changed: true }), /不适用于/);
    await assert.rejects(f.permits.request(f.identity, { changed: true }), /参数不一致/);
    assert.equal((await f.inbox.decide(`mcp:${request.requestId}`, { commandId: 'real-ui', revision: 1, decision: 'once' })).mcp?.status, 'allowed');
    await assert.rejects(f.inbox.decide(`mcp:${request.requestId}`, { commandId: 'late-reject', revision: 1, decision: 'deny' }), /已终结/);
    f.permits.revoke('user-revoke', request.requestId, 2);
    await assert.rejects(f.permits.authorize(request.requestId, f.identity, {}), /不适用于/);
    assert.equal(f.inbox.get(`mcp:${request.requestId}`).status, 'invalidated');
  } finally { f.close(); }
});

test('MCP 授权过期、配置/账号/目录及宿主变化不能被旧决定绕过', async () => {
  for (const change of ['time', 'account', 'catalog', 'host'] as const) {
    const f = fixture();
    try {
      f.permits.confirmClassification('classify', f.identity, ['read']);
      const request = await f.permits.request(f.identity, {});
      if (change === 'time') f.advance();
      if (change === 'catalog') f.changeCatalog();
      if (change === 'host') f.deny();
      if (change === 'account') f.repository.commit('revoke', mcpFingerprint('revoke'), mcpAt, tx => tx.put('account', { ...f.account, revision: 2, state: 'revoked' }, 1));
      const decision = await f.permits.decide(request.requestId, 1, 'once', 'decision');
      assert.equal(decision.status, change === 'time' ? 'expired' : 'invalidated');
      await assert.rejects(f.permits.authorize(request.requestId, f.identity, {}));
    } finally { f.close(); }
  }
});

test('MCP 用户拒绝、取消与恢复使待确认终结，全局 Multivac 不取得写工具', async () => {
  const f = fixture();
  try {
    f.permits.confirmClassification('classify', f.identity, ['external-write']);
    await assert.rejects(f.permits.request({ ...f.identity, host: 'coordinator' }, {}), /不开放第三方写/);
    const request = await f.permits.request(f.identity, {});
    await f.permits.decide(request.requestId, 1, 'deny', 'deny');
    await assert.rejects(f.permits.authorize(request.requestId, f.identity, {}));
    const next = await f.permits.request({ ...f.identity, toolCallId: 'next' }, {});
    f.permits.cancelSession('session');
    assert.equal(f.permits.get(next.requestId).status, 'cancelled');
    const restart = await f.permits.request({ ...f.identity, toolCallId: 'restart' }, {});
    f.permits.invalidatePending();
    assert.equal(f.permits.get(restart.requestId).status, 'invalidated');
  } finally { f.close(); }
});

test('MCP 参数 Schema 有界校验，不忽略不支持的引用或正则约束', () => {
  const schema = { type: 'object', properties: { count: { type: 'integer', minimum: 1 }, action: { enum: ['read'] } }, required: ['action'], additionalProperties: false };
  validateMcpArguments(schema, { action: 'read', count: 1 });
  assert.throws(() => validateMcpArguments(schema, { action: 'write', count: 1 }), /不符合/);
  assert.throws(() => validateMcpArguments(schema, { action: 'read', count: 0 }), /不符合/);
  assert.throws(() => validateMcpArguments(schema, { action: 'read', added: true }), /不符合/);
  assert.throws(() => validateMcpArguments({ type: 'object', properties: { ignored: { pattern: '(a+)+' } } }, {}), /支持范围/);
  assert.throws(() => validateMcpArguments({ $ref: 'https://external.test/schema' }, {}), /支持范围/);
});
