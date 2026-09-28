import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  GLOBAL_ASSISTANT_SESSION_ID,
  type CoordinatorRuntimeConfig,
  type Project,
  type WorkspaceSession,
} from '@multivac/contracts';
import { AssistantOperationLock } from '../src/application/assistant-operation-lock.js';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { ProjectService } from '../src/application/project-service.js';
import { SessionRuntimeRegistry, type SessionRuntime } from '../src/application/session-runtimes.js';
import { SessionWorkingDirectories } from '../src/application/session-working-directories.js';
import {
  WorkspaceSessionService,
  WorkspaceSessionServiceError,
} from '../src/application/workspace-session-service.js';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import {
  conflictingEntries,
  isPathOccupied,
  moveDirectoryEntries,
} from '../src/modules/sessions/directory-entries.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
  SqliteProjectRepository,
  SqliteSessionRegistryRepository,
  SqliteSessionSelectionRepository,
  SqliteWorkspaceRepository,
  SqliteWorkspaceSceneRepository,
} from '../src/storage/sqlite-assistant-store.js';
import { resolveMultivacWorkPaths } from '../src/storage/work-paths.js';
import { testApplicationEnvironment, testDataDir, testWorkRoot } from './fixtures/test-environment.js';

/**
 * 会话归入项目：cwdOverride（id、绑定与历史不变，记录中的工作区与工作目录在一个事务中更新，运行时按新目录重建）、
 * 空闲校验与互斥区、临时目录文件的移入与重名规则。
 */

const config: CoordinatorRuntimeConfig = {
  systemPrompt: '你是 Multivac。',
  authorizedContext: [],
  model: { provider: 'fake', modelId: 'fake', thinkingLevel: 'off' },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
};

interface TestRuntime extends SessionRuntime {
  session: AssistantSessionService;
  isRunning(): boolean;
  retire?<T>(operation: () => T): Promise<T>;
}

/** 服务层夹具：Fake 适配器、真实 SQLite 与工作目录；runtime 可按需覆盖“运行中”与互斥区。 */
function harness(root: string, overrides: {
  running?: (sessionId: string) => boolean;
  lock?: AssistantOperationLock;
} = {}) {
  const store = new SqliteAssistantStore(join(root, 'data.sqlite'));
  const adapter = new FakeCoordinatorAdapter({ sessionPathRoot: join(root, 'sessions'), seedsHistory: () => false });
  const bindingRepository = new SqliteAssistantBindingRepository(store);
  const repository = new SqliteSessionRegistryRepository(store);
  const dataDir = testDataDir(root);
  const workPaths = resolveMultivacWorkPaths(testWorkRoot(root), dataDir);
  const workingDirectories = new SessionWorkingDirectories(workPaths, repository, dataDir);
  const released: string[] = [];
  const runtimes = new SessionRuntimeRegistry<TestRuntime>((record) => {
    const session = new AssistantSessionService({
      adapter,
      bindingRepository,
      pageStateRepository: new SqliteAssistantPageStateRepository(store),
      selectionRepository: new SqliteSessionSelectionRepository(store),
      runtimeConfig: config,
      resolveWorkingDirectory: () => workingDirectories.resolveForRuntime(record.sessionId),
      kind: 'work',
      sessionDir: join(root, 'sessions', 'work'),
      assistantSessionId: record.sessionId,
    });
    const lock = overrides.lock;
    return {
      sessionId: record.sessionId,
      session,
      initialize: () => session.initialize(),
      isRunning: () => overrides.running?.(record.sessionId) ?? false,
      ...(lock ? {
        retire: <T>(operation: () => T) => lock.runFinal(async () => operation(), () => new Error('互斥区已关闭')),
      } : {}),
      dispose: () => {
        released.push(record.sessionId);
        session.close();
        adapter.disposeSession(record.sessionId);
      },
    };
  });
  const workspaces = new SqliteWorkspaceRepository(store);
  const sceneRepository = new SqliteWorkspaceSceneRepository(store);
  let clock = 0;
  const service = new WorkspaceSessionService({
    repository,
    runtimes,
    workingDirectories,
    workspaces,
    sceneRepository,
    now: () => new Date(Date.UTC(2026, 8, 28, 8, 0, clock++)).toISOString(),
  });
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const projectIds = ['proj-a', 'proj-b', 'proj-c'];
  const projects = new ProjectService({
    projects: new SqliteProjectRepository(store),
    workspaces,
    workPaths,
    dataDir,
    homeDir: home,
    newId: () => projectIds.shift()!,
  });
  return { store, adapter, bindingRepository, repository, runtimes, service, projects, released, workPaths };
}

