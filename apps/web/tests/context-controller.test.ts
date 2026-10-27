import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextCompactionOperation, SessionContextResponse } from '@multivac/contracts';
import { SessionContextController } from '../src/features/assistant/context-controller.js';

const model = { provider: 'controlled', modelId: 'controlled', source: 'base' as const, protocol: null, profileId: null };
const item = { status: 'unknown' as const, explanation: '受控界面数据，非真实模型计数。' };
const data: SessionContextResponse = { state: { sessionId: 'session', revision: 'r1',
  current: { sessionId: 'session', revision: 'r1', model, contextWindow: 1000, observedAt: '2026-10-26T00:00:00.000Z',
    measuredAt: null, stale: false, staleReason: null, coverage: { systemPrompt: item, toolDefinitions: item, summary: item, toolResults: item, attachments: item },
    source: 'unavailable', tokens: null, basis: null, unavailableReason: '未知' }, lastRequest: null,
  compaction: { available: true, model, reason: null } }, operation: null };
function operation(status: ContextCompactionOperation['status']): ContextCompactionOperation {
  return { operationId: 'original', sessionId: 'session', model, status, commitState: status === 'succeeded' ? 'committed' : 'unknown',
    startedAt: data.state.current.observedAt, updatedAt: data.state.current.observedAt, finishedAt: null, runtimeCommitRef: null,
    before: data.state.current, after: null, error: null };
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function fixture() {
  let saved: string | null = null;
  let posts = 0;
  let op: ContextCompactionOperation | null = null;
  const api = {
    read: async () => structuredClone({ ...data, operation: op }), operation: async () => op,
    compact: async () => { posts++; op = operation('running'); return op; }, newId: () => 'original',
    loadPending: () => saved, savePending: (id: string | null) => { saved = id; },
  };
  return { api, controller: new SessionContextController('session', api), posts: () => posts, saved: () => saved,
    setOperation: (value: ContextCompactionOperation) => { op = value; } };
}

test('事件使在途响应失效；迟到旧模型结果不能覆盖新状态', async () => {
  const h = fixture();
  let resolve!: (value: SessionContextResponse) => void;
  const old = new Promise<SessionContextResponse>(done => { resolve = done; });
  let reads = 0;
  h.api.read = () => ++reads === 1 ? old : Promise.resolve({ ...data, state: { ...data.state, revision: 'new-model' } });
  h.controller.start();
  h.controller.invalidate();
  resolve(data);
  await settle();
  assert.equal(h.controller.getState().data?.state.revision, 'new-model');
  assert.equal(h.controller.getState().stale, false);
  h.controller.stop();
});

test('双击只发一个操作；响应丢失后只读核对，刷新不重发 POST', async () => {
  const h = fixture();
  h.api.compact = async () => { h.setOperation(operation('running')); throw new Error('connection lost'); };
  let posts = 0;
  const dispatch = h.api.compact;
  h.api.compact = async () => { posts++; return dispatch(); };
  h.controller.start(); await settle();
  await Promise.all([h.controller.compact(), h.controller.compact()]); await settle();
  for (let i = 0; i < 3; i++) await h.controller.refresh();
  assert.equal(posts, 1);
  assert.equal(h.controller.getState().pending, true);
  assert.equal(h.saved(), 'original');
  assert.equal(h.controller.getState().operation?.status, 'running');
  h.controller.stop();
});

test('页面重新挂载恢复原 ID，完成后清除本地意图，不重发压缩', async () => {
  const h = fixture();
  h.api.savePending('original');
  h.setOperation(operation('succeeded'));
  const restored = new SessionContextController('session', h.api);
  restored.start(); await settle();
  assert.equal(restored.getState().operation?.status, 'succeeded');
  assert.equal(restored.getState().pending, false);
  assert.equal(h.saved(), null);
  assert.equal(h.posts(), 0);
  restored.stop();
});

test('本地意图无法保存时不发起压缩；旧 ID 无服务端结果时保持待核对', async () => {
  const h = fixture();
  h.api.savePending = () => { throw new Error('storage denied'); };
  h.controller.start(); await settle();
  await h.controller.compact();
  assert.equal(h.posts(), 0);
  assert.match(h.controller.getState().error!, /尚未发起/);
  h.controller.stop();
  const recovered = new SessionContextController('session', { ...h.api, loadPending: () => 'original' });
  recovered.start(); await settle();
  assert.equal(recovered.getState().pending, true);
  assert.match(recovered.getState().error!, /不会自动重发/);
  await recovered.compact();
  assert.equal(h.posts(), 0);
  recovered.stop();
});

test('会话身份不一致、能力不可用或已过期时不允许压缩', async () => {
  const h = fixture();
  h.api.read = async () => ({ ...data, state: { ...data.state, sessionId: 'other' } });
  h.controller.start(); await settle();
  assert.equal(h.controller.getState().data, null);
  assert.equal(h.controller.getState().stale, true);
  await h.controller.compact(); assert.equal(h.posts(), 0);
  h.api.read = async () => ({ ...data, state: { ...data.state, compaction: { available: false, model, reason: '一致性未验证' } } });
  await h.controller.refresh(); await h.controller.compact();
  assert.equal(h.posts(), 0);
  h.controller.stop();
});
