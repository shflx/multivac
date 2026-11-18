import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { SUBAGENT_GIT_TOOLS } from '../src/application/internal-tools/subagent-git-tools.js';
import { listTasksTool } from '../src/application/internal-tools/task-query-tools.js';
import { observedModelRuntime } from '../src/runtime/executors/observed-model-runtime.js';
import { controlledFetch, controlledModel, responsesSDK, terminal } from './fixtures/responses-stream.js';

for (const strict of [undefined, true]) test(`Responses strict=${strict}：移除不支持的数组关键字，保留本地校验`, async () => {
  const { name, description, parameters } = SUBAGENT_GIT_TOOLS[0];
  const gitTool = { name, description, parameters,
    ...(strict && { constrainedSampling: { type: 'json_schema', strict: 'require' } as const }),
  };
  const nestedTool = { name: 'nested', description: 'Nested schema', parameters: Type.Object({
    uniqueItems: Type.Boolean(),
    groups: Type.Array(Type.Object({ files: Type.Array(Type.String(), { uniqueItems: true }) })),
  }) };
  const raw = { streamSimple: responsesSDK.streamSimple } as unknown as ModelRuntime;
  const runtime = observedModelRuntime(() => raw, 'session');
  const source = controlledFetch([terminal()]);
  let body: { tools: { strict?: boolean; parameters: { properties: Record<string, object> } }[] } | undefined;
  const model = { ...controlledModel, compat: { supportsStrictMode: strict } };
  const response = await runtime.streamSimple(model as never, { messages: [], tools: [gitTool, nestedTool] }, {
    apiKey: 'controlled',
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as NonNullable<typeof body>;
      const paths = body.tools[0].parameters.properties.paths;
      if ('uniqueItems' in paths) return Response.json({ error: { code: 'invalid_json_schema', message: 'Unimplemented keys: ["uniqueItems"]' } }, { status: 400 });
      return source.fetch(input, init);
    },
  }).result();

  assert.equal(response.stopReason, 'stop', response.errorMessage);
  assert.ok(body);
  const [git, nested] = body.tools;
  assert.equal(git.strict, strict ?? false);
  assert.equal(nested.strict, false);
  assert.deepEqual(git.parameters.properties.paths, { type: 'array', minItems: 1, maxItems: 100,
    items: { type: 'string', minLength: 1, maxLength: 1024 } });
  assert.deepEqual(nested.parameters.properties, {
    uniqueItems: { type: 'boolean' },
    groups: { type: 'array', items: { type: 'object', required: ['files'], properties: {
      files: { type: 'array', items: { type: 'string' } },
    } } },
  });
  assert.equal(Check(parameters, { paths: ['a.ts', 'a.ts'] }), false);
  assert.equal(Check(parameters, { paths: ['a.ts'] }), true);
});

test('Responses 的任务查询保留可选字段，并保留调用方对请求体的修改', async () => {
  const raw = { streamSimple: responsesSDK.streamSimple } as unknown as ModelRuntime;
  const runtime = observedModelRuntime(() => raw, 'session');
  const source = controlledFetch([terminal()]);
  const { name, description, parameters } = listTasksTool;
  let body: { metadata: { trace: string }; tools: { strict?: boolean; parameters: { required?: string[] } }[] } | undefined;
  const response = await runtime.streamSimple(controlledModel as never, { messages: [], tools: [{ name, description, parameters }] }, {
    apiKey: 'controlled',
    onPayload: async (payload) => ({ ...payload as object, metadata: { trace: 'preserved' } }),
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as NonNullable<typeof body>;
      return source.fetch(input, init);
    },
  }).result();

  assert.equal(response.stopReason, 'stop', response.errorMessage);
  assert.ok(body);
  assert.equal(body.metadata.trace, 'preserved');
  assert.equal(body.tools[0].strict, false);
  assert.deepEqual(body.tools[0].parameters.required ?? [], []);
  assert.equal(Check(parameters, { query: '待办' }), true);
});

test('非 Responses 协议继续接收原始工具定义', () => {
  const tools = [SUBAGENT_GIT_TOOLS[0]];
  const context = { messages: [], tools };
  const raw = { streamSimple: (_model: unknown, received: unknown) => { assert.equal(received, context); } } as unknown as ModelRuntime;
  observedModelRuntime(() => raw, 'session').streamSimple({ api: 'anthropic-messages' } as never, context);
});
