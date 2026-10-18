import test from 'node:test';
import assert from 'node:assert/strict';
import { McpRules, McpRuleService, type McpRuleContext } from '../src/modules/mcp/rules.js';
import { mcpFingerprint } from '../src/modules/mcp/mcp.js';
import { mcpAt, mcpFixture } from './fixtures/mcp-fixture.js';

const context: McpRuleContext = { sessionId: 'session', projectId: 'project', agentId: 'agent', taskId: null, runId: null,
  host: 'work', hostEffects: ['read', 'local-write', 'external-write', 'data-transfer'], transportAllowed: true, accountId: 'account' };

test('MCP 项目排除、智能体上限、会话停用与宿主权限取交集，偏好不扩权', () => {
  for (let mask = 0; mask < 16; mask++) {
    const f = mcpFixture();
    const rules = new McpRules(f.repository), settings = new McpRuleService(f.repository, { validate() {} }, () => mcpAt);
    try {
      settings.set('project', 'service', 0, { kind: 'project', projectId: 'project', excluded: !!(mask & 1), accountId: 'account' });
      settings.set('agent', 'service', 0, { kind: 'agent', agentId: 'agent', preferred: true, effectCeiling: mask & 2 ? ['read'] : ['read', 'external-write'] });
      settings.set('session', 'service', 0, { kind: 'session', sessionId: 'session', disabled: !!(mask & 4) });
      const result = rules.resolve('service', { ...context, transportAllowed: !(mask & 8) }, ['external-write']);
      assert.equal(result.available, mask === 0);
      assert.equal(result.preferred, true);
      assert.equal(result.ruleVersions.length, 3);
      assert.ok(mask === 0 || result.details.length > 0);
    } finally { f.close(); }
  }
});

test('MCP 项目账号不静默回落，撤销及同服务不同账号被准确拒绝', () => {
  const f = mcpFixture(), rules = new McpRules(f.repository), settings = new McpRuleService(f.repository, { validate() {} }, () => mcpAt);
  try {
    const missing = settings.set('empty', 'service', 0, { kind: 'project', projectId: 'project', excluded: false, accountId: null });
    assert.equal(rules.resolve('service', context).available, false);
    assert.equal(rules.resolve('service', context).accountId, null);
    const chosen = settings.set('choose', 'service', missing.revision, { kind: 'project', projectId: 'project', excluded: false, accountId: 'account' });
    assert.equal(rules.resolve('service', context).available, true);
    assert.throws(() => settings.set('stale', 'service', 1, chosen.target), /已变化/);
    f.repository.commit('second', mcpFingerprint('second'), mcpAt, tx => tx.put('account', { ...f.account, accountId: 'other' }, 0));
    assert.equal(rules.resolve('service', { ...context, accountId: 'other' }).available, false);
    f.repository.commit('revoke', mcpFingerprint('revoke'), mcpAt, tx => tx.put('account', { ...f.account, revision: 2, state: 'revoked' }, 1));
    assert.equal(rules.resolve('service', context).available, false);
    assert.throws(() => settings.set('revoked', 'service', chosen.revision, { kind: 'project', projectId: 'project', excluded: false, accountId: 'account' }), /已撤销/);
  } finally { f.close(); }
});

test('MCP 发送快照在项目/智能体/运行/规则变化后失效，临时停用恢复保持且不串会话', () => {
  const f = mcpFixture(), settings = new McpRuleService(f.repository, { validate() {} }, () => mcpAt);
  try {
    const rules = new McpRules(f.repository);
    const identity = { ...f.identity, projectId: 'project', agentId: 'agent', ruleVersions: rules.resolve('service', context).ruleVersions };
    rules.assert(identity, context, ['read']);
    for (const changed of [{ ...context, projectId: 'other' }, { ...context, agentId: 'other' }, { ...context, taskId: 'task', runId: 'run' }])
      assert.throws(() => rules.assert(identity, changed, ['read']), /身份已变化/);
    const stopped = settings.set('stop', 'service', 0, { kind: 'session', sessionId: 'session', disabled: true });
    assert.equal(new McpRules(f.repository).resolve('service', context).available, false);
    assert.equal(rules.resolve('service', { ...context, sessionId: 'new-session' }).available, true);
    settings.set('enable', 'service', stopped.revision, { kind: 'session', sessionId: 'session', disabled: false });
    assert.throws(() => rules.assert(identity, context, ['read']), /规则版本已变化/);
    settings.set('exclude', 'service', 0, { kind: 'project', projectId: 'project', excluded: true, accountId: 'account' });
    assert.equal(rules.resolve('service', context).available, false);
  } finally { f.close(); }
});

test('MCP 不同宿主不能越过效果边界，数据传输不隐含授予写入', () => {
  const f = mcpFixture(), rules = new McpRules(f.repository);
  try {
    const coordinator = { ...context, host: 'coordinator' as const };
    assert.equal(rules.resolve('service', coordinator, ['read', 'data-transfer']).available, true);
    assert.equal(rules.resolve('service', coordinator, ['local-write']).available, false);
    assert.equal(rules.resolve('service', { ...context, host: 'task', hostEffects: ['read', 'local-write'], transportAllowed: false }, ['read']).available, false);
    assert.equal(rules.resolve('service', { ...context, hostEffects: ['read', 'data-transfer'] }, ['external-write']).available, false);
    const settings = new McpRuleService(f.repository, { validate() { throw new Error('对象不属于当前实例'); } });
    assert.throws(() => settings.set('invalid-owner', 'service', 0, { kind: 'session', sessionId: 'missing', disabled: false }), /当前实例/);
    assert.deepEqual(f.repository.list('rule'), []);
  } finally { f.close(); }
});
