import { remoteRouteAllowed } from '../src/adapters/http/remote-policy.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSettingsService } from '../src/application/web-settings-service.js';
import { createWebSettingsStore } from '../src/runtime/executors/pi-web-settings.js';
import type { WebProvider } from '../src/modules/web/web-provider.js';

const backend = (key: string): WebProvider => ({ id: 'deepseek', search: async () => [{ title: '页面', url: 'https://example.com', summary: key, publishedAt: null }], fetch: async url => ({ title: '页面', url, content: key }) });
const ctx = () => ({ signal: new AbortController().signal, maxBytes: 1000, received: () => {} });

test('网页配置：私有持久化、不回显密钥、即时启停与重启恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-web-settings-')), path = join(root, 'auth.json');
  try {
    let changes = 0;
    const store = createWebSettingsStore(path);
    const service = new WebSettingsService(store, undefined, (_provider, key) => backend(key), () => { changes++; });
    assert.equal((await service.get()).configured, false);
    await assert.rejects(service.resolve(), /尚未启用/u);
    await assert.rejects(service.update({ revision: 0, commandId: 'missing-key', enabled: true, provider: 'deepseek' }), /API Key/u);
    const saved = await service.update({ revision: 0, commandId: 'save', enabled: true, provider: 'deepseek', apiKey: 'secret-key' });
    assert.equal(saved.configured, true); assert.equal(saved.revision, 1);
    assert.doesNotMatch(JSON.stringify(saved), /secret-key|apiKey/u);
    assert.equal((await (await service.resolve()).fetch('https://example.com', ctx())).content, 'secret-key');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.match(await readFile(path, 'utf8'), /secret-key/u);
    const restarted = new WebSettingsService(createWebSettingsStore(path), undefined, (_provider, key) => backend(key), () => {});
    assert.deepEqual(await restarted.get(), saved);
    await service.update({ revision: 1, commandId: 'disable', enabled: false, provider: 'deepseek' });
    await assert.rejects(restarted.resolve(), /尚未启用/u);
    assert.equal((await service.get()).configured, true);
    await service.update({ revision: 2, commandId: 'remove', enabled: false, provider: 'deepseek', clearKey: true });
    assert.equal((await service.get()).configured, false);
    assert.doesNotMatch(await readFile(path, 'utf8'), /secret-key/u);
    assert.equal(changes, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('网页配置：相同命令幂等、不同参数拒绝、并发旧版本不能覆盖密钥', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-web-settings-'));
  try {
    const store = createWebSettingsStore(join(root, 'auth.json'));
    const service = new WebSettingsService(store, undefined, (_provider, key) => backend(key), () => {});
    const input = { revision: 0, commandId: 'one', enabled: true, provider: 'deepseek' as const, apiKey: 'first-key' };
    const first = await service.update(input);
    assert.deepEqual(await service.update(input), first);
    await assert.rejects(service.update({ ...input, apiKey: 'different-key' }), /不一致/u);
    const responses = await Promise.allSettled(['a', 'b'].map(commandId => service.update({ ...input, revision: 1, commandId, apiKey: commandId })));
    assert.equal(responses.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(responses.filter(value => value.status === 'rejected').length, 1);
    assert.equal((await service.get()).revision, 2);
    await assert.rejects(service.update(input), /别处修改/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('网页配置：环境变量显式覆盖，界面不能修改环境凭据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-web-settings-'));
  try {
    const store = createWebSettingsStore(join(root, 'auth.json'));
    await store;
    const service = new WebSettingsService(store, backend('environment-key'), (_provider, key) => backend(key), () => {});
    assert.equal((await service.get()).source, 'environment');
    await assert.rejects(service.update({ revision: 0, commandId: 'remove', enabled: false, provider: 'deepseek', clearKey: true }), /环境变量/u);
    assert.equal((await (await service.resolve()).fetch('https://example.com', ctx())).content, 'environment-key');
    assert.doesNotMatch(await readFile(join(root, 'auth.json'), 'utf8'), /environment-key/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('远程入口不开放网页配置与凭据写入', () => {
  assert.equal(remoteRouteAllowed('GET', '/api/web-settings'), false);
  assert.equal(remoteRouteAllowed('PUT', '/api/web-settings'), false);
});

test('网页配置：损坏凭据文件不回退到缓存，也不覆盖损坏内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-web-settings-')), path = join(root, 'auth.json');
  try {
    const store = createWebSettingsStore(path);
    const service = new WebSettingsService(store, undefined, (_provider, key) => backend(key), () => {});
    await service.update({ revision: 0, commandId: 'save', enabled: true, provider: 'deepseek', apiKey: 'old-key' });
    await service.resolve();
    await writeFile(path, '{broken');
    await assert.rejects(service.resolve(), /读取失败/u);
    await assert.rejects(service.get(), /读取失败/u);
    await assert.rejects(service.update({ revision: 1, commandId: 'overwrite', enabled: false, provider: 'deepseek' }), /待核对/u);
    assert.equal(await readFile(path, 'utf8'), '{broken');
  } finally { await rm(root, { recursive: true, force: true }); }
});
