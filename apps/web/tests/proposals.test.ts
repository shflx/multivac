import assert from 'node:assert/strict';
import test from 'node:test';
import type { Proposal, ProposalDecision } from '@multivac/contracts';
import { AssistantApiError } from '../src/data/assistant-api.js';
import { Proposals, proposalDecisionError, proposalReceipt } from '../src/features/proposals/proposals.js';

function proposal(proposalId: string, overrides: Partial<Proposal> = {}): Proposal {
  return {
    proposalId, sessionId: 'global-coordinator', commandId: 'turn-1', toolCallId: `call-${proposalId}`,
    kind: 'example.rename_session', title: '把会话「甲」改名为「乙」', payload: {}, preview: {}, problem: null,
    status: 'pending', outcome: null, reason: null, createdAt: '2026-09-30T08:00:00.000Z', decidedAt: null,
    ...overrides,
  };
}

/** 可以手动决定何时返回的请求。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('共享的提议：首次显示只读一次；有定论的状态不被较早的待确认快照覆盖；读取期间推送来的提议落地时补上', async () => {
  const reads: Array<ReturnType<typeof deferred<readonly Proposal[]>>> = [];
  const store = new Proposals({
    list: () => {
      const read = deferred<readonly Proposal[]>();
      reads.push(read);
      return read.promise;
    },
    decide: async () => { throw new Error('本测试不提交决定。'); },
  });
  store.ensureLoaded();
  store.ensureLoaded();
  assert.equal(reads.length, 1);
  assert.equal(store.snapshot().proposals, null);

  // 读取期间：a 已被别处取消、c 刚提出；读取结果里 a 还是待确认、没有 c。
  store.apply(proposal('a', { status: 'cancelled' }));
  store.apply(proposal('c'));
  reads[0]!.resolve([proposal('a'), proposal('b')]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(store.snapshot().proposals?.map((item) => [item.proposalId, item.status]), [
    ['a', 'cancelled'], ['b', 'pending'], ['c', 'pending'],
  ]);

  // 较晚到达的待确认或执行中快照不回退已执行的结果；同级的新快照照常写回。
  store.apply(proposal('b', { status: 'executed', outcome: { summary: '改名为「乙」', refs: [] } }));
  store.apply(proposal('b', { status: 'executing' }));
  store.apply(proposal('b'));
  assert.equal(store.snapshot().proposals?.find((item) => item.proposalId === 'b')?.status, 'executed');
  // 本窗口见过待确认的提议都记下，有定论后仍留作回执（a 在本窗口从来不是待确认）。
  assert.deepEqual([...store.snapshot().seenPending].sort(), ['b', 'c']);

  // 重读：有定论的保留，快照的引用只在变化时替换。
  const before = store.snapshot();
  store.refreshIfLoaded();
  assert.equal(store.snapshot(), before);
  reads[1]!.resolve([proposal('a'), proposal('b'), proposal('c', { status: 'expired', reason: '会话已被改名。' })]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(store.snapshot().proposals?.map((item) => item.status), ['cancelled', 'executed', 'expired']);
});

test('卡上的决定：进行中不重复提交，成功后原地写回；冲突时写明服务端说明并重读，网络失败保留按钮可以重试', async () => {
  const decisions: Array<{ proposalId: string; decision: ProposalDecision; result: ReturnType<typeof deferred<Proposal>> }> = [];
  let listed: readonly Proposal[] = [proposal('a'), proposal('b')];
  let lists = 0;
  const store = new Proposals({
    list: async () => { lists += 1; return listed; },
    decide: (proposalId, decision) => {
      const result = deferred<Proposal>();
      decisions.push({ proposalId, decision, result });
      return result.promise;
    },
  });
  await store.refresh();
  lists = 0;

  const confirming = store.decide('a', 'confirm');
  void store.decide('a', 'cancel');
  assert.equal(decisions.length, 1);
  assert.deepEqual(store.snapshot().decisions.a, { submitting: 'confirm', error: null });
  decisions[0]!.result.resolve(proposal('a', { status: 'executed', outcome: { summary: '改名为「乙」', refs: [] } }));
  await confirming;
  assert.equal(store.snapshot().decisions.a, undefined);
  assert.equal(store.snapshot().proposals?.[0]?.status, 'executed');

  // 冲突：别处已取消。卡上写明原因，并按服务端状态重读。
  listed = [proposal('a', { status: 'executed' }), proposal('b', { status: 'cancelled' })];
  const conflicting = store.decide('b', 'confirm');
  decisions[1]!.result.reject(new AssistantApiError('PROPOSAL_CONFLICT', '提议已取消，不能再确认；需要的话请让 Multivac 重新提出。', 409));
  await conflicting;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(store.snapshot().decisions.b, { submitting: null, error: '提议已取消，不能再确认；需要的话请让 Multivac 重新提出。' });
  assert.equal(lists, 1);
  assert.equal(store.snapshot().proposals?.[1]?.status, 'cancelled');

  // 网络失败：不重读，按钮恢复，可以重试。
  store.apply(proposal('c'));
  const offline = store.decide('c', 'cancel');
  decisions[2]!.result.reject(new TypeError('Failed to fetch'));
  await offline;
  assert.deepEqual(store.snapshot().decisions.c, { submitting: null, error: '没有提交：网络连接不可用，请重试。' });
  assert.equal(lists, 1);
  assert.deepEqual(proposalDecisionError(new AssistantApiError('NOT_FOUND', '提议不存在。', 404)), {
    message: '提议已不存在，卡片已按服务端状态更新。', refresh: true,
  });
});

test('回执：确认或取消后卡片原地变为一行结果与说明', () => {
  assert.equal(proposalReceipt(proposal('a')), null);
  assert.deepEqual(proposalReceipt(proposal('a', { status: 'executing' })), {
    headline: '正在执行：把会话「甲」改名为「乙」', detail: '你已确认，正在执行…',
  });
  assert.deepEqual(proposalReceipt(proposal('a', { status: 'executed', outcome: { summary: '改名为「乙」', refs: [] } })), {
    headline: '已执行：把会话「甲」改名为「乙」', detail: '改名为「乙」',
  });
  assert.deepEqual(proposalReceipt(proposal('a', { status: 'cancelled' })), {
    headline: '已取消：把会话「甲」改名为「乙」', detail: '没有做任何改动。',
  });
  assert.deepEqual(proposalReceipt(proposal('a', { status: 'expired', reason: '会话已被改名为「丙」（提出时是「甲」）。' })), {
    headline: '已过期：把会话「甲」改名为「乙」', detail: '会话已被改名为「丙」（提出时是「甲」）。没有执行。',
  });
  assert.deepEqual(proposalReceipt(proposal('a', { status: 'failed', reason: '会话不存在。' })), {
    headline: '执行失败：把会话「甲」改名为「乙」', detail: '会话不存在。',
  });
});
