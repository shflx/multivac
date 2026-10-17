import assert from 'node:assert/strict';
import test from 'node:test';
import type { CoordinatorAdapterEvent, CoordinatorRuntimeConfig } from '@multivac/contracts';
import type { CoordinatorAdapter } from '../src/modules/sessions/coordinator-adapter.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { config as piConfig, resources, StubFactory } from './fixtures/pi-session-stub.js';

/**
 * CoordinatorAdapter 端口契约：每个执行器实现（Pi、Fake，以及后续接入的其他 harness）都必须通过。
 * 只断言端口承诺的行为，不依赖具体实现的内部类型或事件细节。
 */
interface Subject {
  name: string;
  config: CoordinatorRuntimeConfig;
  create(): CoordinatorAdapter;
}

const fakeConfig: CoordinatorRuntimeConfig = {
  ...piConfig,
  model: { provider: 'fake', modelId: 'fake-model', thinkingLevel: 'medium' },
};

const subjects: Subject[] = [
  { name: 'Pi', config: piConfig, create: () => new PiCoordinatorAdapter({ sessionFactory: new StubFactory([resources(), resources(), resources()]) }) },
  { name: 'Fake', config: fakeConfig, create: () => new FakeCoordinatorAdapter() },
];

const workingDirectory = { kind: 'session-temp' as const, path: '/workspace' };

for (const subject of subjects) {
  test(`${subject.name}：新建会话返回绑定身份，一轮发送以终态结束且不再忙碌`, async () => {
    const adapter = subject.create();
    try {
      const created = await adapter.createSession({ assistantSessionId: 'contract', config: subject.config, workingDirectory });
      assert.ok(created.ok, '新建会话应成功');
      assert.equal(created.value.binding.assistantSessionId, 'contract');
      assert.ok(created.value.binding.piSessionId, '绑定须带执行器会话身份');

      const events: CoordinatorAdapterEvent['type'][] = [];
      const subscription = adapter.subscribe('contract', (event) => { events.push(event.type); });
      assert.ok(subscription.ok);

      const run = await adapter.prompt('contract', '开始');
      assert.ok(run.ok, '发送应成功受理');
      assert.equal(run.value.status, 'completed');
      assert.ok(events.includes('coordinator.run.started'), '一轮开始须发布事件');
      assert.ok(events.includes('coordinator.run.completed'), '一轮终态须发布事件');

      const busy = adapter.isBusy('contract');
      assert.ok(busy.ok);
      assert.equal(busy.value, false);
      const history = adapter.readActiveBranch('contract');
      assert.ok(history.ok, '已打开的会话可读历史');
      assert.equal(history.value.piSessionId, created.value.binding.piSessionId);

      subscription.value();
    } finally { adapter.dispose(); }
  });

  test(`${subject.name}：未打开或已释放的会话以失败结果返回，不抛错`, async () => {
    const adapter = subject.create();
    try {
      assert.equal(adapter.isBusy('missing').ok, false);
      assert.equal(adapter.readActiveBranch('missing').ok, false);
      assert.equal(adapter.subscribe('missing', () => {}).ok, false);
      assert.equal((await adapter.prompt('missing', '开始')).ok, false);

      assert.ok((await adapter.createSession({ assistantSessionId: 'released', config: subject.config, workingDirectory })).ok);
      adapter.disposeSession('released');
      assert.equal(adapter.isBusy('released').ok, false);
      assert.equal((await adapter.prompt('released', '开始')).ok, false);
    } finally { adapter.dispose(); }
  });

  test(`${subject.name}：能力声明与实际行为一致，未打开的会话不声称支持`, async () => {
    const adapter = subject.create();
    try {
      const { capabilities } = adapter;
      for (const key of ['turnExecution', 'imageInput', 'steering', 'toolStopProof'] as const) assert.equal(typeof capabilities[key], 'boolean', key);
      assert.equal(adapter.supportsImageInput('missing'), false);
      assert.equal(adapter.taskToolsStopped('missing'), false);
      assert.deepEqual(adapter.readImageContents('missing', 'entry'), []);
      assert.equal((await adapter.prepareTurnExecution('missing', subject.config.model, '说明')).ok, false);

      assert.ok((await adapter.createSession({ assistantSessionId: 'capable', config: subject.config, workingDirectory })).ok);
      const prepared = await adapter.prepareTurnExecution('capable', subject.config.model, '本轮说明');
      // 声明支持表示可能支持，具体会话仍可明确拒绝；声明不支持时必须拒绝。
      if (!capabilities.turnExecution) assert.equal(prepared.ok, false, '声明不支持单轮执行配置时必须拒绝');
      if (prepared.ok) prepared.value.restore();
      if (!capabilities.imageInput) assert.equal(adapter.supportsImageInput('capable'), false);
    } finally { adapter.dispose(); }
  });

  test(`${subject.name}：按绑定恢复同一会话身份`, async () => {
    const adapter = subject.create();
    try {
      const created = await adapter.createSession({ assistantSessionId: 'resume', config: subject.config, workingDirectory });
      assert.ok(created.ok);
      adapter.disposeSession('resume');
      const resumed = await adapter.continueSession({ binding: created.value.binding, config: subject.config, workingDirectory });
      assert.ok(resumed.ok, '按绑定恢复应成功');
      assert.equal(resumed.value.binding.assistantSessionId, 'resume');
      assert.equal(resumed.value.binding.piSessionId, created.value.binding.piSessionId);
    } finally { adapter.dispose(); }
  });
}
