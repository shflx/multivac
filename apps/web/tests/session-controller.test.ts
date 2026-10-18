import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AssistantCommandReceipt, AssistantPageState, AssistantPublicEvent, AssistantSessionPageResponse,
} from '@multivac/contracts';
import { AssistantApiError } from '../src/data/assistant-api.js';
import type { SessionFeedHandlers } from '../src/features/events/event-router.js';
import { AssistantSessionController, type SessionApi } from '../src/features/assistant/session-controller.js';
import { SessionPersistence, type KeyValueStorage } from '../src/features/assistant/session-persistence.js';
import { deriveSessionView } from '../src/features/assistant/session-view.js';

/** 会话控制器在 node 中运行：服务端、事件流、浏览器存储与计时器都替换为内存实现。 */

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function page(eventCursor = '1', messages: AssistantSessionPageResponse['messages'] = []): AssistantSessionPageResponse {
  return { assistantSessionId: 'session', piSessionId: 'pi', messages, hasMore: false, nextBefore: null, cursor: 'c', eventCursor };
}

function receipt(commandId: string, status: AssistantCommandReceipt['status'], terminalOutcome: AssistantCommandReceipt['terminalOutcome'] = null): AssistantCommandReceipt {
  return {
    commandId, assistantSessionId: 'session', kind: 'send', status, terminalOutcome, error: null,
    piSessionId: null, piEntryId: null, piTurnRef: null, createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

/** 等待控制器内的异步步骤与（立即触发的）计时器全部推进。 */
async function settle(rounds = 30): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function harness(api: Partial<SessionApi> = {}, options: { eventCursor?: string } = {}) {
  let remote: AssistantPageState = { draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: 1 };
  const feeds: Array<{ handlers: SessionFeedHandlers; ready: number[]; closed: boolean }> = [];
  const sent: Parameters<SessionApi['send']>[0][] = [];
  let clock = 0;
  let ids = 0;
  const defaults: SessionApi = {
    getPageState: async () => remote,
    putPageState: async (_session, state) => { remote = { ...remote, ...state, quote: state.quote ?? null, revision: remote.revision + 1 }; return remote; },
    getPage: async () => page(options.eventCursor),
    listAuthorizations: async () => ({ sessionId: 'session', requests: [] }),
    decideAuthorization: async () => { throw new Error('未使用'); },
    getCommand: async (_session, commandId) => ({ commandId, status: 'unknown', receipt: null }),
    send: async (command) => receipt(command.commandId, 'terminal', 'succeeded'),
    cancel: async (command) => receipt(command.commandId, 'terminal', 'accepted'),
  };
  const merged: SessionApi = { ...defaults, ...api };
  const controller = new AssistantSessionController({
    sessionId: 'session',
    api: { ...merged, send: (command) => { sent.push(command); return merged.send(command); } },
    events: {
      open: (_session, handlers) => {
        const feed = { handlers, ready: [] as number[], closed: false };
        feeds.push(feed);
        return { ready: (cursor: number) => { feed.ready.push(cursor); }, close: () => { feed.closed = true; } } as never;
      },
    },
    persistence: new SessionPersistence('session', new MemoryStorage(), new MemoryStorage()),
    // 计时器立即触发，并按等待时长推进时钟：对账超时等规则不需要真实等待。
    timers: {
      setTimeout: (callback, delay) => { clock += delay; return setTimeout(callback, 0) as unknown as number; },
      clearTimeout: (handle) => clearTimeout(handle as never),
    },
    clock: () => clock,
    createCommandId: () => `command-${++ids}`,
  });
  controller.model = { available: true, busy: false, loaded: true };
  return { controller, feeds, sent, remote: () => remote };
}

async function ready(controller: AssistantSessionController): Promise<void> {
  controller.start();
  await settle();
  assert.equal(controller.getState().status, 'ready');
}

function delta(cursor: string, commandId: string | null, text: string): AssistantPublicEvent {
  return {
    cursor, eventId: `event-${cursor}`, assistantSessionId: 'session', commandId, occurredAt: '2026-10-18T00:00:00.000Z',
    type: 'assistant.message.delta', data: { piSessionId: 'pi', messageId: 'reply', delta: text },
  } as AssistantPublicEvent;
}

test('成功回执清除已发送的草稿，并把清稿保存到服务端', async () => {
  const { controller, remote } = harness();
  await ready(controller);
  controller.updateDraft('你好');
  await controller.submitDraft();
  await settle();
  const state = controller.getState();
  assert.equal(state.page.draft, '');
  assert.equal(state.pendingCommand, null);
  assert.equal(state.runFeedback.phase, 'succeeded');
  assert.equal(remote().draft, '');
});

test('发送后继续编辑：迟到的成功回执不清除新输入', async () => {
  const response = deferred<AssistantCommandReceipt>();
  const { controller } = harness({ send: () => response.promise });
  await ready(controller);
  controller.updateDraft('第一句');
  const submitting = controller.submitDraft();
  controller.updateDraft('第一句，再补充');
  response.resolve(receipt('command-1', 'terminal', 'succeeded'));
  await submitting;
  await settle();
  assert.equal(controller.getState().page.draft, '第一句，再补充');
  assert.equal(controller.getState().pendingCommand, null);
});

test('运行中回执即清除同版本草稿；命令终结后结算', async () => {
  let reconciled = false;
  const { controller } = harness({
    send: async (command) => receipt(command.commandId, 'running'),
    getCommand: async (_session, commandId) => {
      reconciled = true;
      return { commandId, status: 'terminal', receipt: receipt(commandId, 'terminal', 'succeeded') };
    },
  });
  await ready(controller);
  controller.updateDraft('处理一下');
  await controller.submitDraft();
  await settle();
  assert.equal(reconciled, true);
  assert.equal(controller.getState().page.draft, '');
  assert.equal(controller.getState().activePrompt, null);
  assert.equal(controller.getState().runFeedback.phase, 'succeeded');
});

test('网络失败后结果未知：保留原命令与快照，重试沿用同一 commandId', async () => {
  let attempts = 0;
  const { controller, sent } = harness({
    send: async (command) => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('network');
      return receipt(command.commandId, 'terminal', 'succeeded');
    },
  });
  await ready(controller);
  controller.updateDraft('原问题');
  await controller.submitDraft();
  await settle();
  const unknown = controller.getState();
  assert.equal(unknown.pendingCommand?.unknown, true);
  assert.equal(unknown.page.draft, '原问题');
  assert.equal(unknown.sendError, '发送结果未知，可按原命令重试。');
  assert.equal(deriveSessionView(unknown, controller.model, { ids: () => [], ready: true }).canRetryUnknown, true);

  await controller.submitDraft();
  await settle();
  assert.deepEqual(sent.map((command) => [command.commandId, command.text]), [['command-1', '原问题'], ['command-1', '原问题']]);
  assert.equal(controller.getState().pendingCommand, null);
});

test('服务端明确拒绝：输入保留，说明拒绝原因，状态条显示失败', async () => {
  const { controller } = harness({
    send: async () => { throw new AssistantApiError('INVALID_REQUEST', '当前模型不可用。', 422); },
  });
  await ready(controller);
  controller.updateDraft('还在吗');
  await controller.submitDraft();
  await settle();
  const state = controller.getState();
  assert.equal(state.page.draft, '还在吗');
  assert.equal(state.pendingCommand, null);
  assert.equal(state.sendError, '当前模型不可用。');
  assert.equal(state.runFeedback.phase, 'failed');
});

test('事件按游标去重：快照已包含的事件被忽略，之后的按序应用', async () => {
  const { controller, feeds } = harness({}, { eventCursor: '5' });
  await ready(controller);
  assert.deepEqual(feeds[0]!.ready, [5]);
  feeds[0]!.handlers.deliver(delta('4', null, '旧'));
  assert.equal(controller.getState().history.messages.length, 0);
  feeds[0]!.handlers.deliver(delta('6', null, '新'));
  assert.equal(controller.getState().history.messages.length, 1);
  feeds[0]!.handlers.deliver(delta('6', null, '重复'));
  assert.equal(controller.getState().history.messages[0]!.text, '新');
});

test('事件流过期后重读现场与历史，并按已消费的较高水位重新衔接', async () => {
  let pageReads = 0;
  const { controller, feeds } = harness({ getPage: async () => page(String(3 + pageReads++)) });
  await ready(controller);
  feeds[0]!.handlers.deliver(delta('9', null, '在途'));
  feeds[0]!.handlers.expired();
  await settle();
  assert.deepEqual(feeds[0]!.ready, [3, 9]);
  assert.equal(controller.getState().sendError, '');
});

test('重复挂载只保留一条事件接入，卸载后到达的事件不再处理', async () => {
  const { controller, feeds } = harness();
  controller.start();
  controller.dispose();
  await ready(controller);
  assert.equal(feeds.length, 2);
  assert.equal(feeds[0]!.closed, true);
  assert.equal(feeds[1]!.closed, false);
  controller.dispose();
  feeds[1]!.handlers.deliver(delta('2', null, '卸载后'));
  assert.equal(controller.getState().history.messages.length, 0);
});

test('运行中不能切换智能体，追加发送需先选择追加方式', async () => {
  const { controller } = harness({ send: async (command) => receipt(command.commandId, 'running') });
  await ready(controller);
  controller.updateDraft('开始');
  await controller.submitDraft();
  await settle(3);
  const running = controller.getState();
  assert.ok(running.activePrompt);
  controller.setAgentId('agent-a');
  assert.equal(controller.getState().page.agentId ?? null, null);
  controller.updateDraft('补充');
  assert.equal(deriveSessionView(controller.getState(), controller.model, { ids: () => [], ready: true }).canSubmit, false);
  controller.selectStreamingBehavior('followUp');
  assert.equal(deriveSessionView(controller.getState(), controller.model, { ids: () => [], ready: true }).canSubmit, true);
  controller.dispose();
});
