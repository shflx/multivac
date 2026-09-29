import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { Check } from 'typebox/value';
import {
  AssistantToolResultSchema,
  GLOBAL_ASSISTANT_SESSION_ID,
  type AssistantMessageView,
  type CurrentViewSnapshot,
  type TempRetentionDays,
  type WorkbenchEvent,
} from '@multivac/contracts';
import {
  InternalToolService,
  MULTIVAC_INTERNAL_TOOLS,
  type InternalToolTurn,
} from '../src/application/internal-tools/index.js';
import { sessionIdForCommand } from '../src/application/internal-tools/session-tools.js';
import { ProjectService } from '../src/application/project-service.js';
import { SessionWorkingDirectories } from '../src/application/session-working-directories.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { WorkspaceSessionService, type SessionRuntimeHandle } from '../src/application/workspace-session-service.js';
import { internalToolCommandId, type InternalToolOutcome } from '../src/modules/internal-tools/internal-tool.js';
import { renderSessionContextForModel } from '../src/runtime/executors/pi-quote-carriage.js';
import {
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
  SqliteInternalToolCallRepository,
  SqliteProjectRepository,
  SqliteSessionRegistryRepository,
  SqliteTempDirectoryCleanupRepository,
  SqliteWorkspaceRepository,
  SqliteWorkspaceSceneRepository,
} from '../src/storage/sqlite-assistant-store.js';
import { resolveMultivacWorkPaths } from '../src/storage/work-paths.js';
import { testDataDir, testWorkRoot } from './fixtures/test-environment.js';

/**
 * 会话管理类内部工具（真实的 SQLite、会话与项目服务、临时目录生命周期与账本）：新建、改名、归档、恢复的规则
 * 与界面一致；写方法带上这一轮的来源，变更事件由服务发布；账本重放不重复执行；回执字段在公开白名单内。
 */

type Ok = Extract<InternalToolOutcome, { ok: true }>;

