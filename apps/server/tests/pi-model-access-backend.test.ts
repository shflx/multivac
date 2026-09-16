import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import type { ModelProfileInput } from '@multivac/contracts';
import { PiModelAccessBackend, piLiteralApiKey, securePiAuthFile } from '../src/runtime/executors/pi-model-access-backend.js';
import { ModelAccessError } from '../src/modules/model-settings/model-access.js';
import { createPiCredentialStore } from '../src/runtime/executors/pi-guarded-credential-store.js';

const profile: ModelProfileInput = {
  profileId: 'custom-profile', displayName: 'Custom', provider: 'custom-provider', modelId: 'model',
  protocol: 'openai-responses', endpoint: 'https://custom.example/v1',
};

for (const action of ['configure', 'revoke'] as const) {
  for (const type of ['oauth', 'api_key'] as const) {
    test(`真实 Pi ${action} 查询后写前外部替换 ${type}，同锁类型/版本检查拒绝且保留外部凭据`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'multivac-pi-credential-race-'));
      const authPath = join(root, 'auth.json');
      let entered!: () => void; let release!: () => void;
      const entry = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let armed = false;
      const backend = new PiModelAccessBackend({ authPath, createRuntime: async (options) => {
        const runtime = await ModelRuntime.create(options);
        const list = runtime.listCredentials.bind(runtime);
        runtime.listCredentials = async (options) => {
          const snapshot = await list(options);
          if (armed) { armed = false; entered(); await gate; }
          return snapshot;
        };
        return runtime;
      } });
      const signal = AbortSignal.timeout(10000);
      try {
        await backend.configure(profile, 'initial-key', signal);
        const external = await createPiCredentialStore(authPath);
        const replacement = type === 'oauth'
          ? { type: 'oauth' as const, access: 'external-access', refresh: 'external-refresh', expires: Date.now() + 3600000 }
          : { type: 'api_key' as const, key: 'external-key' };
        armed = true;
        const pending = action === 'configure' ? backend.configure(profile, 'must-not-overwrite', signal)
          : backend.revoke(profile, signal);
        const rejected = assert.rejects(pending, (error: unknown) => error instanceof ModelAccessError && error.code === 'ACCESS_CONFLICT');
        await entry;
        await external.modify(profile.provider, async () => replacement, { signal });
        const before = await readFile(authPath, 'utf8');
        release(); await rejected;
        assert.deepEqual(await external.read(profile.provider, { signal }), replacement);
        assert.equal(await readFile(authPath, 'utf8'), before);
        assert.equal((await stat(authPath)).mode & 0o777, 0o600);
      } finally { release(); await rm(root, { recursive: true, force: true }); }
    });
  }
}

