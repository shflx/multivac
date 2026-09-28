import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { testApplicationEnvironment, testDataDir } from './fixtures/test-environment.js';

function settings(defaultProfileId: string) {
  return {
    revision: 0,
    profiles: [{
      profileId: 'profile-a',
      displayName: 'Model A',
      provider: 'provider-a',
      modelId: 'model-a',
      protocol: 'openai-responses',
      endpoint: 'https://a.example/v1',
    }, {
      profileId: 'profile-b',
      displayName: 'Model B',
      provider: 'provider-b',
      modelId: 'model-b',
      protocol: 'anthropic-messages',
      endpoint: 'https://b.example/v1',
    }],
    defaultProfileId,
    commands: [],
  };
}

test('新全局协调助手读取受控默认模型，重启恢复已有 binding 时保持原选择', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-default-session-'));
  const modelSettingsPath = join(testDataDir(root), 'model-settings.json');
  const databasePath = join(testDataDir(root), 'multivac.sqlite');
  await writeFile(modelSettingsPath, JSON.stringify(settings('profile-a')), 'utf8');

  try {
    const first = createMultivacApplication(testApplicationEnvironment(root));
    await first.ready;
    first.close();

    const afterCreate = new SqliteAssistantStore(databasePath);
    const createdBinding = afterCreate.getBinding('global-coordinator');
    afterCreate.close();
    assert.equal(createdBinding?.modelProvider, 'provider-a');
    assert.equal(createdBinding?.modelId, 'model-a');
    assert.equal(createdBinding?.modelProtocol, 'openai-responses');
    assert.equal(createdBinding?.modelEndpoint, 'https://a.example/v1');
    assert.equal(createdBinding?.modelResolvedEndpoint, 'https://a.example/v1');

    await writeFile(modelSettingsPath, JSON.stringify(settings('profile-b')), 'utf8');
    const second = createMultivacApplication(testApplicationEnvironment(root));
    await second.ready;
    second.close();

    const afterRestart = new SqliteAssistantStore(databasePath);
    const restoredBinding = afterRestart.getBinding('global-coordinator');
    afterRestart.close();
    assert.equal(restoredBinding?.modelProvider, 'provider-a');
    assert.equal(restoredBinding?.modelId, 'model-a');
    assert.equal(restoredBinding?.modelProtocol, 'openai-responses');
    assert.equal(restoredBinding?.modelEndpoint, 'https://a.example/v1');
    assert.equal(restoredBinding?.modelResolvedEndpoint, 'https://a.example/v1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
