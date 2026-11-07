import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent } from '@multivac/contracts';
import { SubagentDelegationTools } from '../src/application/subagent-delegation-tools.js';

const agent = (agentId: string, name: string) => ({ agentId, name, delegable: true, fixed: false, description: '适合独立检查' }) as Agent;
const tools = new SubagentDelegationTools(
  { specs: [], validate: () => ({ ok: false, reason: 'base' }), invoke: async () => ({ ok: false, reason: 'base' }) } as never,
  () => { throw new Error('不应执行'); }, () => [agent('5c84f9f8', 'debugger'), agent('general', '通用执行')], () => true, {} as never);
const args = (agentId: string) => ({ agentId, mode: 'read', goal: '检查', context: '', deliverable: '结论', reason: '独立检查' });

test('委派 agentId 填写智能体名称时按唯一候选换成真实 agentId', () => {
  assert.deepEqual(tools.validate('delegate_to_subagent', args('5c84f9f8')), { ok: true, value: args('5c84f9f8') });
  assert.deepEqual(tools.validate('delegate_to_subagent', args('Debugger')), { ok: true, value: args('5c84f9f8') });
});

test('未知 agentId 被拒绝，并列出可用 agentId 与名称', () => {
  const result = tools.validate('delegate_to_subagent', args('reviewer'));
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /5c84f9f8（debugger）、general（通用执行）/);
});
