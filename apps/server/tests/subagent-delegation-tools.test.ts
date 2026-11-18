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

test('同一原因连续失败 3 次后要求停止重试；成功后重新计数', async () => {
  let fail = true;
  const delegating = new SubagentDelegationTools(
    { specs: [], validate: () => ({ ok: false, reason: 'base' }), invoke: async () => ({ ok: false, reason: 'base' }) } as never,
    () => ({ delegate: async () => { if (fail) throw new Error('参数被拒'); return { id: 'run', status: 'succeeded', executor: null, outputBytes: 0, elapsedMs: 0, summary: '', changedFiles: [], commitHashes: [] }; } }) as never,
    () => [agent('general', '通用执行')], () => true, {} as never);
  const call = (toolCallId: string) => delegating.invoke({ assistantSessionId: 's', toolName: 'delegate_to_subagent', toolCallId, args: args('general') }, new AbortController().signal);
  const reason = (outcome: Awaited<ReturnType<typeof call>>) => (outcome as { reason: string }).reason;

  assert.equal(reason(await call('1')), '参数被拒');
  assert.equal(reason(await call('2')), '参数被拒');
  assert.match(reason(await call('3')), /连续出现 3 次：停止重试/);

  fail = false;
  assert.equal((await call('4')).ok, true);
  fail = true;
  assert.equal(reason(await call('5')), '参数被拒');
});
