import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  GLOBAL_ASSISTANT_SESSION_ID,
  type CreateProjectResponse,
  type Workspace,
  type WorkspaceSession,
} from '@multivac/contracts';
import { ProjectService, ProjectServiceError } from '../src/application/project-service.js';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { projectDirectoryName } from '../src/modules/sessions/working-directory.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import {
  SqliteAssistantStore,
  SqliteProjectRepository,
  SqliteSessionRegistryRepository,
  SqliteWorkspaceRepository,
  SqliteWorkspaceSceneRepository,
} from '../src/storage/sqlite-assistant-store.js';
import { resolveMultivacWorkPaths } from '../src/storage/work-paths.js';
import { testApplicationEnvironment, testDataDir, testWorkRoot } from './fixtures/test-environment.js';

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

async function startApplication(root: string, adapter = new FakeCoordinatorAdapter({
  seedsHistory: (sessionId) => sessionId === GLOBAL_ASSISTANT_SESSION_ID,
})) {
  const app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: adapter });
  await app.ready;
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  return {
    port: address.port,
    adapter,
    async close() {
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
      app.close();
    },
  };
}

function projectService(root: string, store: SqliteAssistantStore, ids = ['p-1', 'p-2', 'p-3', 'p-4', 'p-5']) {
  const dataDir = testDataDir(root);
  let clock = 0;
  return new ProjectService({
    projects: new SqliteProjectRepository(store),
    workspaces: new SqliteWorkspaceRepository(store),
    workPaths: resolveMultivacWorkPaths(testWorkRoot(root), dataDir),
    dataDir,
    now: () => new Date(Date.UTC(2026, 8, 28, 8, 0, clock++)).toISOString(),
    newId: () => ids.shift()!,
  });
}

