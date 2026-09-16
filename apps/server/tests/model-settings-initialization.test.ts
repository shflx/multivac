import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

function httpJson(port: number, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST',
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' } } : {}),
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
      });
    });
    outgoing.on('error', reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('模型设置初始化故障保留管理接口，未知默认不创建替代 binding，修复后可重试', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-model-init-failure-'));
  const modelSettingsPath = join(root, 'model-settings.json');
  await writeFile(modelSettingsPath, '{invalid json', 'utf8');
  const application = createMultivacApplication({
    MULTIVAC_DATA_DIR: root,
    MULTIVAC_FAKE_ASSISTANT: '1',
  });
  await application.ready;
  await new Promise<void>((resolve) => application.server.listen(0, '127.0.0.1', resolve));
  const address = application.server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const assistant = await httpJson(address.port, '/api/assistant/page-state');
    assert.equal(assistant.status, 503);
    assert.equal((assistant.body as { error: { code: string } }).error.code, 'DEFAULT_MODEL_UNAVAILABLE');
    const inspection = new SqliteAssistantStore(application.paths.databasePath);
    assert.equal(inspection.getBinding('global-coordinator'), undefined);
    inspection.close();

    const unavailable = await httpJson(address.port, '/api/model-settings');
    assert.equal(unavailable.status, 503);
    assert.equal(
      (unavailable.body as { error: { code: string } }).error.code,
      'MODEL_SETTINGS_UNAVAILABLE',
    );

    await writeFile(modelSettingsPath, JSON.stringify({
      revision: 0,
      profiles: [],
      defaultProfileId: null,
      commands: [],
    }), 'utf8');
    const recovered = await httpJson(address.port, '/api/model-settings');
    assert.equal(recovered.status, 200);
    assert.deepEqual(recovered.body, {
      revision: 0,
      profiles: [],
      defaultProfileId: null,
      availability: [],
    });
    const restoredAssistant = await httpJson(address.port, '/api/assistant/page-state');
    assert.equal(restoredAssistant.status, 200);
    const sent = await httpJson(address.port, '/api/assistant/turns', {
      commandId: 'after-default-repair', assistantSessionId: 'global-coordinator',
      text: '验证修复后事件投影', contextRefs: [],
    });
    assert.equal(sent.status, 200);
    assert.equal((sent.body as { terminalOutcome: string }).terminalOutcome, 'succeeded');
    const restoredStore = new SqliteAssistantStore(application.paths.databasePath);
    assert.equal(restoredStore.getBinding('global-coordinator')?.modelSource, 'base');
    assert.equal(restoredStore.listAfter('0').some((event) => event.type === 'assistant.run.succeeded'), true);
    restoredStore.close();
  } finally {
    await new Promise<void>((resolve, reject) =>
      application.server.close((error) => error ? reject(error) : resolve()));
    application.close();
    await rm(root, { recursive: true, force: true });
  }
});