function rejectsWith(code: string, pattern?: RegExp) {
  return (error: unknown) => error instanceof WorkspaceSessionServiceError && error.code === code &&
    (!pattern || pattern.test(error.message));
}

test('目录条目移入：逐个移动文件、子目录与符号链接，同名的一律不覆盖并留在原处', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-directory-entries-'));
  try {
    const source = join(root, 'source');
    const target = join(root, 'target');
    mkdirSync(join(source, 'notes'), { recursive: true });
    mkdirSync(join(target, 'data'), { recursive: true });
    writeFileSync(join(source, 'draft.md'), '临时草稿');
    writeFileSync(join(source, 'notes', 'a.txt'), 'a');
    writeFileSync(join(source, 'README.md'), '临时说明');
    writeFileSync(join(source, 'data'), '与目标中的目录同名的文件');
    mkdirSync(join(source, 'keep'));
    writeFileSync(join(source, 'keep', 'inner.txt'), '临时目录中的 keep');
    symlinkSync('draft.md', join(source, 'link.md'));
    symlinkSync('missing-target', join(source, 'dangling'));
    // 目标中已有：同名文件、同名目录（对应源中的文件）、同名文件（对应源中的目录）、悬空链接。
    writeFileSync(join(target, 'README.md'), '项目说明');
    writeFileSync(join(target, 'keep'), '项目文件');
    symlinkSync('nowhere', join(target, 'dangling'));

    assert.equal(isPathOccupied(join(target, 'dangling')), true);
    assert.equal(isPathOccupied(join(target, 'absent')), false);
    assert.deepEqual(conflictingEntries(source, target), ['README.md', 'dangling', 'data', 'keep']);

    const result = moveDirectoryEntries(source, target);
    assert.deepEqual(result, { moved: ['draft.md', 'link.md', 'notes'], skipped: ['README.md', 'dangling', 'data', 'keep'] });
    // 移入的内容完整，链接按原指向重建。
    assert.equal(readFileSync(join(target, 'draft.md'), 'utf8'), '临时草稿');
    assert.equal(readFileSync(join(target, 'notes', 'a.txt'), 'utf8'), 'a');
    assert.equal(readlinkSync(join(target, 'link.md')), 'draft.md');
    // 同名的没有覆盖任何一方。
    assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), '项目说明');
    assert.equal(readFileSync(join(source, 'README.md'), 'utf8'), '临时说明');
    assert.equal(readFileSync(join(target, 'keep'), 'utf8'), '项目文件');
    assert.equal(readFileSync(join(source, 'keep', 'inner.txt'), 'utf8'), '临时目录中的 keep');
    assert.equal(readlinkSync(join(target, 'dangling')), 'nowhere');
    assert.deepEqual(readdirSync(source).sort(), ['README.md', 'dangling', 'data', 'keep']);

    // 源目录不存在时没有可移动的条目。
    assert.deepEqual(moveDirectoryEntries(join(root, 'absent'), target), { moved: [], skipped: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('会话互斥区的最后一个操作：等前面的操作完成后执行，成功后之后的操作一律拒绝，失败时照常可用', async () => {
  const lock = new AssistantOperationLock();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const first = lock.run(async () => {
    order.push('发送 handoff 开始');
    await new Promise<void>((resolve) => { releaseFirst = resolve; });
    order.push('发送 handoff 结束');
  });

  // 失败的最后操作不关闭互斥区。
  const failed = lock.runFinal(async () => { throw new Error('会话正在运行'); }, () => new Error('已关闭'));
  const final = lock.runFinal(async () => { order.push('归入项目'); return 'moved'; }, () => new Error('已关闭'));
  const queued = lock.run(async () => { order.push('排在后面的发送'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['发送 handoff 开始']);

  releaseFirst();
  await first;
  await assert.rejects(failed, /会话正在运行/u);
  assert.equal(await final, 'moved');
  await assert.rejects(queued, /已关闭/u);
  await assert.rejects(lock.run(async () => undefined), /已关闭/u);
  assert.deepEqual(order, ['发送 handoff 开始', '发送 handoff 结束', '归入项目']);
});

test('归入项目：核对给出目录变化与文件，归入后 id 与绑定不变，按新目录恢复运行时，文件按规则移入，原工作区现场剔除', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-session-move-'));
  const { store, adapter, bindingRepository, repository, runtimes, service, projects, released } = harness(root);
  try {
    const { project } = projects.createProject({ name: '技术研究' });
    const projectDir = project.directories[0]!.path;
    const created = (await service.create({ sessionId: 'move-1', title: '调研' })).session;
    const temp = created.workingDirectory;
    await adapter.prompt('move-1', '归入前的消息');
    const bindingBefore = bindingRepository.get('move-1');
    const historyBefore = adapter.readActiveBranch('move-1');
    assert.equal(historyBefore.ok, true);

    // 临时目录里有文件，其中一个与项目目录中已有的同名。
    writeFileSync(join(temp.path, 'report.md'), '调研报告');
    mkdirSync(join(temp.path, 'data'));
    writeFileSync(join(temp.path, 'data', 'raw.csv'), '1,2');
    writeFileSync(join(temp.path, 'README.md'), '临时说明');
    writeFileSync(join(projectDir, 'README.md'), '项目说明');
    service.saveScene('default', {
      parallelCount: 2, slots: ['move-1'], focusedSessionId: 'move-1', viewMode: 'focus', widths: {}, barVisible: true,
    });

    // 核对：只读，不改任何东西。
    const preview = service.previewMoveToProject('move-1', project.projectId);
    assert.deepEqual(preview, {
      sessionId: 'move-1',
      from: temp,
      to: { kind: 'project-managed', path: projectDir },
      running: false,
      files: { total: 3, names: ['README.md', 'data', 'report.md'], conflictTotal: 1, conflicts: ['README.md'] },
      tempRetentionDays: 30,
    });
    assert.equal(repository.get('move-1')?.workspaceId, 'default');

    const result = await service.moveToProject('move-1', { projectId: project.projectId, moveFiles: true });
    assert.deepEqual(result, {
      session: { ...created, workspaceId: project.projectId, workingDirectory: { kind: 'project-managed', path: projectDir } },
      files: { moved: 2, skippedTotal: 1, skipped: ['README.md'] },
      // 重名的文件留在原处，临时目录保留（从归入时起按保留时长到期移到废纸篓）。
      sourceRemoved: false,
      tempRetentionDays: 30,
    });
    assert.equal(readFileSync(join(projectDir, 'report.md'), 'utf8'), '调研报告');
    assert.equal(readFileSync(join(projectDir, 'data', 'raw.csv'), 'utf8'), '1,2');
    assert.equal(readFileSync(join(projectDir, 'README.md'), 'utf8'), '项目说明');
    assert.deepEqual(readdirSync(temp.path), ['README.md']);

    // 记录：工作区与工作目录更新，其余不变；运行时已释放。
    const record = repository.get('move-1');
    assert.equal(record?.workspaceId, project.projectId);
    assert.deepEqual(record?.workingDirectory, { kind: 'project-managed', path: projectDir });
    assert.deepEqual(released, ['move-1']);
    assert.equal(runtimes.get('move-1'), undefined);
    assert.deepEqual(service.list({ workspaceId: project.projectId }).sessions.map((item) => item.sessionId), ['move-1']);
    assert.deepEqual(service.list().sessions, []);
    // 原工作区保存的现场剔除这个会话；项目工作区的现场不变（按列表顺序补进空栏）。
    assert.deepEqual(service.getScene('default').scene.slots, []);
    assert.equal(service.getScene('default').scene.focusedSessionId, null);
    assert.deepEqual(service.getScene(project.projectId).scene.slots, []);

    // 下次访问按记录中的新目录恢复：同一绑定、同一历史。
    await runtimes.acquire(service.resolve('move-1')).initialize();
    const continued = adapter.calls.filter((call) => call.method === 'continueSession').at(-1);
    assert.ok(continued && continued.method === 'continueSession');
    assert.deepEqual(continued.input.workingDirectory, { kind: 'project-managed', path: projectDir });
    assert.deepEqual(continued.input.binding, bindingBefore);
    assert.deepEqual(bindingRepository.get('move-1'), bindingBefore);
    const historyAfter = adapter.readActiveBranch('move-1');
    assert.deepEqual(historyAfter.ok && historyAfter.value.messages, historyBefore.ok && historyBefore.value.messages);

    // 重放（已在目标项目中）原样返回，不再移动文件、不再释放运行时。
    const replay = await service.moveToProject('move-1', { projectId: project.projectId, moveFiles: true });
    assert.deepEqual(replay, { session: result.session, files: null, sourceRemoved: false, tempRetentionDays: 30 });
    assert.deepEqual(released, ['move-1']);
    assert.throws(() => service.previewMoveToProject('move-1', project.projectId), rejectsWith('INVALID_REQUEST', /已在这个项目中/u));

    // 在项目之间归入：原目录不是临时目录，没有可移入的文件，也不删除任何目录。
    const other = projects.createProject({ name: '另一个项目' }).project;
    const otherPreview = service.previewMoveToProject('move-1', other.projectId);
    assert.equal(otherPreview.files, null);
    const again = await service.moveToProject('move-1', { projectId: other.projectId, moveFiles: true });
    assert.deepEqual(again.files, null);
    assert.equal(again.sourceRemoved, false);
    assert.equal(existsSync(projectDir), true);
    assert.equal(again.session.workingDirectory.path, other.directories[0]!.path);

    // 目标必须是项目；不存在的项目、全局会话、已归档与不存在的会话明确报错。
    await assert.rejects(service.moveToProject('move-1', { projectId: 'default', moveFiles: false }), rejectsWith('INVALID_REQUEST', /只能归入项目/u));
    await assert.rejects(service.moveToProject('move-1', { projectId: 'missing', moveFiles: false }), rejectsWith('NOT_FOUND'));
    await assert.rejects(
      service.moveToProject(GLOBAL_ASSISTANT_SESSION_ID, { projectId: project.projectId, moveFiles: false }),
      rejectsWith('INVALID_REQUEST'),
    );
    service.archive('move-1');
    await assert.rejects(service.moveToProject('move-1', { projectId: project.projectId, moveFiles: false }), rejectsWith('NOT_FOUND'));
    await assert.rejects(service.moveToProject('missing', { projectId: project.projectId, moveFiles: false }), rejectsWith('NOT_FOUND'));
  } finally {
    adapter.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('归入项目的临时目录：为空或全部移入时删除，不移入时文件与目录都留在原处；存储层只改仍在原工作区的会话', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-session-move-temp-'));
  const { store, adapter, repository, service, projects } = harness(root);
  try {
    const project: Project = projects.createProject({ name: '读书' }).project;
    const projectDir = project.directories[0]!.path;
    const moveTo = (sessionId: string, moveFiles: boolean) => service.moveToProject(sessionId, { projectId: project.projectId, moveFiles });

    // 空的临时目录：归入后删除。
    const empty = (await service.create({ sessionId: 'temp-empty', title: '空目录' })).session;
    assert.deepEqual(service.previewMoveToProject('temp-empty', project.projectId).files, {
      total: 0, names: [], conflictTotal: 0, conflicts: [],
    });
    assert.deepEqual(await moveTo('temp-empty', false).then((result) => [result.files, result.sourceRemoved]), [null, true]);
    assert.equal(existsSync(empty.workingDirectory.path), false);

    // 文件全部移入：临时目录随之删除。
    const all = (await service.create({ sessionId: 'temp-all', title: '全部移入' })).session;
    writeFileSync(join(all.workingDirectory.path, 'chapter-1.md'), '第一章');
    const moved = await moveTo('temp-all', true);
    assert.deepEqual(moved.files, { moved: 1, skippedTotal: 0, skipped: [] });
    assert.equal(moved.sourceRemoved, true);
    assert.equal(existsSync(all.workingDirectory.path), false);
    assert.equal(readFileSync(join(projectDir, 'chapter-1.md'), 'utf8'), '第一章');

    // 不移入：文件与临时目录都保留，项目目录不受影响。
    const kept = (await service.create({ sessionId: 'temp-kept', title: '不移入' })).session;
    writeFileSync(join(kept.workingDirectory.path, 'scratch.txt'), '草稿');
    const left = await moveTo('temp-kept', false);
    assert.deepEqual([left.files, left.sourceRemoved], [null, false]);
    assert.equal(readFileSync(join(kept.workingDirectory.path, 'scratch.txt'), 'utf8'), '草稿');
    assert.equal(existsSync(join(projectDir, 'scratch.txt')), false);

    // 存储层的条件更新：会话已不在原工作区（或已归档）时不做修改。
    assert.equal(repository.moveToWorkspace('temp-kept', {
      fromWorkspaceId: 'default', toWorkspaceId: project.projectId, workingDirectory: kept.workingDirectory,
    }), undefined);
    assert.equal(repository.get('temp-kept')?.workingDirectory?.path, projectDir);
  } finally {
    adapter.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('只在空闲时归入：运行中（含等待授权）拒绝且不做任何修改；在会话互斥区内排在进行中的操作之后，之后的操作被拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-session-move-idle-'));
  const running = new Set<string>();
  const lock = new AssistantOperationLock();
  const { store, adapter, repository, runtimes, service, projects, released } = harness(root, {
    running: (sessionId) => running.has(sessionId),
    lock,
  });
  try {
    const project = projects.createProject({ name: '项目' }).project;
    const session = (await service.create({ sessionId: 'busy', title: '运行中' })).session;
    writeFileSync(join(session.workingDirectory.path, 'draft.md'), '草稿');

    running.add('busy');
    assert.equal(service.previewMoveToProject('busy', project.projectId).running, true);
    await assert.rejects(
      service.moveToProject('busy', { projectId: project.projectId, moveFiles: true }),
      rejectsWith('COMMAND_STATE_MISMATCH', /先停止/u),
    );
    // 拒绝时什么都没有改：记录、文件与运行时原样。
    assert.equal(repository.get('busy')?.workspaceId, 'default');
    assert.equal(readFileSync(join(session.workingDirectory.path, 'draft.md'), 'utf8'), '草稿');
    assert.deepEqual(released, []);
    assert.ok(runtimes.get('busy'));

    // 互斥区中有进行中的操作（例如发送 handoff）：归入等它结束，再在互斥区内复核空闲。
    running.delete('busy');
    let finishHandoff!: () => void;
    const handoff = lock.run(async () => {
      await new Promise<void>((resolve) => { finishHandoff = resolve; });
      // handoff 完成后本轮开始运行：排在后面的归入必须看到这一点。
      running.add('busy');
    });
    const blocked = service.moveToProject('busy', { projectId: project.projectId, moveFiles: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(repository.get('busy')?.workspaceId, 'default');
    finishHandoff();
    await handoff;
    await assert.rejects(blocked, rejectsWith('COMMAND_STATE_MISMATCH'));
    assert.equal(repository.get('busy')?.workspaceId, 'default');

    // 本轮结束后归入成功；之后排进旧运行时互斥区的操作一律拒绝，不会落到旧目录上。
    running.delete('busy');
    const result = await service.moveToProject('busy', { projectId: project.projectId, moveFiles: true });
    assert.equal(result.session.workspaceId, project.projectId);
    assert.deepEqual(released, ['busy']);
    await assert.rejects(lock.run(async () => 'late send'), /互斥区已关闭/u);
  } finally {
    adapter.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

function httpJson(
  port: number,
  path: string,
  method = 'GET',
  body?: unknown,
  contentType = 'application/json',
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: '127.0.0.1', port, path, method,
      headers: body === undefined ? {} : { 'content-type': contentType },
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

async function startApplication(root: string, adapter: FakeCoordinatorAdapter) {
  const app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: adapter });
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

test('HTTP 归入项目：运行中返回 422，本轮结束后归入，继续发送按项目目录恢复且历史不变，重启后仍在项目目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-session-move-http-'));
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  // 模型选择随（Fake 的）Pi session 文件保存在测试数据目录中，重启后按绑定恢复时照常对账。
  const sessionPathRoot = join(testDataDir(root), 'fake-pi-sessions');
  mkdirSync(sessionPathRoot, { recursive: true });
  const fakeAdapter = (options: { promptCompletionBarrier?: Promise<void> } = {}) => new FakeCoordinatorAdapter({
    ...options,
    sessionPathRoot,
    seedsHistory: (sessionId) => sessionId === GLOBAL_ASSISTANT_SESSION_ID,
    persistSessionModels: true,
  });
  const adapter = fakeAdapter({ promptCompletionBarrier: barrier });
  let server = await startApplication(root, adapter);
  const texts = (page: { body: { messages: Array<{ role: string; text: string }> } }) =>
    page.body.messages.map((message) => `${message.role}:${message.text}`);
  const send = (port: number, commandId: string, text: string) => httpJson(port, '/api/sessions/mv/turns', 'POST', {
    commandId, assistantSessionId: 'mv', text, contextRefs: [],
  });
  try {
    let port = server.port;
    const project = (await httpJson(port, '/api/projects', 'POST', { name: '归入目标' })).body.project as Project;
    const projectDir = project.directories[0]!.path;
    const session = (await httpJson(port, '/api/sessions', 'POST', { sessionId: 'mv', title: '临时探索' })).body as WorkspaceSession;
    writeFileSync(join(session.workingDirectory.path, 'notes.md'), '探索记录');

    // 一轮进行中：核对写明运行中，归入被拒绝，什么都不改。
    const running = send(port, 'mv-1', '第一条消息');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const preview = await httpJson(port, '/api/sessions/mv/move-to-project/preview', 'POST', { projectId: project.projectId });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.running, true);
    assert.deepEqual(preview.body.to, { kind: 'project-managed', path: projectDir });
    assert.equal(preview.body.files.total, 1);
    const rejected = await httpJson(port, '/api/sessions/mv/move-to-project', 'POST', { projectId: project.projectId, moveFiles: true });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.error.code, 'COMMAND_STATE_MISMATCH');
    assert.equal(existsSync(join(session.workingDirectory.path, 'notes.md')), true);
    release();
    assert.equal((await running).body.terminalOutcome, 'succeeded');
    const before = await httpJson(port, '/api/sessions/mv/session');

    // 请求体与目标的校验。
    assert.equal((await httpJson(port, '/api/sessions/mv/move-to-project', 'POST', { projectId: project.projectId })).status, 400);
    assert.equal((await httpJson(port, '/api/sessions/mv/move-to-project', 'POST', { projectId: project.projectId, moveFiles: true }, 'text/plain')).status, 415);
    assert.equal((await httpJson(port, '/api/sessions/mv/move-to-project', 'POST', { projectId: 'default', moveFiles: true })).status, 400);
    assert.equal((await httpJson(port, '/api/sessions/mv/move-to-project', 'POST', { projectId: 'missing', moveFiles: true })).status, 404);
    assert.equal((await httpJson(port, '/api/sessions/nobody/move-to-project', 'POST', { projectId: project.projectId, moveFiles: true })).status, 404);

    const moved = await httpJson(port, '/api/sessions/mv/move-to-project', 'POST', { projectId: project.projectId, moveFiles: true });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual(moved.body, {
      session: { ...session, workspaceId: project.projectId, workingDirectory: { kind: 'project-managed', path: projectDir } },
      files: { moved: 1, skippedTotal: 0, skipped: [] },
      sourceRemoved: true,
      tempRetentionDays: 30,
    });
    assert.equal(readFileSync(join(projectDir, 'notes.md'), 'utf8'), '探索记录');
    assert.deepEqual((await httpJson(port, '/api/sessions')).body.sessions, []);
    assert.deepEqual((await httpJson(port, `/api/sessions?workspace=${project.projectId}`)).body.sessions, [moved.body.session]);

    // 继续发送：同一个会话与 Pi session，历史保留，运行时按项目目录恢复。
    const next = await send(port, 'mv-2', '归入后继续');
    assert.equal(next.body.terminalOutcome, 'succeeded');
    const after = await httpJson(port, '/api/sessions/mv/session');
    assert.equal(after.body.piSessionId, before.body.piSessionId);
    assert.deepEqual(texts(after).slice(0, texts(before).length), texts(before));
    assert.ok(texts(after).includes('user:归入后继续'));
    const continued = adapter.calls.filter((call) => call.method === 'continueSession' &&
      call.input.binding.assistantSessionId === 'mv').at(-1);
    assert.ok(continued && continued.method === 'continueSession');
    assert.deepEqual(continued.input.workingDirectory, { kind: 'project-managed', path: projectDir });

    // 重启：会话仍在项目工作区，按项目目录恢复。
    await server.close();
    const restarted = fakeAdapter();
    server = await startApplication(root, restarted);
    port = server.port;
    assert.deepEqual((await httpJson(port, `/api/sessions?workspace=${project.projectId}`)).body.sessions, [moved.body.session]);
    assert.equal((await httpJson(port, '/api/sessions/mv/session')).status, 200);
    const reopened = restarted.calls.find((call) => call.method === 'continueSession' &&
      call.input.binding.assistantSessionId === 'mv');
    assert.ok(reopened && reopened.method === 'continueSession');
    assert.deepEqual(reopened.input.workingDirectory, { kind: 'project-managed', path: projectDir });
  } finally {
    release();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
