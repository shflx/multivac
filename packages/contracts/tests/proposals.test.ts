import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import {
  DecideProposalSchema,
  ExampleRenameSessionPayloadSchema,
  ProposalListResponseSchema,
  ProposalSchema,
  WorkbenchEventSchema,
  proposalSettled,
} from '../src/index.js';

const proposal = {
  proposalId: '7c0d6b1e-0000-4000-8000-000000000001',
  sessionId: 'global-coordinator',
  commandId: 'turn-1',
  toolCallId: 'call-1',
  kind: 'example.rename_session',
  title: '把会话「甲」改名为「乙」',
  payload: { sessionId: 'session-a', title: '乙' },
  preview: { currentTitle: '甲', workspaceName: '默认工作区' },
  problem: null,
  status: 'pending',
  outcome: null,
  reason: null,
  createdAt: '2026-09-30T08:00:00.000Z',
  decidedAt: null,
};

test('提议：状态、结果与原因按白名单；种类写法受限；多余字段不接受', () => {
  assert.equal(Check(ProposalSchema, proposal), true);
  assert.equal(Check(ProposalSchema, {
    ...proposal, status: 'executed', decidedAt: '2026-09-30T08:01:00.000Z',
    outcome: { summary: '改名为「乙」', refs: [{ kind: 'session', sessionId: 'session-a', label: '乙' }] },
  }), true);
  assert.equal(Check(ProposalSchema, { ...proposal, status: 'expired', reason: '会话已被改名为「丙」。' }), true);
  assert.equal(Check(ProposalSchema, { ...proposal, status: 'approved' }), false);
  assert.equal(Check(ProposalSchema, { ...proposal, kind: 'Rename Session' }), false);
  assert.equal(Check(ProposalSchema, { ...proposal, outcome: { summary: '好', refs: [], content: '正文' } }), false);
  assert.equal(Check(ProposalSchema, { ...proposal, extra: true }), false);
  assert.equal(Check(ProposalListResponseSchema, { proposals: [proposal] }), true);
  assert.equal(Check(ExampleRenameSessionPayloadSchema, proposal.payload), true);
  assert.equal(Check(ExampleRenameSessionPayloadSchema, { ...proposal.payload, title: '' }), false);
});

test('提议的决定只有确认与取消；有定论的状态不再变化；工作台事件带提议快照', () => {
  assert.equal(Check(DecideProposalSchema, { decision: 'confirm' }), true);
  assert.equal(Check(DecideProposalSchema, { decision: 'cancel' }), true);
  assert.equal(Check(DecideProposalSchema, { decision: 'approve' }), false);
  assert.equal(Check(DecideProposalSchema, { decision: 'confirm', payload: {} }), false);
  assert.deepEqual(
    (['pending', 'executing', 'executed', 'cancelled', 'expired', 'failed'] as const).map(proposalSettled),
    [false, false, true, true, true, true],
  );
  const origin = { windowId: null, commandId: 'turn-1' };
  assert.equal(Check(WorkbenchEventSchema, { type: 'proposal.changed', seq: 1, origin, change: 'created', proposal }), true);
  assert.equal(Check(WorkbenchEventSchema, { type: 'proposal.changed', seq: 1, origin, change: 'deleted', proposal }), false);
});
