import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { resolveRuntimeConfig } from '../src/runtime-config.js';
import { resolvePiInstancePaths } from '../src/runtime/executors/pi-instance-paths.js';
import { securePiAuthFile } from '../src/runtime/executors/pi-credential-security.js';
import { createPiCredentialStore } from '../src/runtime/executors/pi-guarded-credential-store.js';

test('开发 Pi 不查询全局配置；独立凭据增删不改变生产样本', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-instance-auth-'));
  try {
    const home = join(root, 'home');
    await mkdir(home);
    const production = resolveRuntimeConfig({ MULTIVAC_DATA_DIR: join(root, 'prod-data'), MULTIVAC_WORK_ROOT: join(root, 'prod-work') }, undefined, home);
    const development = resolveRuntimeConfig({ MULTIVAC_MODE: 'development', MULTIVAC_DATA_DIR: join(root, 'dev-data'), MULTIVAC_WORK_ROOT: join(root, 'dev-work') }, undefined, home);
    const legacy = join(root, 'legacy-pi');
    const prod = resolvePiInstancePaths(production, () => legacy);
    const dev = resolvePiInstancePaths(development, () => { throw new Error('开发不得读取全局Pi目录'); });
    assert.equal(prod.agentDir, legacy);
    assert.equal(dev.agentDir, join(development.dataDir, 'pi'));
    await securePiAuthFile(prod.authPath);
    await securePiAuthFile(dev.authPath);
    const prodStore = await createPiCredentialStore(prod.authPath);
    const devStore = await createPiCredentialStore(dev.authPath);
    await prodStore.modify('openai', async () => ({ type: 'api_key', key: 'production-fixture-only' }));
    const baseline = await readFile(prod.authPath, 'utf8');
    const runtime = await ModelRuntime.create({ authPath: dev.authPath, modelsPath: null, modelsStorePath: dev.modelsStorePath, allowModelNetwork: false });
    assert.equal((await runtime.listCredentials()).some(entry => entry.providerId === 'openai'), false);
    await devStore.modify('openai', async () => ({ type: 'api_key', key: 'development-fixture-only' }));
    assert.equal((await devStore.read('openai'))?.type, 'api_key');
    assert.equal(await readFile(prod.authPath, 'utf8'), baseline);
    await devStore.delete('openai');
    assert.ok((await devStore.read('openai')) == null);
    assert.equal(await readFile(prod.authPath, 'utf8'), baseline);
    assert.equal((await prodStore.read('openai'))?.type, 'api_key');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('开发 Pi 根不能链接到外部配置', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-instance-link-'));
  try {
    const data = join(root, 'dev-data');
    const external = join(root, 'external-pi');
    await mkdir(data); await mkdir(external);
    await symlink(external, join(data, 'pi'));
    const config = resolveRuntimeConfig({ MULTIVAC_MODE: 'development', MULTIVAC_DATA_DIR: data, MULTIVAC_WORK_ROOT: join(root, 'work') }, undefined, root);
    assert.throws(() => resolvePiInstancePaths(config, () => external), /不能链接/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
