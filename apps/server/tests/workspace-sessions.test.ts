import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  GLOBAL_ASSISTANT_SESSION_ID,
  type CoordinatorRuntimeConfig,
  type WorkspaceSession,
} from '@multivac/contracts';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { SessionRuntimeRegistry, type SessionRuntime } from '../src/application/session-runtimes.js';
import {
  WorkspaceSessionService,
  WorkspaceSessionServiceError,
} from '../src/application/workspace-session-service.js';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
  SqliteSessionRegistryRepository,
  SqliteSessionSelectionRepository,
} from '../src/storage/sqlite-assistant-store.js';

const config: CoordinatorRuntimeConfig = {
  systemPrompt: '你是 Multivac。',
  authorizedContext: [],
  model: { provider: 'fake', modelId: 'fake', thinkingLevel: 'off' },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
};

interface TestRuntime extends SessionRuntime {
  session: AssistantSessionService;
}

function harness(root: string, options: { failNewSession?: () => boolean } = {}) {
  const store = new SqliteAssistantStore(join(root, 'data.sqlite'));
  const adapter = new FakeCoordinatorAdapter({ sessionPathRoot: join(root, 'sessions') });
  const bindingRepository = new SqliteAssistantBindingRepository(store);
  const pageStateRepository = new SqliteAssistantPageStateRepository(store);
  const selectionRepository = new SqliteSessionSelectionRepository(store);
  const runtimes = new SessionRuntimeRegistry<TestRuntime>((record) => {
    const session = new AssistantSessionService({
      adapter,
      bindingRepository,
      pageStateRepository,
      selectionRepository,
      runtimeConfig: config,
      kind: 'work',
      sessionDir: join(root, 'sessions', 'work'),
      assistantSessionId: record.sessionId,
      resolveNewSessionRuntimeConfig: async () => {
        if (options.failNewSession?.()) throw new Error('模型不可用');
        return config;
      },
    });
    return {
      sessionId: record.sessionId,
      session,
      initialize: () => session.initialize(),
      dispose: () => adapter.disposeSession(record.sessionId),
    };
  });
  let clock = 0;
  const service = new WorkspaceSessionService({
    repository: new SqliteSessionRegistryRepository(store),
    runtimes,
    now: () => new Date(Date.UTC(2026, 8, 25, 8, 0, clock++)).toISOString(),
  });
  return { store, adapter, runtimes, service, pageStateRepository, bindingRepository };
}

