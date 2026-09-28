import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
import { SessionWorkingDirectories } from '../src/application/session-working-directories.js';
import { resolveMultivacWorkPaths } from '../src/storage/work-paths.js';
import { localDateStamp } from '../src/modules/sessions/working-directory.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
  SqliteSessionRegistryRepository,
  SqliteSessionSelectionRepository,
  SqliteWorkspaceRepository,
} from '../src/storage/sqlite-assistant-store.js';
import { testApplicationEnvironment, testDataDir, testWorkRoot } from './fixtures/test-environment.js';

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
  const repository = new SqliteSessionRegistryRepository(store);
  const workPaths = resolveMultivacWorkPaths(testWorkRoot(root), testDataDir(root));
  const workingDirectories = new SessionWorkingDirectories(workPaths, repository, testDataDir(root));
  const runtimes = new SessionRuntimeRegistry<TestRuntime>((record) => {
    const session = new AssistantSessionService({
      adapter,
      bindingRepository,
      pageStateRepository,
      selectionRepository,
      runtimeConfig: config,
      resolveWorkingDirectory: () => workingDirectories.resolveForRuntime(record.sessionId),
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
    repository,
    runtimes,
    workingDirectories,
    workspaces: new SqliteWorkspaceRepository(store),
    now: () => new Date(Date.UTC(2026, 8, 25, 8, 0, clock++)).toISOString(),
  });
  return { store, adapter, runtimes, service, pageStateRepository, bindingRepository, workPaths };
}

test('迁移后注册表含全局协调会话，工作会话新建独立 Pi session 且页面现场按会话隔离', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-workspace-sessions-'));
  const { store, adapter, runtimes, service, pageStateRepository, bindingRepository, workPaths } = harness(root);
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

    // 每个工作会话都有自己的临时工作目录，记录写入后目录已创建。
    assert.deepEqual(first.session.workingDirectory, {
      kind: 'session-temp', path: join(workPaths.sessionsDir, `${localDateStamp(new Date('2026-09-25T08:00:00.000Z'))}-整理需求-work1`),
    });
    assert.equal(statSync(first.session.workingDirectory.path).isDirectory(), true);
    assert.equal(statSync(second.session.workingDirectory.path).isDirectory(), true);

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
    // 重放沿用记录中的目录，不会再建第二个。
    assert.deepEqual(replay.session.workingDirectory, first.session.workingDirectory);
    assert.equal(readdirSync(workPaths.sessionsDir).length, 2);
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
  const { store, service, workPaths } = harness(root, { failNewSession: () => failing });
  try {
    await assert.rejects(service.create({ sessionId: 'work-retry', title: '重试会话' }), /模型不可用/u);
    assert.equal(new SqliteSessionRegistryRepository(store).get('work-retry'), undefined);
    assert.deepEqual(service.list().sessions, []);
    // 半成品的空临时目录一并回收。
    assert.deepEqual(readdirSync(workPaths.sessionsDir), []);

    failing = false;
    const retried = await service.create({ sessionId: 'work-retry', title: '重试会话' });
    assert.equal(retried.created, true);
    // 重试使用原本的目录名，不因上次失败追加序号。
    assert.equal(retried.session.workingDirectory.path, join(workPaths.sessionsDir, `${localDateStamp(new Date('2026-09-25T08:00:00.000Z'))}-重试会话-workretr`));
    assert.deepEqual(service.list().sessions.map((session) => session.sessionId), ['work-retry']);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('恢复已归档会话：回到原工作区，沿用工作目录与 Pi session，运行时按需重建；幂等并拒绝不存在与全局会话', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-workspace-sessions-restore-'));
  const { store, adapter, runtimes, service, bindingRepository } = harness(root);
  const code = (expected: string) => (error: unknown) =>
    error instanceof WorkspaceSessionServiceError && error.code === expected;
  try {
    const created = (await service.create({ sessionId: 'restore-1', title: '待恢复' })).session;
    const binding = bindingRepository.get('restore-1');
    const archived = service.archive('restore-1');
    assert.equal(runtimes.get('restore-1'), undefined);
    // 默认列表不含已归档会话；按需包含时带出归档时间。
    assert.deepEqual(service.list().sessions, []);
    assert.deepEqual(service.list({ includeArchived: true }).sessions, [archived]);
    // 空的临时目录归档时直接删除，恢复时按原路径补建（不作为“已移到废纸篓”提示）。
    assert.equal(existsSync(created.workingDirectory.path), false);

    const { session: restored, trashedDirectory } = service.restore('restore-1');
    assert.equal(trashedDirectory, null);
    assert.deepEqual(restored, { ...archived, archivedAt: null });
    assert.deepEqual(restored.workingDirectory, created.workingDirectory);
    assert.equal(statSync(created.workingDirectory.path).isDirectory(), true);
    assert.deepEqual(service.list().sessions, [restored]);
    assert.deepEqual(service.restore('restore-1'), { session: restored, trashedDirectory: null });
    assert.equal(service.resolve('restore-1').workspaceId, 'default');

    // 恢复本身不重建运行时；首次访问时按原绑定恢复 Pi session，不新建。
    assert.equal(runtimes.get('restore-1'), undefined);
    await runtimes.acquire(service.resolve('restore-1')).initialize();
    const continued = adapter.calls.filter((call) => call.method === 'continueSession').at(-1);
    assert.ok(continued && continued.method === 'continueSession');
    assert.equal(continued.input.binding.piSessionId, binding?.piSessionId);
    assert.deepEqual(continued.input.workingDirectory, created.workingDirectory);
    assert.equal(adapter.calls.filter((call) => call.method === 'createSession').length, 1);
    assert.deepEqual(bindingRepository.get('restore-1'), binding);

    assert.throws(() => service.restore('missing'), code('NOT_FOUND'));
    assert.throws(() => service.restore(GLOBAL_ASSISTANT_SESSION_ID), code('INVALID_REQUEST'));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('恢复时工作目录无法建立则保持归档', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-workspace-sessions-restore-fail-'));
  const { store, service } = harness(root);
  try {
    const created = (await service.create({ sessionId: 'restore-blocked', title: '目录被占用' })).session;
    service.archive('restore-blocked');
    // 空的临时目录已随归档删除；原路径被同名文件占用，目录建不出来。
    await writeFile(created.workingDirectory.path, '');
    assert.throws(
      () => service.restore('restore-blocked'),
      (error: unknown) => error instanceof WorkspaceSessionServiceError && error.code === 'ASSISTANT_SESSION_UNAVAILABLE',
    );
    assert.ok(new SqliteSessionRegistryRepository(store).get('restore-blocked')?.archivedAt);
    assert.deepEqual(service.list().sessions, []);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('栈式父子会话分别归档与恢复：恢复子会话不连带父会话，父子关系与来源保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-workspace-sessions-restore-stack-'));
  const { store, service, workPaths } = harness(root);
  try {
    await service.create({ sessionId: 'stack-parent', title: '父会话' });
    // 子会话的新建流程（核对选中内容）由应用级测试覆盖；这里直接写入父子记录。
    const registry = new SqliteSessionRegistryRepository(store);
    registry.insertIfAbsent({
      sessionId: 'stack-child', title: '子会话', kind: 'work', workspaceId: 'default',
      createdAt: '2026-09-25T09:00:00.000Z', parentSessionId: 'stack-parent',
      workingDirectory: { kind: 'session-temp', path: join(workPaths.sessionsDir, 'stack-child') },
      origin: {
        sourcePiEntryId: 'entry-1', sourceRole: 'assistant', text: '选中内容',
        parentTitle: '父会话', parentExcerpt: '用户：问题',
      },
    });

    service.archive('stack-parent');
    service.archive('stack-child');
    const restoredChild = service.restore('stack-child').session;
    assert.equal(restoredChild.parentSessionId, 'stack-parent');
    assert.equal(restoredChild.originText, '选中内容');
    // 父会话仍已归档，但仍可从包含已归档的列表中取得名称。
    assert.deepEqual(service.list().sessions.map((session) => session.sessionId), ['stack-child']);
    const parent = service.list({ includeArchived: true }).sessions.find((session) => session.sessionId === 'stack-parent');
    assert.equal(parent?.title, '父会话');
    assert.ok(parent?.archivedAt);
    assert.throws(() => service.resolve('stack-parent'), WorkspaceSessionServiceError);

    // 恢复父会话后父子都在工作区中。
    service.restore('stack-parent');
    assert.deepEqual(
      service.list().sessions.map((session) => [session.sessionId, session.parentSessionId]),
      [['stack-parent', null], ['stack-child', 'stack-parent']],
    );
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
  const app = createMultivacApplication(testApplicationEnvironment(root));
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
    // 接口返回会话的工作目录：位于工作文件根目录的 sessions/ 下，不在内部数据目录之下。
    const { workingDirectory } = created.body as WorkspaceSession;
    assert.equal(workingDirectory.kind, 'session-temp');
    assert.equal(dirname(workingDirectory.path), join(testWorkRoot(root), 'sessions'));
    assert.match(basename(workingDirectory.path), /^\d{4}-\d{2}-\d{2}-方案讨论-http1$/u);
    assert.equal(statSync(workingDirectory.path).isDirectory(), true);
    assert.equal(workingDirectory.path.startsWith(testDataDir(root)), false);
    const replay = await httpJson(running.port, '/api/sessions', 'POST', { sessionId: 'http-1', title: '方案讨论' });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body.workingDirectory, workingDirectory);
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
    const draftStore = new SqliteAssistantStore(join(testDataDir(root), 'multivac.sqlite'));
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
    // 改名不改变工作目录，重启后仍以记录为准。
    assert.deepEqual(listed.body.sessions[0].workingDirectory, workingDirectory);
    const reopened = new SqliteAssistantStore(join(testDataDir(root), 'multivac.sqlite'));
    assert.equal(new SqliteAssistantPageStateRepository(reopened).get('http-1').draft, '重启前的会话草稿');
    assert.equal(new SqliteAssistantPageStateRepository(reopened).get(GLOBAL_ASSISTANT_SESSION_ID).draft, '');
    reopened.close();
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('工作区现场按工作区保存，归档的会话移出现场，恢复后不回到原栏位，重启后原样恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-workspace-scene-'));
  let running = await startApplication(root);
  try {
    const initial = await httpJson(running.port, '/api/workspaces/default/scene');
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body, {
      workspaceId: 'default',
      scene: { parallelCount: 2, slots: [], focusedSessionId: null, viewMode: 'parallel', widths: {}, barVisible: true },
    });
    for (const [sessionId, title] of [['scene-a', '现场一'], ['scene-b', '现场二'], ['scene-c', '现场三']]) {
      await httpJson(running.port, '/api/sessions', 'POST', { sessionId, title });
    }
    const scene = {
      parallelCount: 3, slots: ['scene-c', 'scene-a', 'scene-a', 'missing'],
      focusedSessionId: 'scene-a', viewMode: 'focus', widths: { 3: [300, 500, 400], 2: [1, 2, 3] }, barVisible: false,
    };
    const saved = await httpJson(running.port, '/api/workspaces/default/scene', 'PUT', scene);
    assert.equal(saved.status, 200);
    // 栏位去重并剔除不存在的会话；栏数与并排数不一致的列宽记录被丢弃。
    assert.deepEqual(saved.body.scene.slots, ['scene-c', 'scene-a']);
    assert.deepEqual(saved.body.scene.widths, { 3: [300, 500, 400] });
    assert.equal((await httpJson(running.port, '/api/workspaces/default/scene', 'PUT', { ...scene, parallelCount: 5 })).status, 400);
    assert.equal((await httpJson(running.port, '/api/workspaces/default/scene', 'PUT', { ...scene, parallelCount: 1 })).status, 400);
    assert.equal((await httpJson(running.port, '/api/workspaces/other/scene')).status, 404);

    // 归档正在展示的当前会话后，现场自动移除它。
    await httpJson(running.port, '/api/sessions/scene-a/archive', 'POST');
    const afterArchive = await httpJson(running.port, '/api/workspaces/default/scene');
    assert.deepEqual(afterArchive.body.scene, {
      parallelCount: 3, slots: ['scene-c'], focusedSessionId: null, viewMode: 'focus',
      widths: { 3: [300, 500, 400] }, barVisible: false,
    });

    await running.close();
    running = await startApplication(root);
    const restarted = await httpJson(running.port, '/api/workspaces/default/scene');
    assert.deepEqual(restarted.body.scene, afterArchive.body.scene);

    // 归档时已移出保存的现场：恢复后不回到原来的栏位，也不再是当前会话，由界面按空栏补位。
    await httpJson(running.port, '/api/sessions/scene-a/restore', 'POST');
    const afterRestore = await httpJson(running.port, '/api/workspaces/default/scene');
    assert.deepEqual(afterRestore.body.scene, afterArchive.body.scene);
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('旧版两栏现场升级为栏位现场，沿用并排会话、当前会话、视图与列宽', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-workspace-scene-legacy-'));
  let running = await startApplication(root);
  try {
    for (const [sessionId, title] of [['legacy-a', '旧一'], ['legacy-b', '旧二'], ['legacy-c', '旧三']]) {
      await httpJson(running.port, '/api/sessions', 'POST', { sessionId, title });
    }
    await running.close();
    const database = new DatabaseSync(join(testDataDir(root), 'multivac.sqlite'));
    database.prepare('INSERT OR REPLACE INTO workspace_scene (workspace_id, scene_json, updated_at) VALUES (?, ?, ?)').run(
      'default',
      JSON.stringify({ order: ['legacy-c', 'legacy-a', 'legacy-b'], focusedSessionId: 'legacy-a', viewMode: 'parallel', split: 0.6, barVisible: false }),
      '2026-09-20T00:00:00.000Z',
    );
    database.close();

    running = await startApplication(root);
    const upgraded = await httpJson(running.port, '/api/workspaces/default/scene');
    assert.equal(upgraded.status, 200);
    assert.deepEqual(upgraded.body.scene, {
      parallelCount: 2, slots: ['legacy-c', 'legacy-a'], focusedSessionId: 'legacy-a', viewMode: 'parallel',
      widths: { 2: [0.6, 0.4] }, barVisible: false,
    });
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});
