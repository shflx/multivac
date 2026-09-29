import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import WebSocket from 'ws';
import {
  GLOBAL_ASSISTANT_SESSION_ID,
  INTERNAL_TOOL_DISPLAY,
  WINDOW_ID_HEADER,
  WORKBENCH_EVENTS_PATH,
  WorkbenchEventSchema,
  type CoordinatorRuntimeConfig,
  type WorkbenchEvent,
  type WorkspaceSceneState,
} from '@multivac/contracts';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { defineInternalTool, InternalToolService } from '../src/application/internal-tools/index.js';
import { ProjectService } from '../src/application/project-service.js';
import { SessionRuntimeRegistry, type SessionRuntime } from '../src/application/session-runtimes.js';
import { SessionWorkingDirectories } from '../src/application/session-working-directories.js';
import { ToolAuthorizationService } from '../src/application/tool-authorization-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import {
  WorkspaceSessionService,
  WorkspaceSessionServiceError,
} from '../src/application/workspace-session-service.js';
import { createWorkbenchSocket } from '../src/adapters/http/workbench-socket.js';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
  SqliteInternalToolCallRepository,
  SqliteProjectRepository,
  SqliteSessionRegistryRepository,
  SqliteSessionSelectionRepository,
  SqliteToolAuthorizationRepository,
  SqliteWorkspaceRepository,
  SqliteWorkspaceSceneRepository,
} from '../src/storage/sqlite-assistant-store.js';
import { resolveMultivacWorkPaths } from '../src/storage/work-paths.js';
import { testApplicationEnvironment, testDataDir, testWorkRoot } from './fixtures/test-environment.js';

/**
 * 工作台变更事件：会话、项目、工作区现场与记住的授权在服务层变更后发布（载荷与来源），重放与没有变化的调用不发布；
 * 现场版本与冲突；内部工具的改动带上发起的一轮与窗口；WebSocket 推送通道的登记、投递范围与本地校验。
 */

const config: CoordinatorRuntimeConfig = {
  systemPrompt: '你是 Multivac。',
  authorizedContext: [],
  model: { provider: 'fake', modelId: 'fake', thinkingLevel: 'off' },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
};

const WINDOW = { windowId: 'window-a', commandId: null };

