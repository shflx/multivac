import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { CreateAgentSessionOptions, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { CoordinatorRuntimeConfig } from '@multivac/contracts';
import { DefaultPiCoordinatorSessionFactory, type PiCoordinatorAgentSession, type PiCoordinatorModel } from '../src/runtime/executors/pi-session-factory.js';

const config: CoordinatorRuntimeConfig = { systemPrompt: '工作会话测试', authorizedContext: [], model: { provider: 'test', modelId: 'model', thinkingLevel: 'off' }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 }, compaction: { enabled: false, reserveTokens: 3000, keepRecentTokens: 5000 } };

test('创建与恢复共用 factory 的 bash 覆盖保留工具集合，阅读会话不获得执行入口', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-managed-bash-factory-'));
  const cwd = join(root, 'work'), agentDir = join(root, 'agent'); await mkdir(cwd); await mkdir(agentDir);
  const model = { provider: 'test', id: 'model', api: 'openai-responses', baseUrl: 'https://test.example/v1' } as PiCoordinatorModel;
  const runtime = { getModel: () => model, hasConfiguredAuth: () => true, getAuth: async () => ({ auth: {} }) } as unknown as ModelRuntime;
  const captured: CreateAgentSessionOptions[] = [];
  const session: PiCoordinatorAgentSession = {
    sessionId: 'pi-test', sessionFile: undefined, model, thinkingLevel: 'off', isStreaming: false,
    getActiveBranch: () => [], prompt: async () => {}, steer: async () => {}, followUp: async () => {}, sendCustomMessage: async () => {},
    abort: async () => {}, subscribe: () => () => {}, getActiveToolNames: () => ['read', 'bash', 'edit', 'write'],
    setModel: async () => {}, setThinkingLevel: () => {}, dispose: () => {},
  };
  const factory = new DefaultPiCoordinatorSessionFactory({ createModelRuntime: async () => runtime,
    createAgentSession: async options => {
      captured.push(options);
      return { session: { ...session, getActiveToolNames: () => [...options.tools!] } as never, extensionsResult: options.resourceLoader!.getExtensions() };
    } });
  const bashProcesses = { execute: async () => { throw new Error('这里只验证注入，不执行命令。'); } };
  try {
    await factory.create({ cwd, agentDir, sessionDir: join(root, 'sessions'), config, assistantSessionId: 'work-session', bashProcesses });
    assert.deepEqual(captured[0]!.tools, ['read', 'bash', 'edit', 'write']);
    assert.deepEqual(captured[0]!.customTools?.map(tool => tool.name), ['bash']);
    const parameters = captured[0]!.customTools![0]!.parameters as ReturnType<typeof Type.Object>;
    assert.ok(parameters.properties.mode); assert.match(captured[0]!.customTools![0]!.description, /background/);
    await factory.create({ cwd, agentDir, sessionDir: join(root, 'reading'), config: { ...config, readingOnly: true }, assistantSessionId: 'reading-session', bashProcesses });
    assert.deepEqual(captured[1]!.tools, []); assert.equal(captured[1]!.customTools, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
