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

function projectService(
  root: string,
  store: SqliteAssistantStore,
  ids = ['p-1', 'p-2', 'p-3', 'p-4', 'p-5'],
  workRoot = testWorkRoot(root),
) {
  const dataDir = testDataDir(root);
  let clock = 0;
  return new ProjectService({
    projects: new SqliteProjectRepository(store),
    workspaces: new SqliteWorkspaceRepository(store),
    workPaths: resolveMultivacWorkPaths(workRoot, dataDir),
    dataDir,
    // 用户主目录指向测试临时目录，测试不触碰真实的主目录。
    homeDir: testHomeDir(root),
    now: () => new Date(Date.UTC(2026, 8, 28, 8, 0, clock++)).toISOString(),
    newId: () => ids.shift()!,
  });
}

function testHomeDir(root: string): string {
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return home;
}

/** 断言操作以 INVALID_REQUEST 拒绝，且原因符合 pattern。 */
function rejects(operation: () => unknown, pattern: RegExp): void {
  assert.throws(
    operation,
    (error: unknown) => error instanceof ProjectServiceError && error.code === 'INVALID_REQUEST' && pattern.test(error.message),
  );
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

test('挂载目录的校验：拒绝根目录、用户主目录与工作文件根目录本身、内部数据目录及包含它的目录、已属于项目的目录，原因写明', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-projects-validation-'));
  const store = new SqliteAssistantStore(join(testDataDir(root), 'multivac.sqlite'));
  try {
    const service = projectService(root, store);
    const home = testHomeDir(root);
    const mount = (directory: string, name = '挂载') => service.createProject({ name, directory });

    rejects(() => mount('   '), /目录不能为空/u);
    rejects(() => mount('code'), /绝对路径/u);
    rejects(() => mount('~code'), /绝对路径/u);
    rejects(() => mount('/'), /不能挂载根目录/u);
    rejects(() => mount('/./'), /不能挂载根目录/u);
    // 用户主目录本身（含 `~` 写法与经符号链接）不行，其中的目录可以；`~/` 按主目录展开。
    rejects(() => mount(home), /用户主目录本身/u);
    rejects(() => mount('~'), /用户主目录本身/u);
    rejects(() => mount('~/'), /用户主目录本身/u);
    symlinkSync(home, join(root, 'link-to-home'));
    rejects(() => mount(join(root, 'link-to-home')), /用户主目录本身/u);
    mkdirSync(join(home, 'code'));
    assert.deepEqual(mount('~/code', '主目录下的项目').project.directories, [{ kind: 'mounted', path: join(home, 'code') }]);
    // 工作文件根目录本身不行（其中的目录不在此列）。
    rejects(() => mount(testWorkRoot(root)), /工作文件根目录本身/u);
    // 内部数据目录、其中的目录，以及包含它的上级目录。
    rejects(() => mount(testDataDir(root)), /内部数据目录或其中的目录/u);
    mkdirSync(join(testDataDir(root), 'sessions'), { recursive: true });
    rejects(() => mount(join(testDataDir(root), 'sessions')), /内部数据目录或其中的目录/u);
    rejects(() => mount(root), /包含 Multivac 的内部数据目录/u);
    // 已属于项目的目录：同一路径的另一种写法、指向它的符号链接也算。
    rejects(() => mount(`${join(home, 'code')}/`), /已属于项目「主目录下的项目」/u);
    symlinkSync(join(home, 'code'), join(root, 'link-to-code'));
    rejects(() => mount(join(root, 'link-to-code')), /已属于项目「主目录下的项目」/u);
    assert.equal(service.listProjects().projects.length, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }

  // 包含工作文件根目录的目录（工作文件根目录不在数据目录旁边时单独可见）。
  const other = await mkdtemp(join(tmpdir(), 'multivac-projects-work-parent-'));
  const otherStore = new SqliteAssistantStore(join(testDataDir(other), 'multivac.sqlite'));
  try {
    const service = projectService(other, otherStore, ['q-1'], join(other, 'outer', 'work'));
    rejects(() => service.createProject({ name: '上级', directory: join(other, 'outer') }), /包含工作文件根目录/u);
  } finally {
    otherStore.close();
    await rm(other, { recursive: true, force: true });
  }
});

test('项目名称不区分大小写地唯一且不能叫“默认工作区”；新建前的核对给出将使用的目录但不创建', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-projects-preview-'));
  const store = new SqliteAssistantStore(join(testDataDir(root), 'multivac.sqlite'));
  try {
    const service = projectService(root, store);
    const projectsDir = join(testWorkRoot(root), 'projects');

    // 核对托管项目：给出含重名后缀的路径，不创建目录、不写记录。
    mkdirSync(join(projectsDir, 'Notes'), { recursive: true });
    assert.deepEqual(service.previewProject({ name: ' Notes ' }), {
      name: 'Notes', directory: { kind: 'managed', path: join(projectsDir, 'Notes-2') },
    });
    assert.equal(existsSync(join(projectsDir, 'Notes-2')), false);
    assert.equal(service.listProjects().projects.length, 0);
    // 核对挂载目录：规范化路径，按同一套规则拒绝。
    mkdirSync(join(root, 'code'));
    assert.deepEqual(service.previewProject({ name: '代码', directory: ` ${join(root, 'code')}/ ` }), {
      name: '代码', directory: { kind: 'mounted', path: join(root, 'code') },
    });
    rejects(() => service.previewProject({ name: '代码', directory: '/' }), /不能挂载根目录/u);

    // 新建按核对的结果执行。
    assert.equal(service.createProject({ name: 'Notes' }).project.directories[0]!.path, join(projectsDir, 'Notes-2'));
    rejects(() => service.previewProject({ name: 'notes' }), /已有同名项目「Notes」/u);
    rejects(() => service.createProject({ name: ' NOTES ', directory: join(root, 'code') }), /已有同名项目「Notes」/u);
    rejects(() => service.createProject({ name: '默认工作区' }), /保留名称/u);
    rejects(() => service.createProject({ name: '  ' }), /项目名称不能为空/u);
    assert.equal(service.listProjects().projects.length, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('更新项目：改名（工作区随之改名）、挂载与卸载目录、切换主目录、默认约束，全部经过校验', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-projects-update-'));
  const store = new SqliteAssistantStore(join(testDataDir(root), 'multivac.sqlite'));
  try {
    const service = projectService(root, store);
    const managed = service.createProject({ name: '研究' }).project;
    const other = service.createProject({ name: '其他' }).project;
    const managedDir = managed.directories[0]!;
    const docs = join(root, 'docs');
    const code = join(root, 'code');
    mkdirSync(docs);
    mkdirSync(code);

    // 改名：工作区名称随项目；只改给出的字段。
    const renamed = service.updateProject(managed.projectId, { name: '  技术研究 ' });
    assert.equal(renamed.project.name, '技术研究');
    assert.deepEqual(renamed.workspace, { workspaceId: managed.projectId, name: '技术研究', project: renamed.project });
    assert.deepEqual(renamed.project.directories, managed.directories);
    assert.equal(renamed.project.createdAt, managed.createdAt);
    assert.notEqual(renamed.project.updatedAt, managed.updatedAt);
    assert.equal(service.listWorkspaces().workspaces.find((item) => item.workspaceId === managed.projectId)?.name, '技术研究');
    rejects(() => service.updateProject(managed.projectId, { name: '其他' }), /已有同名项目「其他」/u);
    rejects(() => service.updateProject(managed.projectId, { name: '默认工作区' }), /保留名称/u);
    // 大小写不同的自身名称不算重名。
    assert.equal(service.updateProject(managed.projectId, { name: '技术研究' }).project.name, '技术研究');

    // 挂载：新路径按挂载目录校验，已有目录保持原类型；顺序即主目录顺序。
    const mounted = service.updateProject(managed.projectId, { directories: [managedDir.path, `${docs}/`, code] }).project;
    assert.deepEqual(mounted.directories, [managedDir, { kind: 'mounted', path: docs }, { kind: 'mounted', path: code }]);
    rejects(() => service.updateProject(managed.projectId, { directories: [managedDir.path, join(root, 'missing')] }), /目录不存在/u);
    rejects(() => service.updateProject(managed.projectId, { directories: [managedDir.path, testDataDir(root)] }), /内部数据目录/u);
    rejects(() => service.updateProject(managed.projectId, { directories: [managedDir.path, other.directories[0]!.path] }), /已属于项目「其他」/u);
    rejects(() => service.updateProject(managed.projectId, { directories: [docs, `${docs}/.`] }), /不能出现两次/u);
    symlinkSync(docs, join(root, 'link-to-docs'));
    rejects(() => service.updateProject(managed.projectId, { directories: [docs, join(root, 'link-to-docs')] }), /已经在项目中/u);
    rejects(() => service.updateProject(managed.projectId, { directories: [] }), /至少保留一个目录/u);
    // 校验失败时什么都不改。
    assert.deepEqual(service.getProject(managed.projectId).directories, mounted.directories);

    // 切换主目录与卸载：卸载只解除记录，目录本身（包括托管目录）不删除；已有目录被移走后仍可调整。
    const switched = service.updateProject(managed.projectId, { directories: [code, docs, managedDir.path] }).project;
    assert.deepEqual(switched.directories.map((directory) => directory.path), [code, docs, managedDir.path]);
    rmSync(docs, { recursive: true });
    const unmounted = service.updateProject(managed.projectId, { directories: [code] }).project;
    assert.deepEqual(unmounted.directories, [{ kind: 'mounted', path: code }]);
    assert.equal(statSync(managedDir.path).isDirectory(), true);

    // 默认约束：去掉首尾空白保存，可以清空。
    assert.equal(service.updateProject(managed.projectId, { defaultConstraints: '  只改 docs/ 下的文件  ' }).project.defaultConstraints, '只改 docs/ 下的文件');
    assert.equal(service.updateProject(managed.projectId, { defaultConstraints: '' }).project.defaultConstraints, '');

    assert.throws(() => service.updateProject('missing', { name: 'x' }), (error: unknown) => error instanceof ProjectServiceError && error.code === 'NOT_FOUND');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('修改项目目录后新会话使用新的主目录，已有会话的工作目录不变；接口校验更新与新建前核对', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-projects-update-http-'));
  let running = await startApplication(root);
  try {
    const created = (await httpJson(running.port, '/api/projects', 'POST', { name: '文档' })).body as CreateProjectResponse;
    const projectId = created.project.projectId;
    const managedDir = created.project.directories[0]!.path;
    const before = (await httpJson(running.port, '/api/sessions', 'POST', { sessionId: 'before', title: '之前', workspaceId: projectId })).body as WorkspaceSession;
    assert.deepEqual(before.workingDirectory, { kind: 'project-managed', path: managedDir });

    // 新建前的核对：不创建任何东西；非法目录返回 400 与中文原因。
    const preview = await httpJson(running.port, '/api/projects/preview', 'POST', { name: '另一个' });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body, { name: '另一个', directory: { kind: 'managed', path: join(testWorkRoot(root), 'projects', '另一个') } });
    assert.equal(existsSync(preview.body.directory.path), false);
    const rejected = await httpJson(running.port, '/api/projects/preview', 'POST', { name: '另一个', directory: '/' });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error.message, /不能挂载根目录/u);
    assert.equal((await httpJson(running.port, '/api/projects/preview', 'POST', { name: '文档' })).status, 400);
    assert.equal((await httpJson(running.port, '/api/projects')).body.projects.length, 1);

    // 挂载新目录并设为主目录：之后新建的会话使用它，已有会话不变。
    const mountedDir = join(root, 'mounted-docs');
    mkdirSync(mountedDir);
    const updated = await httpJson(running.port, `/api/projects/${projectId}`, 'PATCH', {
      name: '项目文档', directories: [mountedDir, managedDir], defaultConstraints: '只写 docs/',
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.workspace.name, '项目文档');
    assert.deepEqual(updated.body.project.directories, [{ kind: 'mounted', path: mountedDir }, { kind: 'managed', path: managedDir }]);
    const after = (await httpJson(running.port, '/api/sessions', 'POST', { sessionId: 'after', title: '之后', workspaceId: projectId })).body as WorkspaceSession;
    assert.deepEqual(after.workingDirectory, { kind: 'project-mounted', path: mountedDir });
    const listed = (await httpJson(running.port, `/api/sessions?workspace=${projectId}`)).body.sessions as WorkspaceSession[];
    assert.deepEqual(listed.map((session) => [session.sessionId, session.workingDirectory.path]), [
      ['before', managedDir], ['after', mountedDir],
    ]);
    const created2 = running.adapter.calls.flatMap((call) => call.method === 'createSession'
      ? [[call.input.assistantSessionId, call.input.workingDirectory.path]] : []);
    assert.deepEqual(created2, [['before', managedDir], ['after', mountedDir]]);

    // 接口的校验：非法目录、空列表、未知字段、空请求、非 JSON、不存在的项目。
    const invalid = await httpJson(running.port, `/api/projects/${projectId}`, 'PATCH', { directories: [mountedDir, join(root, 'missing')] });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error.message, /目录不存在/u);
    assert.equal((await httpJson(running.port, `/api/projects/${projectId}`, 'PATCH', { directories: [] })).status, 400);
    assert.equal((await httpJson(running.port, `/api/projects/${projectId}`, 'PATCH', { kind: 'managed' })).status, 400);
    assert.equal((await httpJson(running.port, `/api/projects/${projectId}`, 'PATCH', {})).status, 400);
    assert.equal((await httpJson(running.port, '/api/projects/missing', 'PATCH', { name: 'x' })).status, 404);
    assert.equal((await httpJson(running.port, `/api/projects/${projectId}`, 'DELETE')).status, 405);

    // 重启后更新保留，已有会话仍用各自的目录。
    await running.close();
    running = await startApplication(root);
    assert.deepEqual((await httpJson(running.port, `/api/projects/${projectId}`)).body, updated.body.project);
    assert.deepEqual(
      ((await httpJson(running.port, `/api/sessions?workspace=${projectId}`)).body.sessions as WorkspaceSession[])
        .map((session) => session.workingDirectory.path),
      [managedDir, mountedDir],
    );
  } finally {
    await running.close();
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