/** 服务层夹具：真实 SQLite、工作目录与 Fake 适配器，会话与项目服务共用一条事件流。 */
async function withServices(run: (target: {
  root: string;
  store: SqliteAssistantStore;
  events: WorkbenchEvent[];
  workbench: WorkbenchEvents;
  sessions: WorkspaceSessionService;
  projects: ProjectService;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'multivac-workbench-'));
  const store = new SqliteAssistantStore(join(root, 'data.sqlite'));
  const adapter = new FakeCoordinatorAdapter({ sessionPathRoot: join(root, 'sessions'), seedsHistory: () => false });
  const repository = new SqliteSessionRegistryRepository(store);
  const dataDir = testDataDir(root);
  const workPaths = resolveMultivacWorkPaths(testWorkRoot(root), dataDir);
  const workingDirectories = new SessionWorkingDirectories(workPaths, repository, dataDir);
  const runtimes = new SessionRuntimeRegistry<SessionRuntime & { isRunning(): boolean }>((record) => {
    const session = new AssistantSessionService({
      adapter,
      bindingRepository: new SqliteAssistantBindingRepository(store),
      pageStateRepository: new SqliteAssistantPageStateRepository(store),
      selectionRepository: new SqliteSessionSelectionRepository(store),
      runtimeConfig: config,
      resolveWorkingDirectory: () => workingDirectories.resolveForRuntime(record.sessionId),
      kind: 'work',
      sessionDir: join(root, 'sessions', 'work'),
      assistantSessionId: record.sessionId,
    });
    return {
      sessionId: record.sessionId,
      initialize: () => session.initialize(),
      isRunning: () => false,
      dispose: () => {
        session.close();
        adapter.disposeSession(record.sessionId);
      },
    };
  });
  const workbench = new WorkbenchEvents();
  const events: WorkbenchEvent[] = [];
  workbench.subscribe((event) => events.push(event));
  const workspaces = new SqliteWorkspaceRepository(store);
  let clock = 0;
  const sessions = new WorkspaceSessionService({
    repository,
    runtimes,
    workingDirectories,
    workspaces,
    sceneRepository: new SqliteWorkspaceSceneRepository(store),
    events: workbench,
    now: () => new Date(Date.UTC(2026, 8, 30, 8, 0, clock++)).toISOString(),
  });
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const projectIds = ['proj-a', 'proj-b'];
  const projects = new ProjectService({
    projects: new SqliteProjectRepository(store),
    workspaces,
    workPaths,
    dataDir,
    homeDir: home,
    events: workbench,
    newId: () => projectIds.shift()!,
  });
  try {
    await run({ root, store, events, workbench, sessions, projects });
  } finally {
    runtimes.releaseAll();
    adapter.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function scene(patch: Partial<WorkspaceSceneState> = {}): WorkspaceSceneState {
  return { parallelCount: 2, slots: [], focusedSessionId: null, viewMode: 'parallel', widths: {}, barVisible: true, ...patch };
}

/** 事件的摘要：类型、变化种类与对象 id，便于按顺序核对。 */
function summary(event: WorkbenchEvent): string {
  switch (event.type) {
    case 'session.changed': return `session.${event.change}:${event.session.sessionId}`;
    case 'workspace.changed': return `workspace.${event.change}:${event.workspace.workspaceId}`;
    case 'scene.changed': return `scene:${event.scene.workspaceId}@${event.scene.revision}`;
    case 'grant.changed': return `grant.${event.change}:${event.grant.grantId}`;
    default: return event.type;
  }
}

test('会话在服务层发布变更：新建、改名、归档（连同现场移出）、恢复、归入项目；重放与没有变化的调用不发布', async () => {
  await withServices(async ({ events, sessions, projects }) => {
    const created = await sessions.create({ sessionId: 'wb-1', title: '整理需求' }, WINDOW);
    assert.equal(created.created, true);
    await sessions.create({ sessionId: 'wb-2', title: '核对接口' });
    // 同 id 的重放返回既有会话，不再发布。
    assert.equal((await sessions.create({ sessionId: 'wb-1', title: '整理需求' }, WINDOW)).created, false);
    assert.deepEqual(events.map(summary), ['session.created:wb-1', 'session.created:wb-2']);
    // 载荷是会话快照（与接口返回相同），来源原样；没有窗口身份时来源为空。
    const first = events[0]!;
    assert.equal(Check(WorkbenchEventSchema, first), true);
    assert.deepEqual(first.type === 'session.changed' && first.session, created.session);
    assert.deepEqual(first.type === 'session.changed' && first.origin, WINDOW);
    assert.deepEqual(events[1]!.type === 'session.changed' && events[1]!.origin, { windowId: null, commandId: null });

    // 改名：同名不发布。
    events.length = 0;
    const renamed = sessions.rename('wb-1', '整理需求（二）', WINDOW);
    sessions.rename('wb-1', '  整理需求（二）  ', WINDOW);
    assert.deepEqual(events.map(summary), ['session.renamed:wb-1']);
    assert.deepEqual(events[0]!.type === 'session.changed' && events[0]!.session, renamed);

    // 归档正在展示的会话：会话快照之后是移出它的现场（版本加一）；现场本来没有它时只发布会话。
    sessions.saveScene('default', scene({ slots: ['wb-1', 'wb-2'], focusedSessionId: 'wb-1' }));
    events.length = 0;
    sessions.archive('wb-1', WINDOW);
    assert.deepEqual(events.map(summary), ['session.archived:wb-1', 'scene:default@2']);
    const pruned = events[1]!;
    assert.deepEqual(pruned.type === 'scene.changed' && pruned.scene.scene.slots, ['wb-2']);
    assert.deepEqual(pruned.type === 'scene.changed' && pruned.origin, WINDOW);

    // 恢复：重复恢复（已未归档）原样返回，不再发布。
    events.length = 0;
    sessions.restore('wb-1', WINDOW);
    sessions.restore('wb-1', WINDOW);
    assert.deepEqual(events.map(summary), ['session.restored:wb-1']);

    // 归入项目：会话快照带新的工作区；已在目标项目中（重放）不发布。
    projects.createProject({ name: '研究' });
    events.length = 0;
    const moved = await sessions.moveToProject('wb-2', { projectId: 'proj-a', moveFiles: false }, WINDOW);
    await sessions.moveToProject('wb-2', { projectId: 'proj-a', moveFiles: false }, WINDOW);
    assert.deepEqual(events.map(summary), ['session.moved:wb-2', 'scene:default@3']);
    assert.equal(events[0]!.type === 'session.changed' && events[0]!.session.workspaceId, 'proj-a');
    assert.deepEqual(events[0]!.type === 'session.changed' && events[0]!.session, moved.session);

    // 序号在进程内单调递增。
    const seqs = events.map((event) => event.seq);
    assert.deepEqual(seqs, [...seqs].sort((left, right) => left - right));
  });
});

test('项目新建与更新发布同名工作区；工作区现场按版本保存：内容不变不写入，别处改过且内容不同时拒绝', async () => {
  await withServices(async ({ events, sessions, projects }) => {
    const { workspace } = projects.createProject({ name: '研究' }, WINDOW);
    projects.updateProject(workspace.workspaceId, { name: '研究（新）', defaultConstraints: '只读' }, WINDOW);
    assert.deepEqual(events.map(summary), ['workspace.created:proj-a', 'workspace.updated:proj-a']);
    const updated = events[1]!;
    assert.equal(updated.type === 'workspace.changed' && updated.workspace.name, '研究（新）');
    assert.equal(updated.type === 'workspace.changed' && updated.workspace.project?.defaultConstraints, '只读');

    await sessions.create({ sessionId: 's-a', title: 'A' });
    await sessions.create({ sessionId: 's-b', title: 'B' });
    events.length = 0;
    assert.equal(sessions.getScene('default').revision, 0);

    // 第一次保存：版本 0 → 1；同样的内容（字段顺序不同）再保存不写入、不发布，版本不变。
    const saved = sessions.saveScene('default', scene({ slots: ['s-a', 's-b'], widths: { 3: [1, 1, 2], 2: [1, 3] } }), {
      baseRevision: 0, origin: WINDOW,
    });
    assert.equal(saved.revision, 1);
    const reordered = { barVisible: true, widths: { 2: [1, 3], 3: [1, 1, 2] }, viewMode: 'parallel', focusedSessionId: null, slots: ['s-a', 's-b'], parallelCount: 2 } as const;
    assert.equal(sessions.saveScene('default', { ...reordered, slots: [...reordered.slots], widths: { 2: [1, 3], 3: [1, 1, 2] } }, { baseRevision: 0 }).revision, 1);
    assert.deepEqual(events.map(summary), ['scene:default@1']);
    assert.deepEqual(events[0]!.type === 'scene.changed' && events[0]!.scene, saved);

    // 基于旧版本、内容不同：拒绝，现场不变；基于当前版本：写入。
    assert.throws(
      () => sessions.saveScene('default', scene({ slots: ['s-b'] }), { baseRevision: 0 }),
      (error) => error instanceof WorkspaceSessionServiceError && error.code === 'WORKSPACE_SCENE_CONFLICT',
    );
    assert.deepEqual(sessions.getScene('default').scene.slots, ['s-a', 's-b']);
    assert.equal(sessions.saveScene('default', scene({ slots: ['s-b'] }), { baseRevision: 1 }).revision, 2);
    // 不给出基础版本时直接覆盖（没有窗口身份的调用、服务端自身的修改）。
    assert.equal(sessions.saveScene('default', scene({ viewMode: 'focus' })).revision, 3);
    assert.deepEqual(events.map(summary), ['scene:default@1', 'scene:default@2', 'scene:default@3']);
  });
});

test('记住的授权：授权卡上选择记住后发布新授权，撤销发布一次，重复撤销与单次批准不发布', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'multivac-workbench-grants-')));
  const store = new SqliteAssistantStore(join(root, 'multivac.sqlite'));
  const workbench = new WorkbenchEvents();
  const events: WorkbenchEvent[] = [];
  workbench.subscribe((event) => events.push(event));
  const registry = new SqliteSessionRegistryRepository(store);
  const bindings = new SqliteAssistantBindingRepository(store);
  registry.insertIfAbsent({
    sessionId: 'work-a', title: 'A', kind: 'work', workspaceId: 'default', createdAt: '2026-09-30T07:00:00.000Z',
    workingDirectory: { kind: 'session-temp', path: join(root, 'work', 'sessions', 'a') },
  });
  bindings.insertIfAbsent({
    assistantSessionId: 'work-a', piSessionId: 'pi-a', piSessionPath: '/pi/a.jsonl', updatedAt: '2026-09-30T07:00:00.000Z',
  });
  mkdirSync(join(root, 'outside', 'reports'), { recursive: true });
  const service = new ToolAuthorizationService({
    repository: new SqliteToolAuthorizationRepository(store),
    eventStream: new AssistantEventStream(),
    workbenchEvents: workbench,
    currentCommandId: () => null,
    projectOf: () => null,
    rememberBoundary: { homeDir: join(root, 'home'), workRoot: join(root, 'work'), dataDir: join(root, 'data') },
  });
  const requestAccess = (toolCallId: string) => {
    const decision = service.authorize({
      assistantSessionId: 'work-a', toolName: 'write', toolCallId,
      requestedPath: join(root, 'outside', 'reports', 'q3.md'), targetPath: join(root, 'outside', 'reports', 'q3.md'),
      workingDirectory: { kind: 'session-temp', path: join(root, 'work', 'sessions', 'a') },
    }, new AbortController().signal);
    const pending = service.list('work-a').find((item) => item.toolCallId === toolCallId)!;
    return { decision, requestId: pending.requestId };
  };
  try {
    const once = requestAccess('call-once');
    service.decide('work-a', once.requestId, 'once', WINDOW);
    assert.equal((await once.decision).allowed, true);
    assert.deepEqual(events, []);

    const remembered = requestAccess('call-session');
    service.decide('work-a', remembered.requestId, 'session', WINDOW);
    await remembered.decision;
    assert.equal(events.length, 1);
    const created = events[0]!;
    assert.equal(created.type === 'grant.changed' && created.change, 'created');
    assert.deepEqual(created.type === 'grant.changed' && created.origin, WINDOW);
    const grant = service.listGrants()[0]!;
    assert.deepEqual(created.type === 'grant.changed' && created.grant, grant);

    service.revokeGrant(grant.grantId, { windowId: 'window-b', commandId: null });
    service.revokeGrant(grant.grantId, { windowId: 'window-b', commandId: null });
    assert.deepEqual(events.map(summary), [`grant.created:${grant.grantId}`, `grant.revoked:${grant.grantId}`]);
    const revoked = events[1]!;
    assert.notEqual(revoked.type === 'grant.changed' && revoked.grant.revokedAt, null);
  } finally {
    service.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('内部工具的改动走同一套服务发布，来源是 Multivac 的这一轮与发出消息的窗口；账本重放不再发布', async () => {
  const table = INTERNAL_TOOL_DISPLAY as Record<string, { displayName: string }>;
  table.sample_rename = { displayName: '测试工具 sample_rename' };
  try {
    await withServices(async ({ store, events, sessions }) => {
      await sessions.create({ sessionId: 'tool-1', title: '旧名' });
      events.length = 0;
      const tools = new InternalToolService({
        tools: [defineInternalTool({
          name: 'sample_rename', effect: 'manage', description: '示例', parameters: Type.Object({ title: Type.String() }),
          execute: async (params, context) => {
            const session = sessions.rename('tool-1', params.title, context.origin);
            return { content: `已改名为「${session.title}」`, result: { summary: '已改名', refs: [] } };
          },
        })],
        services: {} as never,
        calls: new SqliteInternalToolCallRepository(store),
        currentTurn: () => ({ commandId: 'turn-1', windowId: 'window-origin' }),
      });
      const invoke = () => tools.invoke({
        assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, toolName: 'sample_rename', toolCallId: 'call-1', args: { title: '新名' },
      }, new AbortController().signal);
      assert.equal((await invoke()).ok, true);
      assert.equal((await invoke()).ok, true);
      assert.deepEqual(events.map(summary), ['session.renamed:tool-1']);
      assert.deepEqual(events[0]!.type === 'session.changed' && events[0]!.origin, { windowId: 'window-origin', commandId: 'turn-1' });
    });
  } finally {
    delete table.sample_rename;
  }
});

function httpJson(
  port: number,
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: '127.0.0.1', port, path, method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
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

/** 连接推送通道并收集事件；next 等待下一条满足条件的事件。 */
function connect(port: number, query = '?windowId=window-a', headers: Record<string, string> = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${WORKBENCH_EVENTS_PATH}${query}`, { headers });
  const received: WorkbenchEvent[] = [];
  const waiters: Array<{ predicate: (event: WorkbenchEvent) => boolean; resolve: (event: WorkbenchEvent) => void }> = [];
  socket.on('message', (data) => {
    const event = JSON.parse(String(data)) as WorkbenchEvent;
    assert.equal(Check(WorkbenchEventSchema, event), true);
    received.push(event);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(event)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  });
  return {
    socket,
    received,
    next(predicate: (event: WorkbenchEvent) => boolean): Promise<WorkbenchEvent> {
      const found = received.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
    closed: new Promise<number>((resolve) => socket.on('close', (code) => resolve(code))),
    rejected: new Promise<number>((resolve) => socket.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0))),
  };
}

test('推送通道：连接后先收到登记的窗口，界面请求的改动带上发起窗口；现场的 If-Match；非法窗口与非本地来源拒绝升级', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-workbench-http-'));
  const app = createMultivacApplication(testApplicationEnvironment(root));
  await app.ready;
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  try {
    const window = connect(port);
    const hello = await window.next((event) => event.type === 'workbench.connected');
    assert.deepEqual(hello.type === 'workbench.connected' && hello.windowId, 'window-a');

    // 写请求带窗口 id：事件注明发起窗口；另一个窗口据此知道这是别处的改动。
    await httpJson(port, '/api/sessions', 'POST', { sessionId: 'ws-1', title: '会话一' }, { [WINDOW_ID_HEADER]: 'window-b' });
    const renamed = await httpJson(port, '/api/sessions/ws-1', 'PATCH', { title: '改过的名字' }, { [WINDOW_ID_HEADER]: 'window-b' });
    assert.equal(renamed.status, 200);
    const event = await window.next((item) => item.type === 'session.changed' && item.change === 'renamed');
    assert.deepEqual(event.type === 'session.changed' && event.origin, { windowId: 'window-b', commandId: null });
    assert.equal(event.type === 'session.changed' && event.session.title, '改过的名字');
    // 不合法的窗口 id 按没有窗口身份处理。
    await httpJson(port, '/api/sessions/ws-1', 'PATCH', { title: '第三个名字' }, { [WINDOW_ID_HEADER]: 'bad id!' });
    const anonymous = await window.next((item) => item.type === 'session.changed' && item.session.title === '第三个名字');
    assert.deepEqual(anonymous.type === 'session.changed' && anonymous.origin, { windowId: null, commandId: null });

    // 现场：GET 带版本；If-Match 与当前版本不一致且内容不同时 412，格式不对 400，一致时写入并推送。
    const initial = await httpJson(port, '/api/workspaces/default/scene');
    assert.equal(initial.body.revision, 0);
    const layout = scene({ slots: ['ws-1'], viewMode: 'focus' });
    assert.equal((await httpJson(port, '/api/workspaces/default/scene', 'PUT', layout, { 'if-match': 'abc' })).status, 400);
    const stale = await httpJson(port, '/api/workspaces/default/scene', 'PUT', layout, { 'if-match': '"7"' });
    assert.equal(stale.status, 412);
    assert.equal(stale.body.error.code, 'WORKSPACE_SCENE_CONFLICT');
    const saved = await httpJson(port, '/api/workspaces/default/scene', 'PUT', layout, {
      'if-match': '"0"', [WINDOW_ID_HEADER]: 'window-a',
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.revision, 1);
    const sceneEvent = await window.next((item) => item.type === 'scene.changed');
    assert.deepEqual(sceneEvent.type === 'scene.changed' && sceneEvent.scene, saved.body);
    assert.deepEqual(sceneEvent.type === 'scene.changed' && sceneEvent.origin, { windowId: 'window-a', commandId: null });

    // 不合法的窗口 id、多余的参数、非本地的 Host 与 Origin 都在升级时拒绝。
    assert.equal(await connect(port, '?windowId=bad%20id').rejected, 400);
    assert.equal(await connect(port, '?windowId=a&other=1').rejected, 400);
    assert.equal(await connect(port, '', { origin: 'https://evil.example' }).rejected, 403);
    assert.equal(await connect(port, '', { host: 'evil.example' }).rejected, 403);
    // 不带窗口 id 也可以连接（只收不发，登记为 null）。
    const anonymousWindow = connect(port, '');
    const anonymousHello = await anonymousWindow.next((item) => item.type === 'workbench.connected');
    assert.equal(anonymousHello.type === 'workbench.connected' && anonymousHello.windowId, null);

    // 服务停止时断开全部连接，HTTP 服务的 close 不会被长连接卡住。
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    await window.closed;
    await anonymousWindow.closed;
  } finally {
    app.server.close();
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('推送通道：指定目标窗口的事件只投给以该窗口登记的连接，断开的连接不再订阅、不再算作打开着', async () => {
  const events = new WorkbenchEvents();
  const socket = createWorkbenchSocket({ events });
  const server: Server = createServer((_request, response) => response.end());
  server.on('upgrade', (request, duplex, head) => socket.upgrade(request, duplex, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    const a = connect(port, '?windowId=window-a');
    const b = connect(port, '?windowId=window-b');
    await a.next((event) => event.type === 'workbench.connected');
    await b.next((event) => event.type === 'workbench.connected');
    assert.equal(socket.connectionCount(), 2);

    const change = { type: 'scene.changed' as const, origin: { windowId: null, commandId: 'turn-1' }, scene: {
      workspaceId: 'default', scene: scene({ viewMode: 'focus' }), revision: 4,
    } };
    events.publish(change, { targetWindowId: 'window-a' });
    events.publish({ ...change, scene: { ...change.scene, revision: 5 } });
    await a.next((event) => event.type === 'scene.changed' && event.scene.revision === 5);
    await b.next((event) => event.type === 'scene.changed' && event.scene.revision === 5);
    assert.deepEqual(a.received.filter((event) => event.type === 'scene.changed').map((event) => event.type === 'scene.changed' && event.scene.revision), [4, 5]);
    assert.deepEqual(b.received.filter((event) => event.type === 'scene.changed').map((event) => event.type === 'scene.changed' && event.scene.revision), [5]);

    // 只推给某个窗口的导航：只有登记了这个窗口的连接收到；窗口在不在由登记的连接判断。
    assert.equal(events.hasWindow('window-a'), true);
    assert.equal(events.hasWindow('window-b'), true);
    const navigate = {
      type: 'window.navigate' as const, origin: { windowId: 'window-b', commandId: 'turn-2' },
      target: { kind: 'management' as const, page: 'models' as const, selection: null },
    };
    assert.equal(events.publishToWindow('window-b', navigate), true);
    await b.next((event) => event.type === 'window.navigate');
    assert.equal(a.received.some((event) => event.type === 'window.navigate'), false);

    // 窗口断开后不再占用订阅，也不再算作打开着：定向推送推不到，不会改为广播。
    b.socket.close();
    await b.closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(socket.connectionCount(), 1);
    assert.equal(events.listenerCount(), 1);
    assert.equal(events.hasWindow('window-b'), false);
    assert.equal(events.publishToWindow('window-b', navigate), false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(a.received.some((event) => event.type === 'window.navigate'), false);
  } finally {
    socket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
