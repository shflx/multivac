import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantPageState } from '@multivac/contracts';
import { AssistantApiError } from '../src/data/assistant-api.js';
import { PageStateSaver, conflictResolution, type PageStateSaverOptions } from '../src/features/assistant/page-state-saver.js';
import {
  canClearRunningDraft, canClearSettledDraft, type DraftContext, type PendingCommand,
} from '../src/features/assistant/pending-command.js';
import {
  cancelledFeedback, progressFeedback, reconciledFeedback, terminalFeedback, unsuccessfulSendError,
} from '../src/features/assistant/command-feedback.js';

const base: AssistantPageState = { draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: 1 };

async function settle(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function saver(options: Partial<PageStateSaverOptions> = {}) {
  const writes: AssistantPageState[] = [];
  const instance = new PageStateSaver({
    read: async () => base,
    write: async (state) => { writes.push(state); return { ...state, revision: state.revision + 1 }; },
    timers: { setTimeout: (callback) => setTimeout(callback, 0) as unknown as number, clearTimeout: (handle) => clearTimeout(handle as never) },
    lifecycle: () => 1,
    isActive: () => true,
    persistDraftVersion: () => {},
    changed: () => {},
    ...options,
  }, 0);
  instance.reset(base, false);
  return { instance, writes };
}

test('保存队列串行：在途保存完成后才写下一版本，最终保存最新内容', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const writes: AssistantPageState[] = [];
  const { instance } = saver({
    write: async (state) => {
      writes.push(state);
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await settle(2);
      inFlight -= 1;
      return { ...state, revision: state.revision + 1 };
    },
  });
  instance.change({ ...base, draft: '一' }, 'draft-intent');
  void instance.enqueue();
  instance.change({ ...instance.page, draft: '一二' }, 'draft-intent');
  await instance.enqueue();
  await settle();
  assert.equal(maxInFlight, 1);
  assert.equal(writes.at(-1)?.draft, '一二');
  assert.equal(instance.feedback.phase, 'saved');
});

test('版本冲突后不再后台覆盖远端，用户修改草稿或点重试才继续保存', async () => {
  let conflict = true;
  const { instance, writes } = saver({
    read: async () => ({ ...base, draft: '另一页面', revision: 5 }),
    write: async (state) => {
      writes.push(state);
      if (conflict) throw new AssistantApiError('PAGE_STATE_CONFLICT', '冲突', 409);
      return { ...state, revision: state.revision + 1 };
    },
  });
  instance.change({ ...base, draft: '本页' }, 'draft-intent');
  await instance.enqueue();
  assert.equal(instance.feedback.phase, 'error');
  assert.equal(instance.blocked, true);
  assert.equal(instance.page.revision, 5);

  // 阅读锚点变化不代表用户决定覆盖。
  instance.change({ ...instance.page, anchorEntryId: 'entry' }, 'view-anchor');
  await settle();
  assert.equal(writes.length, 1);

  conflict = false;
  await instance.enqueue(false, true);
  assert.equal(writes.length, 2);
  assert.equal(instance.feedback.phase, 'saved');
});

test('冲突判定：远端仍是本次已发送内容时只重试清稿；远端已有新内容时阻断', () => {
  const submitted = { draft: '已发送', agentId: null, quote: null };
  const candidate = { ...base, draft: '' };
  const input = { submitted, candidate, current: candidate, draftVersionUnchanged: true, localVersionUnchanged: true };
  assert.equal(conflictResolution({ ...input, remote: { ...base, draft: '已发送', revision: 3 } }), 'retry');
  assert.equal(conflictResolution({ ...input, remote: { ...base, draft: '', revision: 3 } }), 'saved');
  assert.equal(conflictResolution({ ...input, remote: { ...base, draft: '另一页面的新草稿', revision: 3 } }), 'blocked');
  // 不是命令结算的保存、或补读期间又有新编辑，都不自动处理。
  assert.equal(conflictResolution({ ...input, submitted: undefined, remote: { ...base, draft: '已发送' } }), 'blocked');
  assert.equal(conflictResolution({ ...input, draftVersionUnchanged: false, remote: { ...base, draft: '已发送' } }), 'blocked');
});

test('清稿归属：运行中只清同版本的普通发送；结算时冲突或新编辑都不清稿', () => {
  const pending: PendingCommand = {
    commandId: 'c', generation: 1, text: '问题', quote: null, contextRefs: [], draftVersion: 3,
    cleared: false, unknown: false, streamingBehavior: null,
  };
  const context: DraftContext = { draftVersion: 3, page: { draft: '问题', quote: null }, readingQuote: null, latestPrompt: pending };
  assert.equal(canClearRunningDraft(pending, pending, context), true);
  assert.equal(canClearRunningDraft(pending, pending, { ...context, draftVersion: 4 }), false);
  assert.equal(canClearRunningDraft({ ...pending, streamingBehavior: 'steer' }, pending, context), false);
  assert.equal(canClearSettledDraft(pending, pending, { ...context, conflictBlocked: false }), true);
  assert.equal(canClearSettledDraft(pending, pending, { ...context, conflictBlocked: true }), false);
  assert.equal(canClearSettledDraft(pending, pending, { ...context, page: { draft: '问题，补充', quote: null }, conflictBlocked: false }), false);
});

test('运行反馈：终态、对账与过程事件各自的说明', () => {
  assert.equal(terminalFeedback('succeeded', null, false)?.phase, 'succeeded');
  assert.deepEqual(terminalFeedback('failed', { code: 'X', message: '模型失败' }, false), { phase: 'failed', message: '处理失败', failureReason: '模型失败' });
  assert.equal(terminalFeedback('accepted', null, false), null);
  assert.equal(cancelledFeedback(true).message, '授权等待超时，本轮已结束');
  assert.equal(unsuccessfulSendError('cancelled', null, false), '消息处理已取消。');
  const base = { cursor: '1', eventId: 'e', assistantSessionId: 's', commandId: 'c', occurredAt: 't' };
  assert.equal(reconciledFeedback({ ...base, type: 'assistant.command.reconciled', data: {
    status: 'terminal', terminalOutcome: 'failed', error: { code: 'COMMAND_INTERRUPTED', message: '服务重启' },
  } }, false).message, '处理已中断');
  const ended = { ...base, type: 'assistant.tool.ended', data: { toolCallId: 't', toolName: 'read', isError: true } } as never;
  assert.equal(progressFeedback(ended)?.message, 'read 执行失败');
  // 未获授权的调用没有执行，结束事件不改写状态条。
  assert.equal(progressFeedback(ended, true), null);
});