test('迁移后注册表含全局协调会话，工作会话新建独立 Pi session 且页面现场按会话隔离', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-workspace-sessions-'));
  const { store, adapter, runtimes, service, pageStateRepository, bindingRepository } = harness(root);
  try {
    const coordinator = new SqliteSessionRegistryRepository(store).get(GLOBAL_ASSISTANT_SESSION_ID);
    assert.equal(coordinator?.kind, 'coordinator');
    assert.equal(coordinator?.archivedAt, null);
    assert.deepEqual(service.list().sessions, []);

    const first = await service.create({ sessionId: 'work-1', title: '  整理需求  ' });
    const second = await service.create({ sessionId: 'work-2', title: '核对接口' });
    assert.equal(first.created, true);
    assert.equal(first.session.title, '整理需求');
    assert.deepEqual(service.list().sessions.map((session) => session.sessionId), ['work-1', 'work-2']);

    // 每个工作会话都新建独立的 Pi session，文件位于工作会话目录。
    const creations = adapter.calls.filter((call) => call.method === 'createSession');
    assert.deepEqual(creations.map((call) => call.input.assistantSessionId), ['work-1', 'work-2']);
    const binding = bindingRepository.get('work-1');
    assert.ok(binding?.piSessionPath.startsWith(join(root, 'sessions', 'work')));
    assert.notEqual(binding?.piSessionId, bindingRepository.get('work-2')?.piSessionId);
    assert.equal(new SqliteSessionRegistryRepository(store).get('work-1')?.piSessionPath, binding?.piSessionPath);

    // 草稿与阅读位置按会话保存，互不覆盖。
    pageStateRepository.save('work-1', {
      draft: '会话一草稿', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: 0,
    });
    assert.equal(pageStateRepository.get('work-1').draft, '会话一草稿');
    assert.equal(pageStateRepository.get('work-2').draft, '');
    assert.equal(pageStateRepository.get(GLOBAL_ASSISTANT_SESSION_ID).draft, '');

    // 同 id 同标题重试返回既有会话，不再新建 Pi session。
    const replay = await service.create({ sessionId: 'work-1', title: '整理需求' });
    assert.equal(replay.created, false);
    assert.equal(adapter.calls.filter((call) => call.method === 'createSession').length, 2);
    await assert.rejects(
      service.create({ sessionId: 'work-1', title: '另一个标题' }),
      (error: unknown) => error instanceof WorkspaceSessionServiceError && error.code === 'SESSION_ID_CONFLICT',
    );
    await assert.rejects(
      service.create({ sessionId: GLOBAL_ASSISTANT_SESSION_ID, title: '冒充全局会话' }),
      (error: unknown) => error instanceof WorkspaceSessionServiceError && error.code === 'SESSION_ID_CONFLICT',
    );
    await assert.rejects(
      service.create({ sessionId: 'work-3', title: '   ' }),
      (error: unknown) => error instanceof WorkspaceSessionServiceError && error.code === 'INVALID_REQUEST',
    );

    // 改名与归档：归档后不再列出，并释放该会话的 Pi 运行时。
    assert.equal(service.rename('work-2', ' 接口核对 ').title, '接口核对');
    const archived = service.archive('work-1');
    assert.ok(archived.archivedAt);
    assert.equal(runtimes.get('work-1'), undefined);
    assert.ok(adapter.calls.some((call) => call.method === 'disposeSession' && call.assistantSessionId === 'work-1'));
    assert.deepEqual(service.list().sessions.map((session) => session.title), ['接口核对']);
    assert.throws(() => service.rename('work-1', '已归档'), WorkspaceSessionServiceError);
    assert.throws(
      () => service.archive(GLOBAL_ASSISTANT_SESSION_ID),
      (error: unknown) => error instanceof WorkspaceSessionServiceError && error.code === 'INVALID_REQUEST',
    );
    assert.throws(
      () => service.rename('missing', '不存在'),
      (error: unknown) => error instanceof WorkspaceSessionServiceError && error.code === 'NOT_FOUND',
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Pi session 建立失败时回收注册记录，同一 id 可重试', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-workspace-sessions-fail-'));
  let failing = true;
  const { store, service } = harness(root, { failNewSession: () => failing });
  try {
    await assert.rejects(service.create({ sessionId: 'work-retry', title: '重试会话' }), /模型不可用/u);
    assert.equal(new SqliteSessionRegistryRepository(store).get('work-retry'), undefined);
    assert.deepEqual(service.list().sessions, []);

    failing = false;
    const retried = await service.create({ sessionId: 'work-retry', title: '重试会话' });
    assert.equal(retried.created, true);
    assert.deepEqual(service.list().sessions.map((session) => session.sessionId), ['work-retry']);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('v8 数据库升级后全局会话记录沿用既有绑定时间，页面现场与选模不变', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-workspace-sessions-upgrade-'));
  const databasePath = join(root, 'data.sqlite');
  try {
    const legacy = new SqliteAssistantStore(databasePath);
    new SqliteAssistantBindingRepository(legacy).insertIfAbsent({
      assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID,
      piSessionId: 'pi-legacy',
      piSessionPath: '/legacy/session.jsonl',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    new SqliteAssistantPageStateRepository(legacy).save(GLOBAL_ASSISTANT_SESSION_ID, {
      draft: '升级前草稿', anchorEntryId: 'entry-9', anchorOffsetPx: 12, quote: null, revision: 0,
    });
    legacy.close();

    // 退回 v8：删除注册表与迁移记录，模拟尚未升级的数据库。
    const raw = new DatabaseSync(databasePath);
    raw.exec(`
      DROP TABLE assistant_session_registry;
      DELETE FROM schema_migrations WHERE version >= 9;
    `);
    raw.close();

    const upgraded = new SqliteAssistantStore(databasePath);
    const registry = new SqliteSessionRegistryRepository(upgraded);
    const coordinator = registry.get(GLOBAL_ASSISTANT_SESSION_ID);
    assert.equal(coordinator?.createdAt, '2026-09-01T00:00:00.000Z');
    assert.equal(coordinator?.piSessionPath, '/legacy/session.jsonl');
    assert.deepEqual(new SqliteAssistantPageStateRepository(upgraded).get(GLOBAL_ASSISTANT_SESSION_ID), {
      draft: '升级前草稿', anchorEntryId: 'entry-9', anchorOffsetPx: 12, quote: null, revision: 1,
    });
    upgraded.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function httpJson(
  port: number,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: '127.0.0.1', port, path, method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
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

async function startApplication(root: string) {
  const app = createMultivacApplication({ MULTIVAC_DATA_DIR: root, MULTIVAC_FAKE_ASSISTANT: '1' });
  await app.ready;
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  return {
    port: address.port,
    async close() {
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
      app.close();
    },
  };
}

test('HTTP 新建、列出、改名、归档会话，重启后列表与各自页面现场保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-workspace-sessions-http-'));
  let running = await startApplication(root);
  try {
    const empty = await httpJson(running.port, '/api/sessions');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { workspaceId: 'default', sessions: [] });

    const created = await httpJson(running.port, '/api/sessions', 'POST', { sessionId: 'http-1', title: '方案讨论' });
    assert.equal(created.status, 201);
    assert.equal((created.body as WorkspaceSession).kind, 'work');
    const replay = await httpJson(running.port, '/api/sessions', 'POST', { sessionId: 'http-1', title: '方案讨论' });
    assert.equal(replay.status, 200);
    const conflict = await httpJson(running.port, '/api/sessions', 'POST', { sessionId: 'http-1', title: '别的' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'SESSION_ID_CONFLICT');
    assert.equal((await httpJson(running.port, '/api/sessions', 'POST', { sessionId: 'http-2' })).status, 400);
    assert.equal((await httpJson(running.port, '/api/sessions', 'POST', { sessionId: 'bad id', title: 'x' })).status, 400);
    await httpJson(running.port, '/api/sessions', 'POST', { sessionId: 'http-2', title: '待归档' });

    const renamed = await httpJson(running.port, '/api/sessions/http-1', 'PATCH', { title: '方案讨论（二）' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.title, '方案讨论（二）');
    assert.equal((await httpJson(running.port, '/api/sessions/missing', 'PATCH', { title: 'x' })).status, 404);
    assert.equal((await httpJson(running.port, `/api/sessions/${GLOBAL_ASSISTANT_SESSION_ID}/archive`, 'POST')).status, 400);
    const archived = await httpJson(running.port, '/api/sessions/http-2/archive', 'POST');
    assert.equal(archived.status, 200);
    assert.ok(archived.body.archivedAt);

    // 工作会话的页面现场独立保存，重启后仍在。
    const draftStore = new SqliteAssistantStore(join(root, 'multivac.sqlite'));
    new SqliteAssistantPageStateRepository(draftStore).save('http-1', {
      draft: '重启前的会话草稿', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: 0,
    });
    draftStore.close();

    await running.close();
    running = await startApplication(root);
    const listed = await httpJson(running.port, '/api/sessions');
    assert.deepEqual(listed.body.sessions.map((session: WorkspaceSession) => [session.sessionId, session.title]), [
      ['http-1', '方案讨论（二）'],
    ]);
    const reopened = new SqliteAssistantStore(join(root, 'multivac.sqlite'));
    assert.equal(new SqliteAssistantPageStateRepository(reopened).get('http-1').draft, '重启前的会话草稿');
    assert.equal(new SqliteAssistantPageStateRepository(reopened).get(GLOBAL_ASSISTANT_SESSION_ID).draft, '');
    reopened.close();
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('工作区现场按工作区保存，读取时剔除已归档会话，重启后原样恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-workspace-scene-'));
  let running = await startApplication(root);
  try {
    const initial = await httpJson(running.port, '/api/workspaces/default/scene');
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body, {
      workspaceId: 'default',
      scene: { order: [], focusedSessionId: null, viewMode: 'parallel', split: 0.5, barVisible: true },
    });
    for (const [sessionId, title] of [['scene-a', '现场一'], ['scene-b', '现场二'], ['scene-c', '现场三']]) {
      await httpJson(running.port, '/api/sessions', 'POST', { sessionId, title });
    }
    const scene = {
      order: ['scene-c', 'scene-a', 'scene-b', 'scene-a', 'missing'],
      focusedSessionId: 'scene-a', viewMode: 'focus', split: 0.62, barVisible: false,
    };
    const saved = await httpJson(running.port, '/api/workspaces/default/scene', 'PUT', scene);
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.scene.order, ['scene-c', 'scene-a', 'scene-b']);
    assert.equal((await httpJson(running.port, '/api/workspaces/default/scene', 'PUT', { ...scene, split: 2 })).status, 400);
    assert.equal((await httpJson(running.port, '/api/workspaces/other/scene')).status, 404);

    // 归档正在展示的当前会话后，现场自动移除它。
    await httpJson(running.port, '/api/sessions/scene-a/archive', 'POST');
    const afterArchive = await httpJson(running.port, '/api/workspaces/default/scene');
    assert.deepEqual(afterArchive.body.scene, {
      order: ['scene-c', 'scene-b'], focusedSessionId: null, viewMode: 'focus', split: 0.62, barVisible: false,
    });

    await running.close();
    running = await startApplication(root);
    const restored = await httpJson(running.port, '/api/workspaces/default/scene');
    assert.deepEqual(restored.body.scene, afterArchive.body.scene);
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});
