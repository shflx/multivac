import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime, SessionManager, createAgentSession } from '@earendil-works/pi-coding-agent';
import type { CoordinatorRuntimeConfig } from '@multivac/contracts';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { DefaultPiCoordinatorSessionFactory } from '../src/runtime/executors/pi-session-factory.js';

// 离线真实 SDK 检查：验证内存设置和 transcript，不代表真实模型请求已核验。
test('本轮 Pi 配置真实作用于同一 Agent，恢复与重开不改变持久模型或系统边界', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-turn-agent-sdk-'));
  const cwd = join(root, 'work'); const agentDir = join(root, 'agent'); const sessionDir = join(root, 'sessions');
  await mkdir(cwd); await mkdir(agentDir);
  const authPath = join(agentDir, 'auth.json');
  await writeFile(authPath, JSON.stringify({ openai: { type: 'api_key', key: 'offline-placeholder' } }), { mode: 0o600 });
  const runtime = await ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: join(root, 'catalog.json'), allowModelNetwork: false });
  const models = runtime.getModels('openai').filter(model => model.api === 'openai-responses');
  const plain = models.find(model => !model.reasoning)!;
  const reasoning = models.find(model => model.reasoning)!;
  const config: CoordinatorRuntimeConfig = { systemPrompt: '保留文件授权与工具边界。', authorizedContext: [], model: { provider: plain.provider, modelId: plain.id, source: 'base', thinkingLevel: 'off' }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 } };
  let actual: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  const adapter = new PiCoordinatorAdapter({ agentDir, sessionDir, sessionFactory: new DefaultPiCoordinatorSessionFactory({ authPath, modelsPath: null, createAgentSession: async options => { const result = await createAgentSession(options); actual = result.session; return result; } }) });
  try {
    const ready = await adapter.createSession({ assistantSessionId: 'work', config, workingDirectory: { kind: 'session-temp', path: cwd } });
    assert.equal(ready.ok, true);
    if (!ready.ok) return;
    const original = actual!.agent.state;
    const prompt = original.systemPrompt;
    const tools = actual!.getActiveToolNames();
    const count = SessionManager.open(ready.value.binding.piSessionPath, sessionDir, cwd).getBranch().length;
    const preparation = await adapter.prepareTurnExecution('work', { provider: reasoning.provider, modelId: reasoning.id, thinkingLevel: 'high', source: 'base' }, '本轮先检查风险。');
    assert.equal(preparation.ok, true);
    if (!preparation.ok) return;
    preparation.value.activate();
    assert.equal(actual!.model?.id, reasoning.id);
    assert.equal(actual!.thinkingLevel, 'high');
    assert.match(actual!.agent.state.systemPrompt, /本轮先检查风险/);
    assert.ok(actual!.agent.state.systemPrompt.startsWith(prompt));
    assert.deepEqual(actual!.getActiveToolNames(), tools);
    assert.equal(SessionManager.open(ready.value.binding.piSessionPath, sessionDir, cwd).getBranch().length, count);
    preparation.value.restore();
    preparation.value.restore();
    assert.equal(actual!.model?.id, plain.id);
    assert.equal(actual!.thinkingLevel, 'off');
    assert.equal(actual!.agent.state.systemPrompt, prompt);
    adapter.disposeSession('work');
    assert.equal((await adapter.continueSession({ binding: ready.value.binding, config, workingDirectory: { kind: 'session-temp', path: cwd } })).ok, true);
    assert.equal(actual!.model?.id, plain.id);
    assert.doesNotMatch(actual!.agent.state.systemPrompt, /本轮先检查风险/);
  } finally { adapter.dispose(); await rm(root, { recursive: true, force: true }); }
});
