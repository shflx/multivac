import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { CoordinatorRuntimeConfig } from '@multivac/contracts';
function runtimeConfig(_env: object): CoordinatorRuntimeConfig { return { model: { provider: 'fixture', modelId: 'test', thinkingLevel: 'off' }, systemPrompt: '', authorizedContext: [], retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 }, compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 } }; }
import { presetAgents } from '../src/modules/agents/agent.js';
import type { SubagentRecord } from '../src/modules/agents/subagent-run.js';
import { SqliteSubagentRepository, SUBAGENT_MIGRATION } from '../src/storage/sqlite-subagent-repository.js';
import { SubagentExecution, boundedSubagentSummary, type SubagentExecutionPorts } from '../src/application/subagent-execution.js';
import type { AssistantSessionRuntime } from '../src/application/assistant-session-runtime.js';

function fixture(overrides: Partial<SubagentExecutionPorts> = {}) {
  const db = new DatabaseSync(':memory:'); db.exec(SUBAGENT_MIGRATION);
  const repository = new SqliteSubagentRepository(db);
  const agent = { ...presetAgents('now')[1]!, delegable: true };
  const config = runtimeConfig({});
  let sends = 0, bytes = 0;
  const records: SubagentRecord[] = [];
  const runtime = { commands: { send: async () => { sends++; return { terminalOutcome: 'succeeded' }; }, cancel: async () => {} } } as unknown as AssistantSessionRuntime;
  const execution = new SubagentExecution(repository, {
    parent: () => ({ commandId: 'parent-turn', taskId: null, taskRunId: null, workingDirectory: { kind: 'temporary', path: '/work' }, remainingMillis: 10000, remainingBytes: 10000 }),
    agent: () => agent,
    prepare: async record => { records.push(record); return { execution: { executor: { agentId: agent.agentId, revision: record.run.agent.revision, name: record.run.agent.name,
      modelProfileId: null, modelName: '冻结模型', provider: 'fixture', modelId: 'test', thinkingLevel: 'off' }, model: config.model, instructions: record.run.agent.instructions }, config }; },
    runtime: () => runtime, stopTools: async () => {}, stopped: () => true, summary: () => '独立结论',
    charge: (record, _phase, _marker, delta) => { repository.save(record); bytes += delta; return 10000 - bytes; }, changed: () => {}, ...overrides,
  });
  return { db, repository, execution, agent, records, sends: () => sends, bytes: () => bytes };
}
const input = { agentId: 'general', mode: 'read' as const, goal: '检查引用', context: '仅这些资料', deliverable: '给出结论', reason: '独立检索' };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('独立运行冻结配置；相同工具调用在途共享、完成后只读返回，不重放模型', async () => {
  const world = fixture();
  try {
    const first = world.execution.delegate('parent', 'call', input, new AbortController().signal);
    world.agent.revision = 2; world.agent.instructions = '后来修改';
    const replay = world.execution.delegate('parent', 'call', input, new AbortController().signal);
    const [a, b] = await Promise.all([first, replay]);
    assert.equal(a.id, b.id); assert.equal(a.agent.revision, 1);
    assert.equal(world.records[0]!.run.agent.instructions, '');
    assert.equal(a.status, 'succeeded'); assert.equal(a.stopConfirmed, true);
    assert.equal(a.summary, '独立结论'); assert.equal(world.sends(), 1);
    assert.equal((await world.execution.delegate('parent', 'call', input, new AbortController().signal)).id, a.id);
    assert.equal(world.sends(), 1);
    await assert.rejects(async () => world.execution.delegate('parent', 'call', { ...input, goal: '换参数' }, new AbortController().signal), /参数已变化/);
  } finally { world.db.close(); }
});

test('并发 5 个实际同时准备，第六个拒绝；结束后可继续委派，总次数不限', async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const world = fixture({ prepare: async record => { await wait; return { execution: { executor: { agentId: 'general', revision: 1, name: '执行', modelProfileId: null, modelName: 'test', provider: 'fixture', modelId: 'test', thinkingLevel: 'off' }, model: runtimeConfig({}).model, instructions: '' }, config: runtimeConfig({}) }; } });
  try {
    const pending = Array.from({ length: 5 }, (_, i) => world.execution.delegate('parent', String(i), input, new AbortController().signal));
    await tick();
    assert.equal(world.repository.unsettled('parent').length, 5);
    await assert.rejects(async () => world.execution.delegate('parent', 'six', input, new AbortController().signal), /最多并发/);
    release(); await Promise.all(pending);
    assert.equal((await world.execution.delegate('parent', 'later', input, new AbortController().signal)).status, 'succeeded');
  } finally { release(); world.db.close(); }
});