test('真实 Pi Cloudflare 多字段 API Key 入口不宣称可配置，普通 Key Provider 仍可配置', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-cloudflare-'));
  const authPath = join(root, 'auth.json');
  const backend = new PiModelAccessBackend({ authPath });
  const signal = AbortSignal.timeout(10000);
  try {
    await securePiAuthFile(authPath);
    const modelsPath = join(root, 'models.json');
    await writeFile(modelsPath, '{"providers":{}}');
    const native = await ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false, signal });
    for (const provider of ['cloudflare-workers-ai', 'cloudflare-ai-gateway']) {
      const prompts: string[] = [];
      const login = native.getProvider(provider)?.auth.apiKey?.login;
      assert.ok(login);
      // 直接检查原生能力函数，不调用 runtime.login，不写入探测返回的 credential。
      await login({ signal, notify: () => {}, prompt: async (prompt) => { prompts.push(prompt.type); return 'probe'; } });
      assert.deepEqual(prompts, provider === 'cloudflare-workers-ai' ? ['secret', 'text'] : ['secret', 'text', 'text']);
      const candidate = { ...profile, provider, protocol: 'openai-completions' as const };
      assert.equal((await backend.credentialInfo(candidate, signal)).configurable, false);
      const before = await readFile(authPath, 'utf8');
      await assert.rejects(backend.configure(candidate, 'must-not-persist', signal), (error: unknown) =>
        error instanceof ModelAccessError && error.code === 'CREDENTIAL_UNSUPPORTED');
      assert.equal(await readFile(authPath, 'utf8'), before);
    }
    for (const provider of ['openai', 'anthropic', profile.provider]) {
      const candidate = { ...profile, provider, protocol: provider === 'anthropic' ? 'anthropic-messages' as const : profile.protocol };
      assert.equal((await backend.credentialInfo(candidate, signal)).configurable, true);
      await backend.configure(candidate, 'simple-test-only', signal);
      assert.equal((await backend.credentialInfo(candidate, signal)).storedApiKey, true);
      await backend.revoke(candidate, signal);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('本地 HTTP upstream 经真实 Pi completeSimple 取消/超时且上游错误只返回安全码', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-http-check-'));
  let entered!: () => void;
  let closed!: () => void;
  let fail = false;
  let requests = 0;
  const upstream = createServer((_request, response) => {
    requests += 1;
    response.on('close', () => closed?.());
    entered?.();
    if (fail) { response.writeHead(400, { 'content-type': 'application/json' }); response.end('{"error":{"message":"private-upstream-secret"}}'); }
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address() as import('node:net').AddressInfo;
  const candidate = { ...profile, protocol: 'openai-completions' as const, endpoint: `http://127.0.0.1:${address.port}/v1` };
  const backend = new PiModelAccessBackend({ authPath: join(root, 'auth.json') });
  try {
    await backend.configure(candidate, 'local-test-only', AbortSignal.timeout(5000));
    for (const code of ['CHECK_CANCELLED', 'CHECK_TIMEOUT'] as const) {
      const entry = new Promise<void>((resolve) => { entered = resolve; });
      const close = new Promise<void>((resolve) => { closed = resolve; });
      const controller = new AbortController();
      const checking = backend.check(candidate, controller.signal);
      const rejected = assert.rejects(checking, (error: unknown) => error instanceof ModelAccessError && error.code === code);
      await entry;
      const timer = setTimeout(() => controller.abort(new ModelAccessError(code)), code === 'CHECK_TIMEOUT' ? 30 : 0);
      await rejected;
      clearTimeout(timer);
      await close;
    }
    fail = true;
    await assert.rejects(backend.check(candidate, AbortSignal.timeout(5000)), (error: unknown) =>
      error instanceof ModelAccessError && error.code === 'CHECK_FAILED' && !error.message.includes('private'));
    assert.equal(requests, 3);
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('真实 Pi CredentialStore 保存/撤销字面 API Key，权限 0600，已有 runtime 读取更新且模型不变', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-key-'));
  const directory = join(root, 'agent');
  await mkdir(directory, { mode: 0o700 });
  const authPath = join(directory, 'auth.json');
  const modelsPath = join(directory, 'models.json');
  await writeFile(authPath, '{}', { mode: 0o644 });
  await writeFile(modelsPath, JSON.stringify({ providers: {
    [profile.provider]: { baseUrl: profile.endpoint, api: profile.protocol, models: [{ id: profile.modelId }] },
  } }));
  const backend = new PiModelAccessBackend({ authPath });
  const signal = AbortSignal.timeout(5000);
  let session: AgentSession | undefined;
  try {
    assert.equal((await backend.credentialInfo(profile, signal)).storedApiKey, false);
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);
    const bound = await ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false });
    const fixedModel = bound.getModel(profile.provider, profile.modelId)!;
    assert.ok(fixedModel);
    session = (await createAgentSession({ cwd: root, agentDir: directory, modelRuntime: bound, model: fixedModel,
      settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], skills: [], prompts: [], themes: [] }),
      sessionManager: SessionManager.inMemory(root), noTools: 'all', tools: [],
    })).session;
    const turnModel = session.model;
    for (const key of ['!literal-$UNSET_TEST_VALUE', 'second$$!key', 'final-key']) {
      await backend.configure(profile, key, signal);
      const stored = JSON.parse(await readFile(authPath, 'utf8')) as Record<string, { type: string; key: string }>;
      assert.equal(stored[profile.provider]?.type, 'api_key');
      assert.equal(stored[profile.provider]?.key, piLiteralApiKey(key));
      const auth = await bound.getAuth(fixedModel, { signal });
      assert.equal(auth?.auth.apiKey, key);
      assert.equal((await bound.checkAuth(profile.provider, { signal }))?.type, 'api_key');
      assert.ok((await bound.getAvailable(profile.provider, { signal })).some((model) => model.id === profile.modelId));
      assert.deepEqual(bound.getModel(profile.provider, profile.modelId), fixedModel);
      assert.equal(session.model, turnModel);
      assert.equal((await stat(authPath)).mode & 0o777, 0o600);
      const info = await backend.credentialInfo(profile, signal);
      assert.deepEqual(info, { storedApiKey: true, configurable: true });
      assert.equal(JSON.stringify(info).includes(key), false);
    }
    await backend.revoke(profile, signal);
    assert.equal((await backend.credentialInfo(profile, signal)).storedApiKey, false);
    assert.equal(await bound.getAuth(fixedModel, { signal }), undefined);
    assert.equal(await bound.checkAuth(profile.provider, { signal }), undefined);
    assert.equal((await bound.getAvailable(profile.provider, { signal })).length, 0);
    assert.deepEqual(bound.getModel(profile.provider, profile.modelId), fixedModel);
    assert.equal(session.model, turnModel);
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);
    assert.equal((await readFile(authPath, 'utf8')).includes('final-key'), false);
  } finally { session?.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('auth.json 拒绝符号链接/硬链接；只撤销 API Key，不操作已有 OAuth 凭据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-key-permissions-'));
  const real = join(root, 'real.json');
  const alias = join(root, 'alias.json');
  await writeFile(real, '{}', { mode: 0o600 });
  try {
    await symlink(real, alias);
    await assert.rejects(securePiAuthFile(alias));
    await rm(alias);
    await link(real, alias);
    await assert.rejects(securePiAuthFile(alias));
    await rm(alias);
    await chmod(real, 0o644);
    await securePiAuthFile(real);
    assert.equal((await stat(real)).mode & 0o777, 0o600);
    const oauth = { [profile.provider]: { type: 'oauth', access: 'private-access', refresh: 'private-refresh', expires: Date.now() + 3600_000 } };
    await writeFile(real, JSON.stringify(oauth));
    const backend = new PiModelAccessBackend({ authPath: real });
    const signal = AbortSignal.timeout(5000);
    assert.equal((await backend.credentialInfo(profile, signal)).configurable, false);
    await assert.rejects(backend.revoke(profile, signal), (error: unknown) => error instanceof ModelAccessError && error.code === 'CREDENTIAL_UNSUPPORTED');
    await assert.rejects(backend.configure(profile, 'key', signal));
    assert.deepEqual(JSON.parse(await readFile(real, 'utf8')), oauth);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('四协议连接检查统一调用 Pi 请求能力并丢弃响应/上游文本，传递取消和禁用重试', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-check-'));
  const authPath = join(root, 'auth.json');
  const protocols: ModelProfileInput['protocol'][] = ['openai-responses', 'openai-completions', 'anthropic-messages', 'google-generative-ai'];
  let requests = 0;
  let fail = false;
  const backend = new PiModelAccessBackend({ authPath, createRuntime: async (options) => {
    const runtime = await ModelRuntime.create(options);
    runtime.completeSimple = async (model, context, request) => {
      requests += 1;
      assert.equal(request?.maxRetries, 0);
      assert.equal(request?.maxTokens, 16);
      assert.ok(request?.signal);
      assert.equal(model.provider, profile.provider);
      assert.equal(context.messages.length, 1);
      return { stopReason: fail ? 'error' : 'stop', content: [{ type: 'text', text: 'private-response' }],
        errorMessage: 'private-upstream-key' } as never;
    };
    return runtime;
  } });
  const signal = AbortSignal.timeout(10_000);
  try {
    for (const protocol of protocols) {
      const candidate = { ...profile, protocol };
      await backend.configure(candidate, 'stored-secret', signal);
      await backend.check(candidate, signal);
    }
    assert.equal(requests, 4);
    fail = true;
    await assert.rejects(backend.check(profile, signal), (error: unknown) => error instanceof ModelAccessError &&
      error.code === 'CHECK_FAILED' && !error.message.includes('private'));
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(backend.check(profile, cancelled.signal));
  } finally { await rm(root, { recursive: true, force: true }); }
});
