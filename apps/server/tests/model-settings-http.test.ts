import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MODEL_SETTINGS_BODY_LIMIT_BYTES } from '@multivac/contracts';
import { createModelSettingsRequestHandler } from '../src/adapters/http/model-settings-routes.js';
import { ModelSettingsService } from '../src/application/model-settings-service.js';
import { FakeModelSettingsCatalogFactory } from '../src/runtime/executors/fake-model-settings-catalog.js';
import { FileModelSettingsStore } from '../src/storage/file-model-settings-store.js';

function httpJson(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; text: string; body: unknown }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: options.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode ?? 0,
          text,
          body: text ? JSON.parse(text) : undefined,
        });
      });
    });
    outgoing.on('error', reject);
    if (options.body) outgoing.write(options.body);
    outgoing.end();
  });
}

test('模型设置 HTTP 校验非法体、危险 URL、revision，并确保响应和持久化无凭据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-model-http-'));
  const path = join(root, 'model-settings.json');
  const service = new ModelSettingsService(
    new FileModelSettingsStore(path),
    new FakeModelSettingsCatalogFactory(),
  );
  await service.initialize();
  const handler = createModelSettingsRequestHandler(service);
  const server = createServer((incoming, response) => void handler(incoming, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const validProfile = {
    profileId: 'http-model',
    displayName: 'HTTP Model',
    provider: 'http-provider',
    modelId: 'http-model',
    protocol: 'openai-responses',
    endpoint: 'https://models.example/v1',
  } as const;

  try {
    assert.deepEqual((await httpJson(address.port, '/api/model-settings')).body, {
      revision: 0,
      profiles: [],
      defaultProfileId: null,
      availability: [],
    });
    assert.equal((await httpJson(address.port, '/api/model-settings/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })).status, 400);
    assert.equal((await httpJson(address.port, '/api/model-settings/profiles', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    })).status, 415);
    assert.equal((await httpJson(address.port, '/api/model-settings/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: 'save:extra-secret',
        revision: 0,
        profile: { ...validProfile, apiKey: 'must-not-leak' },
      }),
    })).status, 400);

    const unsafe = await httpJson(address.port, '/api/model-settings/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: 'save:unsafe-query',
        revision: 0,
        profile: { ...validProfile, endpoint: 'https://models.example/v1?token=must-not-leak' },
      }),
    });
    assert.equal(unsafe.status, 400);
    assert.equal(unsafe.text.includes('must-not-leak'), false);

    const saved = await httpJson(address.port, '/api/model-settings/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'save:http-model', revision: 0, profile: validProfile }),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.text.includes('must-not-leak'), false);
    assert.equal((saved.body as { revision: number }).revision, 1);
    assert.equal((await readFile(path, 'utf8')).includes('must-not-leak'), false);

    const conflict = await httpJson(address.port, '/api/model-settings/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: 'save:stale-http-model',
        revision: 0,
        profile: { ...validProfile, displayName: 'Stale' },
      }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((conflict.body as { error: { code: string } }).error.code, 'MODEL_SETTINGS_CONFLICT');

    const oversized = await httpJson(address.port, '/api/model-settings/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(MODEL_SETTINGS_BODY_LIMIT_BYTES) }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
