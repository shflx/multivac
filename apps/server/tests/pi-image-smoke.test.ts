import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ModelProfileInput } from '@multivac/contracts';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { DefaultPiCoordinatorSessionFactory } from '../src/runtime/executors/pi-session-factory.js';

test('配置的真实模型识别图片内容并保存多模态历史', { skip: process.env.MULTIVAC_IMAGE_SMOKE !== '1', timeout: 90_000 }, async context => {
  const state = JSON.parse(await readFile(join(homedir(), '.multivac', 'model-settings.json'), 'utf8')) as { profiles: ModelProfileInput[]; defaultProfileId: string };
  const profile = state.profiles.find(value => value.profileId === (process.env.MULTIVAC_IMAGE_SMOKE_PROFILE ?? state.defaultProfileId));
  assert.ok(profile);
  const root = await mkdtemp(join(tmpdir(), 'multivac-real-image-'));
  await mkdir(join(root, 'agent')); await mkdir(join(root, 'workspace'));
  const authPath = join(root, 'agent', 'auth.json');
  await copyFile(join(homedir(), '.pi', 'agent', 'auth.json'), authPath); await chmod(authPath, 0o600);
  await copyFile(join(homedir(), '.pi', 'agent', 'models-store.json'), join(root, 'agent', 'models-store.json')).catch(() => {});
  const adapter = new PiCoordinatorAdapter({ agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), sessionFactory: new DefaultPiCoordinatorSessionFactory({ authPath }) });
  try {
    const created = await adapter.createSession({ assistantSessionId: 'real-image-smoke', workingDirectory: { kind: 'session-temp', path: join(root, 'workspace') }, config: {
      systemPrompt: 'Inspect the attached images. Do not use tools. For image-only messages, name the dominant colors in attachment order. Answer briefly.', authorizedContext: [],
      model: { source: 'controlled', profileId: profile.profileId, provider: profile.provider, modelId: profile.modelId, protocol: profile.protocol, endpoint: profile.endpoint, resolvedEndpoint: profile.endpoint, thinkingLevel: 'off' },
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1000 },
    } });
    assert.ok(created.ok, created.ok ? undefined : created.error.message);
    context.diagnostic(`实际配置：${profile.provider}/${profile.modelId}，图片能力：${adapter.supportsImageInput('real-image-smoke')}`);
    if (!adapter.supportsImageInput('real-image-smoke')) { context.skip('真实目录未声明当前配置支持图片；未发送、未换模型。'); return; }
    const data = await sharp({ create: { width: 200, height: 120, channels: 3, background: '#f00000' } }).png().toBuffer();
    const timeout = setTimeout(() => { void adapter.abort('real-image-smoke'); }, 60_000);
    try {
      const result = await adapter.prompt('real-image-smoke', 'What is the dominant color of the attached image? Reply with one English color word.', undefined, undefined, undefined, [{ id: 'smoke-image', mimeType: 'image/png', data: data.toString('base64') }]);
      assert.ok(result.ok); assert.equal(result.value.status, 'completed');
      const history = adapter.readActiveBranch('real-image-smoke'); assert.ok(history.ok);
      assert.ok(history.value.messages.some(message => message.role === 'user' && message.imageIds?.length === 1));
      assert.ok(history.value.messages.some(message => message.role === 'assistant' && /red/i.test(message.text)));
      context.diagnostic('真实模型识别 red，Pi 历史包含图片引用。');
      const blue = await sharp({ create: { width: 100, height: 200, channels: 3, background: '#0000f0' } }).png().toBuffer();
      const pure = await adapter.prompt('real-image-smoke', '', undefined, undefined, undefined, [{ id: 'red', mimeType: 'image/png', data: data.toString('base64') }, { id: 'blue', mimeType: 'image/png', data: blue.toString('base64') }]);
      assert.ok(pure.ok); assert.equal(pure.value.status, 'completed');
      const multi = adapter.readActiveBranch('real-image-smoke'); assert.ok(multi.ok);
      assert.ok(multi.value.messages.some(message => message.role === 'user' && message.text === '' && message.imageIds?.length === 2));
      assert.match(multi.value.messages.at(-1)!.text, /red[\s\S]*blue/i);
      context.diagnostic('纯图片多图请求识别 red → blue，空正文和双图片顺序恢复正确。');
    } finally { clearTimeout(timeout); }
  } finally { adapter.dispose(); await rm(root, { recursive: true, force: true }); }
});