test('父级取消级联停止，未确认的进程保留占用；补停止证明后才释放', async () => {
  let release!: () => void, confirmed = false, stops = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const runtime = { commands: { send: async () => { await waiting; return { terminalOutcome: 'cancelled' }; }, cancel: async () => { stops++; release(); } } } as unknown as AssistantSessionRuntime;
  const world = fixture({ runtime: () => runtime, stopped: () => confirmed });
  try {
    const controller = new AbortController();
    const pending = world.execution.delegate('parent', 'cancel', input, controller.signal);
    await tick(); controller.abort();
    const result = await pending;
    assert.equal(stops, 1); assert.equal(result.status, 'reconcile'); assert.equal(result.stopConfirmed, false);
    assert.equal(world.execution.occupies('parent'), true);
    confirmed = true; world.execution.reconcileStops(); assert.equal(world.execution.occupies('parent'), false);
  } finally { release(); world.db.close(); }
});

test('重启中断未结束运行，回放原调用不重新准备或执行；原智能体受引用保护', async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const world = fixture({ prepare: async () => { await waiting; throw new Error('模拟原进程退出'); }, stopped: () => false });
  try {
    const old = world.execution.delegate('parent', 'restart', input, new AbortController().signal);
    await tick();
    assert.equal(world.execution.usesAgent('general'), true);
    world.execution.recover();
    const restored = fixture();
    try {
      const record = world.repository.byCall('parent', 'restart')!;
      restored.repository.save(record);
      const result = await restored.execution.delegate('parent', 'restart', input, new AbortController().signal);
      assert.equal(result.status, 'interrupted'); assert.equal(result.stopConfirmed, false);
      assert.equal(restored.sends(), 0); assert.match(result.summary, /未自动重放/);
    } finally { restored.db.close(); }
    release(); await old;
  } finally { release(); world.db.close(); }
});

test('输出计入父级；耗尽后阻止后续工具，摘要有界且不拆开代理对', async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const runtime = { commands: { send: async () => { await waiting; return { terminalOutcome: 'succeeded' }; }, cancel: async () => release() } } as unknown as AssistantSessionRuntime;
  const world = fixture({ runtime: () => runtime });
  try {
    const pending = world.execution.delegate('parent', 'meter', input, new AbortController().signal); await tick();
    const id = world.repository.byCall('parent', 'meter')!.run.sessionId;
    assert.equal(world.execution.lease(id, 'starting', 'tool', 100), 9900);
    assert.equal(world.bytes(), 100);
    assert.throws(() => world.execution.lease(id, 'progress', 'tool', 10000), /额度/);
    assert.equal(world.repository.bySession(id)!.run.outputBytes, 10100);
    release(); await pending;
    const result = boundedSubagentSummary('😀'.repeat(10000));
    assert.ok(result.summary.length <= 8000); assert.equal(result.summaryTruncated, true);
    assert.ok(!result.summary.includes('\uFFFD'));
  } finally { release(); world.db.close(); }
});

test('模型准入失败明确失败且不换模型；子级不能再次委派', async () => {
  const world = fixture({ prepare: async () => { throw new Error('冻结模型已失效'); } });
  try {
    const run = await world.execution.delegate('parent', 'bad-model', input, new AbortController().signal);
    assert.equal(run.status, 'failed'); assert.match(run.summary, /模型已失效/); assert.equal(world.sends(), 0);
    await assert.rejects(async () => world.execution.delegate(run.sessionId, 'nested', input, new AbortController().signal), /不能再次委派/);
  } finally { world.db.close(); }
});

test('取消异步准备不会提前释放并发占用，准备落定后不启动模型', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const world = fixture({ prepare: async () => { await gate; throw new Error('准备已取消'); } });
  try {
    const pending = world.execution.delegate('parent', 'prepare-cancel', input, new AbortController().signal);
    await tick(); const record = world.repository.byCall('parent', 'prepare-cancel')!;
    assert.equal(await world.execution.stop(record.run.id, '父级取消。'), false);
    assert.equal(world.execution.occupies('parent'), true);
    release(); const run = await pending;
    assert.equal(run.status, 'cancelled'); assert.equal(run.stopConfirmed, true); assert.equal(world.sends(), 0);
  } finally { release(); world.db.close(); }
});