test('项目功能之前的数据库升级后，默认工作区的会话与现场原样保留，默认工作区排在项目工作区之后', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-projects-migration-'));
  const databasePath = join(testDataDir(root), 'multivac.sqlite');
  try {
    const before = new SqliteAssistantStore(databasePath);
    const registry = new SqliteSessionRegistryRepository(before);
    registry.insertIfAbsent({
      sessionId: 'old-1', title: '升级前的会话', kind: 'work', workspaceId: 'default',
      createdAt: '2026-09-20T00:00:00.000Z',
      workingDirectory: { kind: 'session-temp', path: '/work/sessions/2026-09-20-升级前的会话-old1' },
    });
    registry.archive(registry.insertIfAbsent({
      sessionId: 'old-2', title: '已归档的会话', kind: 'work', workspaceId: 'default',
      createdAt: '2026-09-21T00:00:00.000Z',
      workingDirectory: { kind: 'session-temp', path: '/work/sessions/2026-09-21-已归档的会话-old2' },
    }).record.sessionId, '2026-09-22T00:00:00.000Z');
    const scene = {
      parallelCount: 3, slots: ['old-1'], focusedSessionId: 'old-1', viewMode: 'focus' as const,
      widths: { 3: [1, 2, 1] }, barVisible: false,
    };
    new SqliteWorkspaceSceneRepository(before).save('default', scene);
    before.close();

    // 退回项目功能之前的版本：删除项目与工作区表及对应的迁移记录。
    const raw = new DatabaseSync(databasePath);
    raw.exec(`
      DROP TABLE workspace;
      DROP TABLE project_directory;
      DROP TABLE project;
      DELETE FROM schema_migrations WHERE version >= 14;
    `);
    raw.close();

    const upgraded = new SqliteAssistantStore(databasePath);
    const workspaces = new SqliteWorkspaceRepository(upgraded);
    assert.deepEqual(workspaces.list(), [{ workspaceId: 'default', name: '默认工作区', project: null }]);
    const sessions = new SqliteSessionRegistryRepository(upgraded).list('default', 'work', { includeArchived: true });
    assert.deepEqual(sessions.map((session) => [session.sessionId, session.workspaceId, session.archivedAt]), [
      ['old-1', 'default', null],
      ['old-2', 'default', '2026-09-22T00:00:00.000Z'],
    ]);
    assert.deepEqual(new SqliteWorkspaceSceneRepository(upgraded).get('default'), scene);

    // 项目工作区排在默认工作区之前，名称取项目名称。
    const { workspace } = projectService(root, upgraded).createProject({ name: '研究' });
    assert.deepEqual(workspaces.list().map((item) => [item.workspaceId, item.name]), [
      [workspace.workspaceId, '研究'],
      ['default', '默认工作区'],
    ]);
    upgraded.close();

    // 迁移可以重复执行：重放后默认工作区只有一条，项目保留。
    const replay = new DatabaseSync(databasePath);
    replay.exec('DELETE FROM schema_migrations WHERE version >= 14;');
    replay.close();
    const reopened = new SqliteAssistantStore(databasePath);
    assert.deepEqual(new SqliteWorkspaceRepository(reopened).list().map((item) => item.workspaceId), [
      workspace.workspaceId, 'default',
    ]);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('新建项目：托管目录按名称做文件名安全处理并在重名时加后缀，挂载目录必须是数据目录之外已存在的目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-projects-directories-'));
  const store = new SqliteAssistantStore(join(testDataDir(root), 'multivac.sqlite'));
  try {
    const service = projectService(root, store);
    const projectsDir = join(testWorkRoot(root), 'projects');

    // 托管目录：名称清理后作为目录名，创建项目时建好目录；项目带一个同 id、同名的工作区。
    const first = service.createProject({ name: '  研究 / 笔记  ', defaultConstraints: '  只读资料  ' });
    assert.deepEqual(first.project, {
      projectId: 'p-1',
      name: '研究 / 笔记',
      directories: [{ kind: 'managed', path: join(projectsDir, '研究-笔记') }],
      defaultConstraints: '只读资料',
      createdAt: '2026-09-28T08:00:00.000Z',
      updatedAt: '2026-09-28T08:00:00.000Z',
    });
    assert.deepEqual(first.workspace, { workspaceId: 'p-1', name: '研究 / 笔记', project: first.project });
    assert.equal(statSync(join(projectsDir, '研究-笔记')).isDirectory(), true);

    // 重名：已被其他项目使用（即使目录被删了）或磁盘上已存在同名目录时追加序号。
    rmSync(join(projectsDir, '研究-笔记'), { recursive: true });
    assert.equal(service.createProject({ name: '研究：笔记' }).project.directories[0]!.path, join(projectsDir, '研究-笔记-2'));
    mkdirSync(join(projectsDir, 'notes'));
    assert.equal(service.createProject({ name: 'notes' }).project.directories[0]!.path, join(projectsDir, 'notes-2'));
    assert.equal(projectDirectoryName('🚀 $(rm -rf ~)'), 'rm-rf');
    assert.equal(projectDirectoryName('///'), '项目');

    // 挂载目录：绝对路径、已存在、是目录、不在内部数据目录之下（含经符号链接）。
    const invalid = (directory: string, pattern: RegExp) => assert.throws(
      () => service.createProject({ name: '挂载', directory }),
      (error: unknown) => error instanceof ProjectServiceError && error.code === 'INVALID_REQUEST' && pattern.test(error.message),
    );
    invalid('relative/code', /绝对路径/u);
    invalid(join(root, 'missing'), /目录不存在/u);
    writeFileSync(join(root, 'file.txt'), 'x');
    invalid(join(root, 'file.txt'), /不是目录/u);
    invalid(testDataDir(root), /内部数据目录/u);
    mkdirSync(join(testDataDir(root), 'inside'));
    invalid(join(testDataDir(root), 'inside'), /内部数据目录/u);
    symlinkSync(join(testDataDir(root), 'inside'), join(root, 'link-to-data'));
    invalid(join(root, 'link-to-data'), /内部数据目录/u);
    assert.throws(() => service.createProject({ name: '   ' }), /项目名称不能为空/u);

    mkdirSync(join(root, 'code', 'app'), { recursive: true });
    const mounted = service.createProject({ name: '应用', directory: `${join(root, 'code')}/./app/` });
    assert.deepEqual(mounted.project.directories, [{ kind: 'mounted', path: join(root, 'code', 'app') }]);

    assert.deepEqual(service.listProjects().projects.map((project) => project.name), ['研究 / 笔记', '研究：笔记', 'notes', '应用']);
    assert.deepEqual(service.getProject('p-4'), mounted.project);
    assert.throws(() => service.getProject('missing'), (error: unknown) => error instanceof ProjectServiceError && error.code === 'NOT_FOUND');
    assert.deepEqual(service.listWorkspaces().workspaces.map((workspace) => workspace.name), [
      '研究 / 笔记', '研究：笔记', 'notes', '应用', '默认工作区',
    ]);

    // E2E 重置清除项目与项目工作区，默认工作区保留，目录本身不删除。
    service.resetForTest();
    assert.deepEqual(service.listWorkspaces().workspaces.map((workspace) => workspace.workspaceId), ['default']);
    assert.equal(existsSync(join(projectsDir, 'notes-2')), true);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('会话按工作区区分：项目中新建的会话以项目主目录为工作目录，栈式子会话留在父会话的工作区，现场各自保存', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-projects-sessions-'));
  let running = await startApplication(root);
  try {
    const mountedDir = join(root, 'mounted-code');
    mkdirSync(mountedDir);
    const managed = await httpJson(running.port, '/api/projects', 'POST', { name: '技术研究' });
    assert.equal(managed.status, 201);
    const research = (managed.body as CreateProjectResponse).project;
    const mounted = (await httpJson(running.port, '/api/projects', 'POST', { name: 'Multivac 开发', directory: mountedDir })).body as CreateProjectResponse;
    assert.equal((await httpJson(running.port, '/api/projects', 'POST', { name: '坏目录', directory: join(root, 'missing') })).status, 400);
    assert.equal((await httpJson(running.port, '/api/projects', 'POST', { name: '' })).status, 400);
    assert.equal((await httpJson(running.port, '/api/projects', 'POST', { name: '多余字段', dirs: [] })).status, 400);

    // 工作区列表带出项目与目录；项目工作区在前，默认工作区在最后。
    const workspaces = (await httpJson(running.port, '/api/workspaces')).body.workspaces as Workspace[];
    assert.deepEqual(workspaces.map((workspace) => [workspace.workspaceId, workspace.name, workspace.project?.directories]), [
      [research.projectId, '技术研究', [{ kind: 'managed', path: join(testWorkRoot(root), 'projects', '技术研究') }]],
      [mounted.project.projectId, 'Multivac 开发', [{ kind: 'mounted', path: mountedDir }]],
      ['default', '默认工作区', undefined],
    ]);
    assert.deepEqual((await httpJson(running.port, '/api/projects')).body.projects, [research, mounted.project]);
    assert.deepEqual((await httpJson(running.port, `/api/projects/${research.projectId}`)).body, research);
    assert.equal((await httpJson(running.port, '/api/projects/missing')).status, 404);

    // 项目中的会话共用项目主目录；默认工作区的会话各有临时目录。
    const create = async (sessionId: string, workspaceId?: string) => {
      const response = await httpJson(running.port, '/api/sessions', 'POST', {
        sessionId, title: sessionId, ...(workspaceId ? { workspaceId } : {}),
      });
      assert.equal(response.status, 201, sessionId);
      return response.body as WorkspaceSession;
    };
    const researchA = await create('research-a', research.projectId);
    const researchB = await create('research-b', research.projectId);
    const code = await create('code-a', mounted.project.projectId);
    const plain = await create('plain-a');
    assert.deepEqual(researchA.workingDirectory, { kind: 'project-managed', path: research.directories[0]!.path });
    assert.deepEqual(researchB.workingDirectory, researchA.workingDirectory);
    assert.deepEqual(code.workingDirectory, { kind: 'project-mounted', path: mountedDir });
    assert.equal(plain.workingDirectory.kind, 'session-temp');
    assert.equal(researchA.workspaceId, research.projectId);
    // 运行时以记录中的项目目录为 cwd 建立 Pi 会话。
    const created = running.adapter.calls.flatMap((call) => call.method === 'createSession'
      ? [[call.input.assistantSessionId, call.input.workingDirectory]] : []);
    assert.deepEqual(created, [
      ['research-a', researchA.workingDirectory],
      ['research-b', researchA.workingDirectory],
      ['code-a', code.workingDirectory],
      ['plain-a', plain.workingDirectory],
    ]);
    assert.equal((await httpJson(running.port, '/api/sessions', 'POST', { sessionId: 'x', title: 'x', workspaceId: 'missing' })).status, 404);
    // 同 id 换工作区重放判为冲突。
    assert.equal((await httpJson(running.port, '/api/sessions', 'POST', { sessionId: 'research-a', title: 'research-a' })).status, 409);
    assert.equal((await httpJson(running.port, '/api/sessions', 'POST', {
      sessionId: 'research-a', title: 'research-a', workspaceId: research.projectId,
    })).status, 200);

    // 列表按工作区区分；workspace=all 跨全部工作区。
    const ids = (body: { sessions: WorkspaceSession[] }) => body.sessions.map((session) => session.sessionId);
    assert.deepEqual(ids((await httpJson(running.port, '/api/sessions')).body), ['plain-a']);
    assert.deepEqual(ids((await httpJson(running.port, `/api/sessions?workspace=${research.projectId}`)).body), ['research-a', 'research-b']);
    const all = await httpJson(running.port, '/api/sessions?workspace=all&archived=include');
    assert.equal(all.body.workspaceId, null);
    assert.deepEqual(ids(all.body), ['research-a', 'research-b', 'code-a', 'plain-a']);
    assert.equal((await httpJson(running.port, '/api/sessions?workspace=missing')).status, 404);
    assert.equal((await httpJson(running.port, '/api/sessions?workspace=')).status, 400);

    // 栈式深入：子会话留在父会话的工作区，同样使用项目目录；指定另一个工作区时拒绝。
    await httpJson(running.port, '/api/sessions/research-a/turns', 'POST', {
      commandId: 'seed', assistantSessionId: 'research-a', text: '先列出资料', contextRefs: [],
    });
    const parentPage = await httpJson(running.port, '/api/sessions/research-a/session');
    const reply = parentPage.body.messages.find((message: { role: string }) => message.role === 'assistant');
    const quote = {
      sourcePiSessionId: parentPage.body.piSessionId, sourcePiEntryId: reply.piEntryId,
      sourceRole: 'assistant', text: '已处理当前消息', sourceSessionId: 'research-a',
    };
    const child = await httpJson(running.port, '/api/sessions', 'POST', {
      sessionId: 'research-child', title: '深入', parent: { sessionId: 'research-a', quote },
    });
    assert.equal(child.status, 201);
    assert.equal(child.body.workspaceId, research.projectId);
    assert.deepEqual(child.body.workingDirectory, researchA.workingDirectory);
    assert.equal((await httpJson(running.port, '/api/sessions', 'POST', {
      sessionId: 'research-child-2', title: '深入', workspaceId: 'default', parent: { sessionId: 'research-a', quote },
    })).status, 400);

    // 全局 Multivac 可以把任一工作区的会话作为当前焦点上下文。
    const context = await httpJson(running.port, '/api/assistant/turns', 'POST', {
      commandId: 'context-project', assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, text: '这个会话下一步做什么？',
      contextRefs: [{ kind: 'workspace-session', sessionId: 'research-a' }],
    });
    assert.equal(context.status, 200);

    // 现场按工作区保存：互不影响，别的工作区的会话不会进入栏位。
    const scene = (slots: string[], focused: string | null) => ({
      parallelCount: 2, slots, focusedSessionId: focused, viewMode: 'parallel', widths: {}, barVisible: true,
    });
    const researchScene = await httpJson(running.port, `/api/workspaces/${research.projectId}/scene`, 'PUT', scene(['research-b', 'research-a'], 'research-a'));
    assert.deepEqual(researchScene.body.scene.slots, ['research-b', 'research-a']);
    const defaultScene = await httpJson(running.port, '/api/workspaces/default/scene', 'PUT', scene(['research-a', 'plain-a'], 'research-a'));
    assert.deepEqual(defaultScene.body.scene.slots, ['plain-a']);
    assert.equal(defaultScene.body.scene.focusedSessionId, null);

    // 归档与恢复都不改变工作区；归档时移出所在工作区的现场。
    await httpJson(running.port, '/api/sessions/research-b/archive', 'POST');
    assert.deepEqual((await httpJson(running.port, `/api/workspaces/${research.projectId}/scene`)).body.scene.slots, ['research-a']);
    const restored = await httpJson(running.port, '/api/sessions/research-b/restore', 'POST');
    assert.equal(restored.body.workspaceId, research.projectId);
    assert.deepEqual(restored.body.workingDirectory, researchA.workingDirectory);

    // 挂载目录被移走后，项目中新建会话失败，不留下半成品；Multivac 不替用户创建挂载目录。
    rmSync(mountedDir, { recursive: true });
    const failed = await httpJson(running.port, '/api/sessions', 'POST', {
      sessionId: 'code-b', title: 'code-b', workspaceId: mounted.project.projectId,
    });
    assert.equal(failed.status, 503);
    assert.equal(existsSync(mountedDir), false);
    assert.equal((await httpJson(running.port, `/api/sessions?workspace=${mounted.project.projectId}`)).body.sessions.length, 1);

    // 重启后项目、工作区、会话的工作目录与各自的现场保留；被删的托管目录在启动时补回。
    rmSync(research.directories[0]!.path, { recursive: true });
    await running.close();
    running = await startApplication(root);
    assert.deepEqual((await httpJson(running.port, '/api/workspaces')).body.workspaces, workspaces);
    assert.equal(statSync(research.directories[0]!.path).isDirectory(), true);
    const afterRestart = await httpJson(running.port, `/api/sessions?workspace=${research.projectId}`);
    assert.deepEqual(afterRestart.body.sessions.map((session: WorkspaceSession) => [session.sessionId, session.workingDirectory]), [
      ['research-a', researchA.workingDirectory],
      ['research-b', researchA.workingDirectory],
      ['research-child', researchA.workingDirectory],
    ]);
    assert.deepEqual((await httpJson(running.port, `/api/workspaces/${research.projectId}/scene`)).body.scene.slots, ['research-a']);
    assert.deepEqual((await httpJson(running.port, '/api/workspaces/default/scene')).body.scene.slots, ['plain-a']);
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});