async function withSessionTools(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'multivac-session-tools-'));
  const fixture = await setup(root);
  try {
    await run(fixture);
  } finally {
    fixture.store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function setup(root: string) {
  const dataDir = testDataDir(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const workPaths = resolveMultivacWorkPaths(testWorkRoot(root), dataDir);
  const store = new SqliteAssistantStore(join(dataDir, 'multivac.sqlite'));
  const registry = new SqliteSessionRegistryRepository(store);
  const workspaces = new SqliteWorkspaceRepository(store);
  const plans = new SqliteTempDirectoryCleanupRepository(store);
  const directories = new SessionWorkingDirectories(workPaths, registry, dataDir, { plans });
  directories.prepareOnStartup();
  const pageStates = new SqliteAssistantPageStateRepository(store);
  // 运行中的会话由测试指定；记下建立运行时的会话（新建会话与读取父会话历史时建立）。
  const running = new Set<string>();
  const initialized: string[] = [];
  const runtimes = {
    acquire: (record: { sessionId: string }): SessionRuntimeHandle => ({
      initialize: async () => { initialized.push(record.sessionId); },
      isRunning: () => running.has(record.sessionId),
    }),
    release: () => undefined,
    get: (sessionId: string): SessionRuntimeHandle | undefined =>
      running.has(sessionId) ? { initialize: async () => undefined, isRunning: () => true } : undefined,
  };
  const histories = new Map<string, AssistantMessageView[]>();
  const events = new WorkbenchEvents();
  const published: WorkbenchEvent[] = [];
  events.subscribe((event) => published.push(event));
  let retention: TempRetentionDays = 30;
  let tick = 0;
  const sessions = new WorkspaceSessionService({
    repository: registry, runtimes, workingDirectories: directories, workspaces,
    sceneRepository: new SqliteWorkspaceSceneRepository(store),
    pageStateRepository: pageStates,
    readSessionHistory: async (record) => ({ piSessionId: `pi-${record.sessionId}`, messages: histories.get(record.sessionId) ?? [] }),
    tempRetentionDays: () => retention,
    events,
    now: () => `2026-09-30T01:00:${String(tick += 1).padStart(2, '0')}.000Z`,
  });
  const projects = new ProjectService({
    projects: new SqliteProjectRepository(store), workspaces, workPaths, dataDir, homeDir: home,
  });
  let turn: InternalToolTurn | null = { commandId: 'turn-1', windowId: 'window-a', view: null };
  const ledger = new SqliteInternalToolCallRepository(store);
  const service = new InternalToolService({
    tools: MULTIVAC_INTERNAL_TOOLS,
    services: { projects, sessions, transcripts: { readMessages: () => [] } },
    calls: ledger,
    currentTurn: () => turn,
  });
  let calls = 0;
  const invoke = async (toolName: string, args: Record<string, unknown>, toolCallId = `call-${calls += 1}`) => {
    const outcome = await service.invoke(
      { assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, toolName, toolCallId, args },
      new AbortController().signal,
    );
    if (outcome.ok) assert.equal(Check(AssistantToolResultSchema, outcome.result), true, JSON.stringify(outcome.result));
    return outcome;
  };
  const ok = async (toolName: string, args: Record<string, unknown>, toolCallId?: string): Promise<Ok> => {
    const outcome = await invoke(toolName, args, toolCallId);
    assert.equal(outcome.ok, true, outcome.ok ? undefined : outcome.reason);
    return outcome as Ok;
  };
  const failed = async (toolName: string, args: Record<string, unknown>) => {
    const outcome = await invoke(toolName, args);
    assert.equal(outcome.ok, false);
    return (outcome as Extract<InternalToolOutcome, { ok: false }>).reason;
  };
  return {
    root, store, registry, sessions, projects, plans, pageStates, running, initialized, histories, published,
    ok, failed,
    setTurn: (next: InternalToolTurn | null) => { turn = next; },
    setRetention: (days: TempRetentionDays) => { retention = days; },
    workSessions: () => sessions.list({ workspaceId: null, includeArchived: true }).sessions,
  };
}

function workspaceView(workspaceId: string): CurrentViewSnapshot {
  return { panel: 'home', narrow: false, workspace: { workspaceId, scene: null }, management: null };
}

test('create_session：默认建在发起窗口的当前工作区，拿不到或已不存在时建在默认工作区并说明；工作目录与界面新建一致', async () => {
  await withSessionTools(async ({ projects, sessions, published, ok, failed, setTurn, workSessions }) => {
    const research = projects.createProject({ name: '研究项目' }).project;

    // 发送时的当前视图记着项目工作区：建在项目里，使用项目主目录；不自动打开，回执带“在工作区打开”。
    setTurn({ commandId: 'turn-1', windowId: 'window-a', view: workspaceView(research.projectId) });
    const inProject = await ok('create_session', { title: '  接口调研  ' });
    const created = workSessions().find((session) => session.title === '接口调研')!;
    assert.equal(created.workspaceId, research.projectId);
    assert.equal(created.workingDirectory.kind, 'project-managed');
    assert.equal(created.workingDirectory.path, research.directories[0]!.path);
    assert.match(inProject.content, new RegExp(`已在工作区「研究项目」新建会话 \\[接口调研\\]\\(multivac://session/${created.sessionId}\\)`, 'u'));
    assert.match(inProject.content, /没有自动打开它，也没有向它发送消息/u);
    assert.deepEqual(inProject.result, {
      summary: '已新建「接口调研」',
      refs: [{ kind: 'session', sessionId: created.sessionId, label: '接口调研' }],
      receipt: {
        headline: '已新建会话「接口调研」',
        detail: '在「研究项目」中',
        actions: [{ kind: 'open-session', sessionId: created.sessionId }],
      },
    });
    // 会话 id 由这次调用的幂等命令 id 派生，写成 UUID 形式；事件带上这一轮与发起窗口。
    assert.equal(created.sessionId, sessionIdForCommand(internalToolCommandId(GLOBAL_ASSISTANT_SESSION_ID, 'call-1')));
    assert.match(created.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    assert.deepEqual(published.map((event) => event.type === 'session.changed' && [event.change, event.origin]), [
      ['created', { windowId: 'window-a', commandId: 'turn-1' }],
    ]);

    // 没有带视图（不是从界面发出）：建在默认工作区，使用会话自己的临时目录，并说明原因。
    setTurn({ commandId: 'turn-2', windowId: null, view: null });
    const fallback = await ok('create_session', { title: '周报' });
    const weekly = workSessions().find((session) => session.title === '周报')!;
    assert.equal(weekly.workspaceId, 'default');
    assert.equal(weekly.workingDirectory.kind, 'session-temp');
    assert.equal(existsSync(weekly.workingDirectory.path), true);
    assert.match(fallback.content, /注意：拿不到发起这条消息的窗口的当前工作区，已建在默认工作区/u);
    assert.equal(fallback.result.receipt?.detail, '在「默认工作区」中；拿不到发起这条消息的窗口的当前工作区，已建在默认工作区');

    // 视图里的工作区已不存在：同样回到默认工作区并说明。
    setTurn({ commandId: 'turn-3', windowId: 'window-a', view: workspaceView('gone') });
    assert.match((await ok('create_session', { title: '草稿' })).content, /发起的窗口所在的工作区已不存在，已建在默认工作区/u);

    // 明确指定工作区优先于当前视图；不存在的工作区失败，不新建。
    const explicit = await ok('create_session', { title: '另一个', workspaceId: 'default' });
    assert.equal(explicit.result.receipt?.detail, '在「默认工作区」中');
    const before = workSessions().length;
    assert.match(await failed('create_session', { title: '无处可去', workspaceId: 'nowhere' }), /没有 id 为 nowhere 的工作区。可以先用 list_workspaces/u);
    // 名称与界面同一规则：去掉首尾空白后不能为空，不超过 80 字；参数不合格的调用不执行。
    assert.match(await failed('create_session', { title: '   ' }), /没有新建会话：会话名称不能为空。/u);
    assert.match(await failed('create_session', { title: 'x'.repeat(81) }), /参数 title /u);
    assert.match(await failed('create_session', {}), /缺少参数 title/u);
    assert.equal(workSessions().length, before);

    // 每次调用各有自己的 id，临时目录名中的短 id 也各不相同。
    const temps = workSessions().filter((session) => session.workingDirectory.kind === 'session-temp');
    assert.equal(new Set(temps.map((session) => basename(session.workingDirectory.path).slice(-8))).size, temps.length);
    assert.notEqual(sessions.get(weekly.sessionId).sessionId, created.sessionId);
  });
});

test('create_session：指定父会话时新建栈式子会话，留在父会话的工作区，只承接父会话背景、不带选中内容；父会话须未归档', async () => {
  await withSessionTools(async ({ projects, sessions, registry, pageStates, histories, ok, failed, setTurn, workSessions }) => {
    const research = projects.createProject({ name: '研究项目' }).project;
    await sessions.create({ sessionId: 'parent', title: '导航结构', workspaceId: research.projectId });
    histories.set('parent', [
      { id: 'pi:1', piSessionId: 'pi-parent', piEntryId: 'e1', role: 'user', text: '整理导航', createdAt: '2026-09-30T00:00:01.000Z' },
      { id: 'pi:2', piSessionId: 'pi-parent', piEntryId: 'e2', role: 'assistant', text: '分三层', createdAt: '2026-09-30T00:00:02.000Z' },
    ]);
    // 当前视图在默认工作区也不影响：子会话总是留在父会话的工作区。
    setTurn({ commandId: 'turn-1', windowId: 'window-a', view: workspaceView('default') });

    const stacked = await ok('create_session', { title: '第三层细节', parentSessionId: 'parent' });
    const child = workSessions().find((session) => session.title === '第三层细节')!;
    assert.equal(child.parentSessionId, 'parent');
    assert.equal(child.workspaceId, research.projectId);
    assert.equal(child.originText, null);
    assert.equal(child.workingDirectory.path, sessions.get('parent').workingDirectory.path);
    assert.deepEqual(registry.get(child.sessionId)!.origin, { parentTitle: '导航结构', parentExcerpt: '用户：整理导航\n助手：分三层' });
    // 不带选中内容：子会话输入区没有来自父会话的引用。
    assert.equal(pageStates.get(child.sessionId).quote, null);
    assert.match(stacked.content, /它是 \[导航结构\]\(multivac:\/\/session\/parent\) 的栈式子会话，承接了父会话最近内容的摘录（没有带选中内容）/u);
    assert.equal(stacked.result.receipt?.detail, '在「研究项目」中；「导航结构」的栈式子会话');
    assert.deepEqual(stacked.result.refs.map((ref) => ref.label), ['第三层细节', '导航结构']);

    // 子会话首轮承接父会话背景：没有选中内容时说明是 Multivac 新建的子会话，不写“选中的内容”。
    const context = renderSessionContextForModel({ kind: 'parent-session', sessionId: 'parent', title: '导航结构', excerpt: '用户：整理导航' });
    assert.match(context, /这是会话「导航结构」的栈式子会话，由 Multivac 应用户要求新建，没有带父会话中选中的内容/u);
    assert.doesNotMatch(context, /父会话中选中的内容：/u);

    assert.match(await failed('create_session', { title: 'x', parentSessionId: 'parent', workspaceId: 'default' }),
      /栈式子会话只能留在父会话所在的工作区「研究项目」/u);
    assert.match(await failed('create_session', { title: 'x', parentSessionId: 'missing' }), /没有 id 为 missing 的会话/u);
    assert.match(await failed('create_session', { title: 'x', parentSessionId: GLOBAL_ASSISTANT_SESSION_ID }), /只用于工作会话/u);
    sessions.archive('parent');
    const count = workSessions().length;
    assert.match(await failed('create_session', { title: 'x', parentSessionId: 'parent' }),
      /父会话「导航结构」已归档，不能在它下面新建栈式子会话。可以先用 restore_session 恢复它/u);
    assert.equal(workSessions().length, count);
  });
});

test('rename_session：与界面同一规则；同名不改动不发布；已归档、不存在与全局 Multivac 拒绝', async () => {
  await withSessionTools(async ({ sessions, published, ok, failed }) => {
    await sessions.create({ sessionId: 'a', title: '旧名' });
    published.length = 0;

    const renamed = await ok('rename_session', { sessionId: 'a', title: '新名' });
    assert.equal(sessions.get('a').title, '新名');
    assert.match(renamed.content, /已把会话「旧名」改名为 \[新名\]\(multivac:\/\/session\/a\)（id: a）/u);
    assert.deepEqual(renamed.result, {
      summary: '「旧名」改名为「新名」',
      refs: [{ kind: 'session', sessionId: 'a', label: '新名' }],
      receipt: { headline: '已改名为「新名」', detail: '原名「旧名」', actions: [{ kind: 'open-session', sessionId: 'a' }] },
    });
    assert.deepEqual(published.map((event) => event.type === 'session.changed' && event.change), ['renamed']);

    const unchanged = await ok('rename_session', { sessionId: 'a', title: ' 新名 ' });
    assert.equal(unchanged.result.summary, '名称没有变化');
    assert.equal(unchanged.result.receipt, undefined);
    assert.equal(published.length, 1);

    assert.match(await failed('rename_session', { sessionId: 'nope', title: 'x' }), /没有改名会话：没有 id 为 nope 的会话。可以先用 list_sessions/u);
    assert.match(await failed('rename_session', { sessionId: GLOBAL_ASSISTANT_SESSION_ID, title: 'x' }), /只用于工作会话/u);
    assert.match(await failed('rename_session', { sessionId: 'a', title: '   ' }), /没有改名：会话名称不能为空。/u);
    sessions.archive('a');
    assert.match(await failed('rename_session', { sessionId: 'a', title: '再改' }), /没有改名：会话「新名」已归档。可以先用 restore_session 恢复/u);
    assert.equal(sessions.get('a').title, '新名');
  });
});

test('archive_session：运行中拒绝；临时目录有文件时写明保留期，空目录随归档删除，项目目录不清理；回执带“恢复”', async () => {
  await withSessionTools(async ({ projects, sessions, plans, running, published, ok, failed, setRetention }) => {
    const research = projects.createProject({ name: '研究项目' }).project;
    const withFiles = (await sessions.create({ sessionId: 'files', title: '有文件' })).session;
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md']) writeFileSync(join(withFiles.workingDirectory.path, name), name);
    const empty = (await sessions.create({ sessionId: 'empty', title: '空目录' })).session;
    await sessions.create({ sessionId: 'project', title: '项目会话', workspaceId: research.projectId });
    await sessions.create({ sessionId: 'busy', title: '运行中' });
    published.length = 0;

    // 运行中（含等待授权）：拒绝并说明，不做任何修改。
    running.add('busy');
    assert.match(await failed('archive_session', { sessionId: 'busy' }),
      /没有归档：会话「运行中」正在运行（或在等待授权），运行中的会话不能归档。请用户先在工作区停止这一轮或处理授权/u);
    assert.equal(sessions.get('busy').archivedAt, null);
    assert.deepEqual(published, []);

    const archived = await ok('archive_session', { sessionId: 'files' });
    assert.notEqual(sessions.get('files').archivedAt, null);
    const directory = '临时目录里还有 6 个文件（a.md、b.md、c.md、d.md、e.md 等），保留 30 天后移到废纸篓，到期前恢复会话则取消清理。';
    assert.match(archived.content, new RegExp(`已归档会话 \\[有文件\\]\\(multivac://session/files\\)（id: files）。对话历史保留；${directory}`, 'u'));
    assert.deepEqual(archived.result, {
      summary: '已归档「有文件」',
      refs: [{ kind: 'session', sessionId: 'files', label: '有文件' }],
      receipt: { headline: '已归档「有文件」', detail: directory, actions: [{ kind: 'restore-session', sessionId: 'files' }] },
    });
    // 与界面归档同一生命周期：有文件的临时目录保留并登记清理计划。
    assert.equal(existsSync(withFiles.workingDirectory.path), true);
    assert.equal(plans.get(withFiles.workingDirectory.path)?.reason, 'archived');
    assert.deepEqual(published.map((event) => event.type === 'session.changed' && [event.change, event.origin.commandId]), [
      ['archived', 'turn-1'],
    ]);

    const emptied = await ok('archive_session', { sessionId: 'empty' });
    assert.equal(emptied.result.receipt?.detail, '临时目录是空的，已随归档删除。');
    assert.equal(existsSync(empty.workingDirectory.path), false);
    assert.equal((await ok('archive_session', { sessionId: 'project' })).result.receipt?.detail, '工作目录是项目托管目录，不会被清理。');

    setRetention(null);
    const kept = (await sessions.create({ sessionId: 'kept', title: '一直保留' })).session;
    writeFileSync(join(kept.workingDirectory.path, 'notes.txt'), '内容');
    assert.match((await ok('archive_session', { sessionId: 'kept' })).result.receipt!.detail, /一直保留（偏好为从不清理）/u);

    assert.match(await failed('archive_session', { sessionId: 'files' }), /没有归档：会话「有文件」已经归档（归档于 [^）]+），不需要再次归档。需要找回时用 restore_session 恢复/u);
    assert.match(await failed('archive_session', { sessionId: GLOBAL_ASSISTANT_SESSION_ID }), /只用于工作会话/u);
  });
});

test('restore_session：回到原工作区；临时目录已被移到废纸篓时如实说明并重建空目录；没有归档的不需要恢复', async () => {
  await withSessionTools(async ({ root, sessions, plans, ok, failed }) => {
    const session = (await sessions.create({ sessionId: 'a', title: '周报' })).session;
    writeFileSync(join(session.workingDirectory.path, 'draft.md'), '草稿');
    assert.match(await failed('restore_session', { sessionId: 'a' }), /没有恢复：会话「周报」没有归档，不需要恢复。/u);

    sessions.archive('a');
    // 模拟到期清理：目录移到（测试用的）废纸篓，计划记下移走的时间与位置。
    const trashPath = join(root, 'trash', basename(session.workingDirectory.path));
    mkdirSync(join(root, 'trash'), { recursive: true });
    renameSync(session.workingDirectory.path, trashPath);
    plans.markTrashed(session.workingDirectory.path, '2026-10-30T08:00:00.000Z', trashPath);

    const restored = await ok('restore_session', { sessionId: 'a' });
    assert.equal(sessions.get('a').archivedAt, null);
    assert.equal(existsSync(session.workingDirectory.path), true);
    assert.equal(plans.get(session.workingDirectory.path), undefined);
    assert.match(restored.content, /已恢复会话 \[周报\]\(multivac:\/\/session\/a\)（id: a），它回到工作区「默认工作区」，对话历史、工作目录与父子关系照旧。/u);
    assert.match(restored.content, new RegExp(`它的临时目录已于 2026-10-3[01] 到期移到废纸篓（${trashPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}），已重建空的临时目录`, 'u'));
    assert.equal(restored.result.summary, '已恢复「周报」');
    assert.match(restored.result.receipt!.detail, /^回到工作区「默认工作区」；它的临时目录已于 .+ 到期移到废纸篓/u);
    assert.deepEqual(restored.result.receipt!.actions, [{ kind: 'open-session', sessionId: 'a' }]);

    // 目录没有被移走（到期前恢复）：不另作说明。
    sessions.archive('a');
    assert.equal((await ok('restore_session', { sessionId: 'a' })).result.receipt?.detail, '回到工作区「默认工作区」');
    assert.match(await failed('restore_session', { sessionId: 'missing' }), /没有恢复会话：没有 id 为 missing 的会话/u);
  });
});

test('会话管理工具记入账本：同一调用重放返回原结果，不重复新建、不重复发布；新的调用照常执行', async () => {
  await withSessionTools(async ({ sessions, published, ok, workSessions }) => {
    const first = await ok('create_session', { title: '只建一次', workspaceId: 'default' }, 'replay-create');
    const again = await ok('create_session', { title: '只建一次', workspaceId: 'default' }, 'replay-create');
    assert.deepEqual(again, first);
    assert.equal(workSessions().filter((session) => session.title === '只建一次').length, 1);

    const sessionId = first.result.refs[0]!.kind === 'session' ? first.result.refs[0]!.sessionId : '';
    const archived = await ok('archive_session', { sessionId }, 'replay-archive');
    // 重放不再执行：即便会话此刻已恢复，同一调用也只返回原结果，不会再次归档。
    sessions.restore(sessionId);
    assert.deepEqual(await ok('archive_session', { sessionId }, 'replay-archive'), archived);
    assert.equal(sessions.get(sessionId).archivedAt, null);
    assert.deepEqual(published.map((event) => event.type === 'session.changed' && event.change), ['created', 'archived', 'restored']);

    // 另一次调用（新的 toolCallId）是新的操作。
    await ok('create_session', { title: '只建一次', workspaceId: 'default' }, 'another-create');
    assert.equal(workSessions().filter((session) => session.title === '只建一次').length, 2);
  });
});
