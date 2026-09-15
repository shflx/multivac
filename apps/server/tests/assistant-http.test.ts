import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ASSISTANT_DRAFT_MAX_UTF8_BYTES,
  type CoordinatorRuntimeConfig,
} from '@multivac/contracts';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { AssistantEventProjector } from '../src/application/assistant-event-projector.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { AssistantTurnCommandService } from '../src/application/assistant-turn-command-service.js';
import { createMultivacHttpServer } from '../src/bootstrap/server.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantCommandRepository,
  SqliteAssistantEventRepository,
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
} from '../src/storage/sqlite-assistant-store.js';

const config: CoordinatorRuntimeConfig = {
  systemPrompt: '你是协调助手。',
  authorizedContext: [],
  model: { provider: 'fake', modelId: 'fake', thinkingLevel: 'off' },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
};

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

function httpJson(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request({
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
          headers: response.headers,
          body: text ? JSON.parse(text) : undefined,
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('assistant HTTP 校验分页、页面状态、revision 和本地安全边界', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-assistant-http-'));
  const store = new SqliteAssistantStore(join(root, 'data.sqlite'));
  const adapter = new FakeCoordinatorAdapter({
    history: [1, 2, 3].map((index) => ({
      id: `fixture:${index}`,
      piSessionId: 'fixture',
      piEntryId: `entry-${index}`,
      role: index % 2 === 0 ? 'assistant' as const : 'user' as const,
      text: `消息 ${index}`,
      createdAt: '2026-09-14T08:00:00.000Z',
    })),
  });
  const service = new AssistantSessionService({
    adapter,
    bindingRepository: new SqliteAssistantBindingRepository(store),
    pageStateRepository: new SqliteAssistantPageStateRepository(store),
    runtimeConfig: config,
  });
  const commandRepository = new SqliteAssistantCommandRepository(store);
  const eventRepository = new SqliteAssistantEventRepository(store);
  const eventStream = new AssistantEventStream();
  const commandService = new AssistantTurnCommandService({
    sessionService: service,
    adapter,
    commandRepository,
    eventStream,
  });
  await service.initialize();
  const projector = new AssistantEventProjector({
    adapter,
    eventRepository,
    eventStream,
    assistantSessionId: 'global-coordinator',
    currentPromptCommandId: () => commandService.currentPromptCommandId(),
  });
  projector.start();
  const server = createMultivacHttpServer({
    service,
    commandService,
    eventRepository,
    eventStream,
    pageStateBodyLimitBytes: 20 * 1024,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const page = await httpJson(address.port, '/api/assistant/session?limit=2');
    assert.equal(page.status, 200);
    assert.deepEqual((page.body as { messages: Array<{ piEntryId: string }> }).messages.map(
      (message) => message.piEntryId,
    ), ['entry-2', 'entry-3']);

    assert.equal((await httpJson(address.port, '/api/assistant/session?limit=0')).status, 400);
    assert.equal((await httpJson(address.port, '/api/assistant/session?unknown=1')).status, 400);
    assert.equal((await httpJson(address.port, '/api/assistant/session?before=missing')).status, 400);

    const initialState = await httpJson(address.port, '/api/assistant/page-state');
    assert.deepEqual(initialState.body, {
      draft: '', anchorEntryId: null, anchorOffsetPx: 0, revision: 0,
    });
    const saved = await httpJson(address.port, '/api/assistant/page-state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draft: '未发送草稿', anchorEntryId: 'entry-2', anchorOffsetPx: 14, revision: 0,
      }),
    });
    assert.equal(saved.status, 200);
    assert.equal((saved.body as { revision: number }).revision, 1);
    const conflict = await httpJson(address.port, '/api/assistant/page-state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft: '旧状态', anchorEntryId: null, anchorOffsetPx: 0, revision: 0 }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((conflict.body as { error: { code: string } }).error.code, 'PAGE_STATE_CONFLICT');

    assert.equal((await httpJson(address.port, '/api/assistant/page-state', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    })).status, 415);
    const oversizedAscii = await httpJson(address.port, '/api/assistant/page-state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draft: 'x'.repeat(ASSISTANT_DRAFT_MAX_UTF8_BYTES + 1),
        anchorEntryId: null,
        anchorOffsetPx: 0,
        revision: 1,
      }),
    });
    assert.equal(oversizedAscii.status, 413);
    assert.equal((oversizedAscii.body as { error: { code: string } }).error.code, 'BODY_TOO_LARGE');

    const oversizedChinese = await httpJson(address.port, '/api/assistant/page-state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draft: '中'.repeat(Math.floor(ASSISTANT_DRAFT_MAX_UTF8_BYTES / 3) + 1),
        anchorEntryId: null,
        anchorOffsetPx: 0,
        revision: 1,
      }),
    });
    assert.equal(oversizedChinese.status, 413);
    assert.equal((oversizedChinese.body as { error: { code: string } }).error.code, 'BODY_TOO_LARGE');

    assert.equal((await httpJson(address.port, '/api/assistant/page-state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft: 'x'.repeat(21 * 1024) }),
    })).status, 413);

    const evilOrigin = await httpJson(address.port, '/api/assistant/page-state', {
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(evilOrigin.status, 403);
    assert.equal((evilOrigin.body as { error: { code: string } }).error.code, 'ORIGIN_NOT_ALLOWED');

    const evilHost = await httpJson(address.port, '/api/assistant/page-state', {
      headers: { host: 'evil.example' },
    });
    assert.equal(evilHost.status, 403);
    assert.equal((evilHost.body as { error: { code: string } }).error.code, 'HOST_NOT_ALLOWED');
    assert.equal((await httpJson(address.port, '/api/missing')).status, 404);
    assert.equal((await httpJson(
      address.port,
      '/api/__e2e/assistant/prompt-completion/arm',
      { method: 'POST' },
    )).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    projector.close();
    adapter.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
