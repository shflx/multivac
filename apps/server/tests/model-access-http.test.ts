import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMultivacApplication } from '../src/bootstrap/application.js';

async function json(port: number, path: string, body?: unknown) {
  return new Promise<{ status: number; text: string; body: any }>((resolve, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port, path,
      method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, text, body: JSON.parse(text) });
      });
    });
    outgoing.on('error', reject); outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
test('HTTP 一次性 Key 不进入 SQLite/模型配置/安全账本或响应，拒绝非法体且更新认证状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-access-http-'));
  await writeFile(join(root, 'model-settings.json'), JSON.stringify({ revision: 0, defaultProfileId: null, commands: [], profiles: [{
    profileId: 'fixture-missing-auth', displayName: 'Missing', provider: 'missing-auth', modelId: 'model',
    protocol: 'openai-responses', endpoint: 'https://models.example/v1',
  }] }));
  const app = createMultivacApplication({ MULTIVAC_DATA_DIR: root, MULTIVAC_FAKE_ASSISTANT: '1' });
  await app.ready;
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address(); assert.ok(address && typeof address === 'object');
  const secret = 'must-not-leak-api-key';
  try {
    const snapshot = await json(address.port, '/api/model-access');
    const command = { commandId: 'key-command', profileId: 'fixture-missing-auth', revision: snapshot.body.revision,
      accessRevision: snapshot.body.accessRevision };
    const invalid = await json(address.port, '/api/model-access/api-key', { ...command, apiKey: secret, payloadHash: 'not-accepted' });
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body, { error: { code: 'INVALID_REQUEST' } });
    assert.equal(invalid.text.includes(secret), false);
    const result = await json(address.port, '/api/model-access/api-key', { ...command, apiKey: secret });
    assert.equal(result.status, 200);
    assert.equal(result.body.state, 'committed');
    assert.equal(result.text.includes(secret), false);
    const current = await json(address.port, '/api/model-access');
    assert.equal(current.body.credentials.find((entry: any) => entry.profileId === command.profileId).storedApiKey, true);
    const models = await json(address.port, '/api/model-settings');
    assert.equal(models.body.availability.find((entry: any) => entry.profileId === command.profileId).authenticated, true);
    const repeated = await json(address.port, '/api/model-access/api-key', { ...command, apiKey: 'different-input' });
    assert.equal(repeated.body.replayed, true);
    const revoked = await json(address.port, '/api/model-access/revoke-api-key', {
      ...command, commandId: 'revoke-command', revision: current.body.revision, accessRevision: current.body.accessRevision,
    });
    assert.equal(revoked.body.state, 'committed');
    const auth = await json(address.port, '/api/model-settings');
    assert.equal(auth.body.availability.find((entry: any) => entry.profileId === command.profileId).authenticated, false);
    for (const path of [app.paths.databasePath, app.paths.modelSettingsPath, app.paths.modelAccessPath]) {
      const content = await readFile(path);
      for (const value of [secret, createHash('sha256').update(secret).digest('hex')]) assert.equal(content.includes(Buffer.from(value)), false);
    }
    assert.equal(JSON.stringify([current.body, models.body, auth.body]).includes(secret), false);
  } finally {
    await new Promise<void>((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
    app.close(); await rm(root, { recursive: true, force: true });
  }
});
