import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

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
  const modelSettingsPath = join(root, 'model-settings.json');
  const databasePath = join(root, 'multivac.sqlite');
  await writeFile(modelSettingsPath, JSON.stringify(settings('profile-a')), 'utf8');

  try {
    const first = createMultivacApplication({
      MULTIVAC_DATA_DIR: root,
      MULTIVAC_FAKE_ASSISTANT: '1',
    });
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
    const second = createMultivacApplication({
      MULTIVAC_DATA_DIR: root,
      MULTIVAC_FAKE_ASSISTANT: '1',
    });
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
