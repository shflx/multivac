import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentList, WorkbenchEvent } from '@multivac/contracts';
import { AgentsStore } from '../src/features/agents/agents-store.js';

const data = (name: string): AgentList => ({
  agents: [{ agentId: 'general', name, description: '', instructions: '', modelProfileId: null, thinkingLevel: null, fixed: false, revision: 1, createdAt: '', updatedAt: '' }],
  modelStates: {}, coordinatorTools: [], invocations: {},
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: (value: AgentList) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<AgentList>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('多会话挂载与打开菜单共用在途请求，缓存可立即展示并在后台刷新', async () => {
  const requests = [deferred(), deferred()];
  let count = 0;
  const store = new AgentsStore(() => requests[count++]!.promise);
  const first = store.load();
  const loads = Array.from({ length: 20 }, () => store.load());
  assert.ok(loads.every(load => load === first));
  await tick(); assert.equal(count, 1);
  requests[0]!.resolve(data('初始名称')); await first;
  assert.equal(store.snapshot().data!.agents[0]!.name, '初始名称');
  const next = store.load();
  assert.equal(store.snapshot().data!.agents[0]!.name, '初始名称');
  assert.equal(store.snapshot().loading, true);
  requests[1]!.resolve(data('新名称')); await next;
  assert.equal(count, 2);
  assert.equal(store.snapshot().data!.agents[0]!.name, '新名称');
});

test('同一事件的多个订阅只刷新一次；查询中连续变更补读一次并丢弃过时结果', async () => {
  const requests = [deferred(), deferred()];
  let count = 0;
  const store = new AgentsStore(() => requests[count++]!.promise);
  const observed: string[] = [];
  const unsubscribe = store.subscribe(() => { const name = store.snapshot().data?.agents[0]?.name; if (name) observed.push(name); });
  const event: WorkbenchEvent = { type: 'agent.changed', seq: 1, origin: { windowId: null, commandId: null }, change: 'updated', agent: data('新名称').agents[0]! };
  for (let index = 0; index < 20; index++) store.applyEvent(event);
  await tick(); assert.equal(count, 1);
  const completion = store.load();
  for (let seq = 2; seq < 6; seq++) store.applyEvent({ ...event, seq });
  requests[0]!.resolve(data('过时名称')); await tick();
  assert.equal(count, 2);
  assert.equal(store.snapshot().loading, true);
  assert.deepEqual(observed, []);
  requests[1]!.resolve(data('最新名称')); await completion;
  assert.equal(store.snapshot().data!.agents[0]!.name, '最新名称');
  assert.equal(store.snapshot().loading, false);
  assert.deepEqual(observed, ['最新名称']);
  unsubscribe();
});

test('重连和本窗口修改使在途查询失效；失败保留缓存且可以重试', async () => {
  const requests = [deferred(), deferred(), deferred(), deferred()];
  let count = 0;
  const store = new AgentsStore(() => requests[count++]!.promise);
  const initial = store.load(); requests[0]!.resolve(data('初始名称')); await initial;
  const reconnect: WorkbenchEvent = { type: 'workbench.connected', seq: 1, windowId: null };
  store.applyEvent(reconnect); store.applyEvent(reconnect);
  const completion = store.refresh();
  requests[1]!.reject(new Error('过时查询失败')); await tick();
  assert.equal(count, 3);
  assert.equal(store.snapshot().error, '');
  requests[2]!.reject(new Error('读取失败')); await completion;
  assert.equal(store.snapshot().data!.agents[0]!.name, '初始名称');
  assert.equal(store.snapshot().error, '读取失败');
  assert.equal(store.snapshot().loading, false);
  const retry = store.load(); requests[3]!.resolve(data('恢复后的名称')); await retry;
  assert.equal(store.snapshot().error, '');
  assert.equal(store.snapshot().data!.agents[0]!.name, '恢复后的名称');
});
