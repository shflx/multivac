import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Check } from 'typebox/value';
import {
  AssistantToolResultSchema,
  GLOBAL_ASSISTANT_SESSION_ID,
  WorkbenchEventSchema,
  type CurrentViewSnapshot,
  type WorkbenchEvent,
} from '@multivac/contracts';
import {
  InternalToolService,
  MULTIVAC_INTERNAL_TOOLS,
  type InternalToolServices,
  type InternalToolTurn,
} from '../src/application/internal-tools/index.js';
import { ProjectService } from '../src/application/project-service.js';
import { SessionWorkingDirectories } from '../src/application/session-working-directories.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { WorkspaceSessionService, type SessionRuntimeHandle } from '../src/application/workspace-session-service.js';
import type { InternalToolOutcome } from '../src/modules/internal-tools/internal-tool.js';
import {
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
 * 工作区操作类内部工具（真实的 SQLite、会话与项目服务、工作台事件与账本）：
 * - 改现场与界面同一套栏位规则（放进已有会话的栏时互换、当前会话始终保留在显示中），带版本保存并推给所有窗口；
 * - 切换页面只推给发起对话的窗口；窗口已关闭或刷新、窄屏时不切换，如实说明只更新了保存的现场；
 * - 本轮中切换过之后，后续工具以服务端现场与切换后的界面为准。
 */

type Ok = Extract<InternalToolOutcome, { ok: true }>;

async function withWorkspaceTools(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'multivac-workspace-tools-'));
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
  const directories = new SessionWorkingDirectories(workPaths, registry, dataDir, {
    plans: new SqliteTempDirectoryCleanupRepository(store),
  });
  directories.prepareOnStartup();
  const runtimes = {
    acquire: (): SessionRuntimeHandle => ({ initialize: async () => undefined, isRunning: () => false }),
    release: () => undefined,
    get: (): SessionRuntimeHandle | undefined => undefined,
  };
  const events = new WorkbenchEvents();
  let tick = 0;
  const sessions = new WorkspaceSessionService({
    repository: registry, runtimes, workingDirectories: directories, workspaces,
    sceneRepository: new SqliteWorkspaceSceneRepository(store), events,
    now: () => `2026-09-30T01:00:${String(tick += 1).padStart(2, '0')}.000Z`,
  });
  const projects = new ProjectService({
    projects: new SqliteProjectRepository(store), workspaces, workPaths, dataDir, homeDir: home,
  });

  // 两个“窗口”按推送通道的规则收事件：广播都收，定向的只有目标窗口收。
  const inbox = new Map<string, WorkbenchEvent[]>();
  const open = (windowId: string) => {
    inbox.set(windowId, []);
    return events.subscribe((event, delivery) => {
      if (delivery.targetWindowId !== undefined && delivery.targetWindowId !== windowId) return;
      assert.equal(Check(WorkbenchEventSchema, event), true, JSON.stringify(event));
      inbox.get(windowId)!.push(event);
    }, windowId);
  };
  const received = (windowId: string) => inbox.get(windowId) ?? [];

  const windows: InternalToolServices['windows'] = {
    navigate: (windowId, target, origin) => events.publishToWindow(windowId, { type: 'window.navigate', origin, target }),
    isOpen: (windowId) => events.hasWindow(windowId),
  };
  // 这一轮的发送命令、发起窗口与它的当前视图；导航后由工具更新视图（与 AssistantTurnCommandService 相同）。
  let turn: (InternalToolTurn & { view: CurrentViewSnapshot | null }) | null = null;
  const setTurn = (windowId: string | null, view: CurrentViewSnapshot | null, commandId = 'turn-1') => {
    turn = { commandId, windowId, view };
  };
  const service = new InternalToolService({
    tools: MULTIVAC_INTERNAL_TOOLS,
    services: { projects, sessions, transcripts: { readMessages: () => [] }, windows },
    calls: new SqliteInternalToolCallRepository(store),
    currentTurn: () => turn && {
      ...turn,
      updateView: (view) => { if (turn) turn = { ...turn, view }; },
    },
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
  /** 依次新建会话（新建的排在会话列表前面，空出的栏按这个顺序补位）。 */
  let created = 0;
  const create = async (titles: string[], workspaceId = 'default') => {
    const ids: Record<string, string> = {};
    for (const title of titles) {
      ids[title] = (await sessions.create({ sessionId: `s-${created += 1}`, title, workspaceId })).session.sessionId;
    }
    return ids;
  };
  return {
    store, sessions, projects, events, open, received, ok, failed, create, setTurn,
    view: () => turn?.view ?? null,
    scene: (workspaceId = 'default') => sessions.getScene(workspaceId),
  };
}

function view(panel: CurrentViewSnapshot['panel'], workspaceId: string | null, narrow = false): CurrentViewSnapshot {
  return {
    panel, narrow,
    workspace: workspaceId === null ? null : { workspaceId, scene: null },
    management: panel === 'management' ? { page: 'archive', selection: null } : null,
  };
}

const navigations = (events: readonly WorkbenchEvent[]) =>
  events.flatMap((event) => event.type === 'window.navigate' ? [event.target] : []);
const scenes = (events: readonly WorkbenchEvent[]) =>
  events.flatMap((event) => event.type === 'scene.changed' ? [event.scene] : []);

test('open_session：放进第 N 栏与界面同一规则（替换这一栏、已在另一栏时互换），不给栏位时聚焦查看；现场带版本保存并推给各窗口', async () => {
  await withWorkspaceTools(async ({ create, open, received, ok, failed, setTurn, scene, sessions }) => {
    // 会话列表新建的在前：D、C、B、A；并排 2 栏时补位为 D、C。
    const ids = await create(['A', 'B', 'C', 'D']);
    sessions.saveScene('default', { ...scene().scene, parallelCount: 3 });
    assert.deepEqual(sessions.presentedScene('default').scene.slots, [ids.D, ids.C, ids.B]);
    open('window-a');
    open('window-b');
    setTurn('window-a', view('workspace', 'default'));

    // A 不在栏位中：放进第 2 栏替换 C，成为当前会话并回到并排；C 退出显示（仍在会话列表中）。
    const placed = await ok('open_session', { sessionId: ids.A, slot: 2 });
    let saved = scene();
    assert.deepEqual(saved.scene.slots, [ids.D, ids.A, ids.B]);
    assert.equal(saved.scene.focusedSessionId, ids.A);
    assert.equal(saved.scene.viewMode, 'parallel');
    assert.deepEqual(placed.result.receipt, {
      headline: '已把「A」放到第 2 栏',
      detail: '在「默认工作区」中；原来在第 2 栏的「C」退出显示（仍在会话列表中）',
      actions: [{ kind: 'open-session', sessionId: ids.A }],
    });
    assert.match(placed.content, /这个工作区现在是并排 3 栏：第 1 栏「D」，第 2 栏「A」，第 3 栏「B」。/u);
    assert.match(placed.content, /只切换了发起的这个窗口；看着这个工作区的其他窗口同步了现场，但没有被切换页面。/u);

    // 已在另一栏：两栏互换。
    const swapped = await ok('open_session', { sessionId: ids.B, slot: 1 });
    saved = scene();
    assert.deepEqual(saved.scene.slots, [ids.B, ids.A, ids.D]);
    assert.equal(swapped.result.receipt?.detail, '在「默认工作区」中；与原来在第 1 栏的「D」互换');

    // 不给栏位：聚焦查看，栏位不变。
    const focused = await ok('open_session', { sessionId: ids.C });
    saved = scene();
    assert.deepEqual(saved.scene.slots, [ids.B, ids.A, ids.D]);
    assert.equal(saved.scene.focusedSessionId, ids.C);
    assert.equal(saved.scene.viewMode, 'focus');
    assert.equal(focused.result.receipt?.headline, '已在工作区聚焦「C」');

    // 现场的每次变化推给两个窗口（版本依次递增，来源是这一轮）；导航只推给发起窗口。
    assert.deepEqual(scenes(received('window-a')).map((item) => item.revision), [2, 3, 4]);
    assert.deepEqual(scenes(received('window-b')).map((item) => item.revision), [2, 3, 4]);
    assert.deepEqual(received('window-b').filter((event) => event.type === 'scene.changed').map((event) =>
      event.type === 'scene.changed' && event.origin), [1, 2, 3].map(() => ({ windowId: 'window-a', commandId: 'turn-1' })));
    assert.deepEqual(navigations(received('window-a')), [
      { kind: 'workspace', workspaceId: 'default', sessionId: ids.A },
      { kind: 'workspace', workspaceId: 'default', sessionId: ids.B },
      { kind: 'workspace', workspaceId: 'default', sessionId: ids.C },
    ]);
    assert.deepEqual(navigations(received('window-b')), []);

    // 栏位不能超过当前并排数；已归档的会话要先恢复；不存在的会话按 id 查找的提示。
    assert.match(await failed('open_session', { sessionId: ids.A, slot: 4 }),
      /工作区「默认工作区」现在并排 3 栏，没有第 4 栏。可以放进第 1–3 栏；用户要求更多栏时，先用 set_parallel_count/u);
    sessions.archive(ids.D);
    assert.match(await failed('open_session', { sessionId: ids.D }), /会话「D」已归档，需要先恢复才能在工作区打开/u);
    assert.match(await failed('open_session', { sessionId: 'nope' }), /没有 id 为 nope 的会话。可以先用 list_sessions/u);
    assert.match(await failed('open_session', { sessionId: ids.A, slot: 5 }), /参数 slot/u);
  });
});

test('set_parallel_count / set_view_mode：与工作区条相同，当前会话始终保留在显示中；没有变化时不写入、不推送', async () => {
  await withWorkspaceTools(async ({ create, open, received, ok, failed, setTurn, scene, sessions }) => {
    const ids = await create(['A', 'B', 'C', 'D']);
    // 并排 4 栏，当前会话在第 4 栏。
    sessions.saveScene('default', { ...scene().scene, parallelCount: 4, focusedSessionId: ids.A });
    open('window-a');
    setTurn('window-a', view('workspace', 'default'));

    // 调为 2 栏：保留前两栏会放掉当前会话，它替换最后一栏；另一个退出显示。
    const resized = await ok('set_parallel_count', { count: 2 });
    let saved = scene().scene;
    assert.deepEqual(saved.slots, [ids.D, ids.A]);
    assert.equal(saved.parallelCount, 2);
    assert.equal(saved.focusedSessionId, ids.A);
    assert.deepEqual(resized.result.receipt, {
      headline: '已把「默认工作区」调为并排 2 栏',
      detail: '原来是并排 4 栏；「C」、「B」退出显示（仍在会话列表中）',
      actions: [{ kind: 'open-workspace', workspaceId: 'default' }],
    });
    // 调栏数只改现场，不切换页面。
    assert.deepEqual(navigations(received('window-a')), []);

    // 聚焦 → 并排：当前会话在栏位中时保留。调回 3 栏：空出的栏按会话列表补位。
    await ok('set_view_mode', { mode: 'focus' });
    assert.equal(scene().scene.viewMode, 'focus');
    const parallel = await ok('set_view_mode', { mode: 'parallel' });
    assert.equal(parallel.result.receipt?.headline, '已把「默认工作区」切到并排');
    assert.equal(parallel.result.receipt?.detail, '当前会话「A」');
    await ok('set_parallel_count', { count: 3 });
    saved = scene().scene;
    assert.deepEqual(saved.slots, [ids.D, ids.A, ids.C]);

    // 没有变化：不写入、不推送，正文说明没有改动，也没有回执。
    const revision = scene().revision;
    const before = received('window-a').length;
    const same = await ok('set_parallel_count', { count: 3 });
    assert.equal(same.result.receipt, undefined);
    assert.match(same.content, /本来就是并排 3 栏，没有改动/u);
    assert.equal((await ok('set_view_mode', { mode: 'parallel' })).result.summary, '本来就是并排');
    assert.equal(scene().revision, revision);
    assert.equal(received('window-a').length, before);

    // 参数与界面同一范围：只有 2、3、4 栏。
    assert.match(await failed('set_parallel_count', { count: 5 }), /参数 count/u);
    assert.match(await failed('set_parallel_count', { count: 3, workspaceId: 'nowhere' }), /没有 id 为 nowhere 的工作区/u);
    setTurn(null, null);
    assert.match(await failed('set_parallel_count', { count: 2 }), /拿不到发起这条消息的窗口的当前工作区/u);
  });
});

test('定向导航：切换工作区与打开管理页只推给发起窗口，另一个窗口只收到常规的现场变更', async () => {
  await withWorkspaceTools(async ({ sessions, projects, create, open, received, ok, failed, setTurn, scene }) => {
    const research = projects.createProject({ name: '研究项目' }).project;
    const ids = await create(['接口调研'], research.projectId);
    open('window-a');
    open('window-b');
    setTurn('window-a', view('home', 'default'));

    const switched = await ok('switch_workspace', { workspaceId: research.projectId });
    assert.deepEqual(switched.result.receipt, {
      headline: '已切到工作区「研究项目」',
      detail: '并排 2 栏',
      actions: [{ kind: 'open-workspace', workspaceId: research.projectId }],
    });
    assert.deepEqual(switched.result.refs, [
      { kind: 'workspace', workspaceId: research.projectId, label: '研究项目' },
      { kind: 'project', projectId: research.projectId, label: '研究项目' },
    ]);
    assert.match(switched.content, /已把发起这条消息的窗口切到工作区 \[研究项目\]\(multivac:\/\/workspace\//u);
    // 切换工作区不改现场。
    assert.equal(scene(research.projectId).revision, 0);

    const models = await ok('open_management_page', { page: 'models' });
    assert.deepEqual(models.result.receipt, {
      headline: '已打开设置 · 模型', detail: '', actions: [{ kind: 'open-management-page', page: 'models' }],
    });
    const selected = await ok('open_management_page', { page: 'projects', projectId: research.projectId });
    assert.equal(selected.result.receipt?.headline, '已打开设置 · 项目并选中「研究项目」');
    assert.match(await failed('open_management_page', { page: 'archive', sessionId: ids['接口调研'] }), /未归档/u);
    assert.match(await failed('open_management_page', { page: 'sessions' }), /参数 page/u);
    await sessions.archive(ids['接口调研']!, { windowId: 'window-a', commandId: 'turn-1' });
    await ok('open_management_page', { page: 'archive', sessionId: ids['接口调研'] });

    assert.deepEqual(navigations(received('window-a')), [
      { kind: 'workspace', workspaceId: research.projectId, sessionId: ids['接口调研'] },
      { kind: 'management', page: 'models', selection: null },
      { kind: 'management', page: 'projects', selection: { kind: 'project', projectId: research.projectId } },
      { kind: 'management', page: 'archive', selection: { kind: 'session', sessionId: ids['接口调研'] } },
    ]);
    assert.deepEqual(navigations(received('window-b')), []);
    for (const event of received('window-a').filter((event) => event.type === 'window.navigate')) {
      assert.deepEqual(event.origin, { windowId: 'window-a', commandId: 'turn-1' });
    }

    // 只能打开已实现的页面；选中对象要与页面对应、且存在。
    assert.match(await failed('open_management_page', { page: 'inbox' }), /参数 page/u);
    assert.match(await failed('open_management_page', { page: 'models', sessionId: ids['接口调研'] }),
      /sessionId 只能和归档页（archive）一起用/u);
    assert.match(await failed('open_management_page', { page: 'projects', projectId: 'gone' }), /没有 id 为 gone 的项目/u);
    assert.match(await failed('switch_workspace', { workspaceId: 'gone' }), /没有 id 为 gone 的工作区/u);
    assert.equal(navigations(received('window-a')).length, 4);
  });
});

test('发起窗口已关闭或刷新：不推送、不广播，改现场的工具只更新保存的现场并如实说明；只切页面的工具失败', async () => {
  await withWorkspaceTools(async ({ create, open, received, ok, failed, setTurn, scene }) => {
    const ids = await create(['A', 'B', 'C']);
    open('window-b');
    // 发起窗口 window-a 已不在（刷新后换了窗口 id）。
    setTurn('window-a', view('workspace', 'default'));

    const placed = await ok('open_session', { sessionId: ids.A, slot: 1 });
    assert.deepEqual(scene().scene.slots, [ids.A, ids.B]);
    assert.equal(placed.result.receipt?.detail,
      '在「默认工作区」中；原来在第 1 栏的「C」退出显示（仍在会话列表中）；界面没有打开，只更新了保存的现场');
    assert.match(placed.content, /发起这条消息的界面已经没有打开（窗口已关闭或刷新），没有切换页面；请照实告诉用户。/u);
    const resized = await ok('set_parallel_count', { count: 3 });
    assert.match(resized.result.receipt!.detail, /界面没有打开，只更新了保存的现场$/u);

    assert.match(await failed('switch_workspace', { workspaceId: 'default' }), /没有切到工作区「默认工作区」：界面没有打开，没有切换。/u);
    assert.match(await failed('open_management_page', { page: 'models' }), /没有打开设置 · 模型：界面没有打开，没有切换。/u);
    // 另一个窗口照常收到现场变更，但收不到任何导航。
    assert.deepEqual(scenes(received('window-b')).length, 2);
    assert.deepEqual(navigations(received('window-b')), []);

    // 不是从界面发出的消息（没有窗口身份）同样如此。
    setTurn(null, view('workspace', 'default'));
    assert.match((await ok('open_session', { sessionId: ids.C })).result.receipt!.detail, /界面没有打开，只更新了保存的现场/u);
  });
});

test('窄屏：不切换页面，回执说明窄屏下工作区不可用、已更新保存的现场', async () => {
  await withWorkspaceTools(async ({ create, open, received, ok, failed, setTurn, scene }) => {
    const ids = await create(['A', 'B']);
    open('window-a');
    setTurn('window-a', view('home', 'default', true));

    const focused = await ok('open_session', { sessionId: ids.A });
    assert.equal(scene().scene.focusedSessionId, ids.A);
    assert.equal(focused.result.receipt?.detail, '在「默认工作区」中；窄屏下工作区不可用，已更新保存的现场');
    assert.match(focused.content, /处于窄屏（只显示 Multivac 首页，工作区与管理不可用），没有切换页面/u);
    assert.match((await ok('set_view_mode', { mode: 'parallel' })).result.receipt!.detail, /窄屏下工作区不可用，已更新保存的现场$/u);
    assert.match(await failed('switch_workspace', { workspaceId: 'default' }), /窄屏下工作区不可用，没有切换/u);
    assert.match(await failed('open_management_page', { page: 'preferences' }), /窄屏下工作区不可用，没有切换/u);
    assert.deepEqual(navigations(received('window-a')), []);
    assert.equal(scenes(received('window-a')).length, 2);
  });
});

test('同一轮中切换过之后：后续工具以切换后的界面与服务端现场为准，不用发送时的旧快照', async () => {
  await withWorkspaceTools(async ({ projects, create, open, received, ok, setTurn, scene, view: currentView }) => {
    const research = projects.createProject({ name: '研究项目' }).project;
    await create(['A', 'B']);
    const ids = await create(['R1', 'R2', 'R3'], research.projectId);
    open('window-a');
    // 发送时窗口在默认工作区并排 2 栏（快照里的栏位是发送那一刻的）。
    setTurn('window-a', {
      panel: 'workspace', narrow: false,
      workspace: { workspaceId: 'default', scene: { parallelCount: 2, viewMode: 'parallel', slots: ['s-2', 's-1'], focusedSessionId: 's-2' } },
      management: null,
    });

    // “切到研究项目，并排数调到 3，再把 R1 放到第一栏”：后两步落在研究项目上。
    await ok('switch_workspace', { workspaceId: research.projectId });
    assert.deepEqual(currentView(), {
      panel: 'workspace', narrow: false, workspace: { workspaceId: research.projectId, scene: null }, management: null,
    });
    await ok('set_parallel_count', { count: 3 });
    await ok('open_session', { sessionId: ids.R1, slot: 1 });
    assert.deepEqual(scene(research.projectId).scene.slots, [ids.R1, ids.R2, ids.R3]);
    assert.equal(scene(research.projectId).scene.parallelCount, 3);
    assert.equal(scene('default').revision, 0);

    // get_current_view 也按切换后的界面，栏位读服务端现场。
    const current = await ok('get_current_view', {});
    assert.match(current.content, /本轮中经工具切换过的已按切换后的结果更新/u);
    assert.match(current.content, /- 当前工作区：「研究项目」/u);
    assert.match(current.content, /工作区视图（按服务端保存的现场）：并排 3 栏/u);
    assert.match(current.content, /- 第 1 栏：\[R1\]/u);

    // 打开管理页之后，当前面板是管理，当前工作区保留。
    await ok('open_management_page', { page: 'models' });
    assert.equal(currentView()?.panel, 'management');
    assert.equal(currentView()?.workspace?.workspaceId, research.projectId);
    assert.deepEqual(navigations(received('window-a')).map((target) => target.kind), ['workspace', 'workspace', 'management']);
  });
});

test('账本重放：同一调用再次到达只返回原结果，不再改现场，也不再推送导航', async () => {
  await withWorkspaceTools(async ({ create, open, received, ok, setTurn, scene }) => {
    const ids = await create(['A', 'B', 'C']);
    open('window-a');
    setTurn('window-a', view('workspace', 'default'));
    const first = await ok('open_session', { sessionId: ids.A, slot: 2 }, 'place-a');
    const revision = scene().revision;
    const count = received('window-a').length;
    const replayed = await ok('open_session', { sessionId: ids.A, slot: 2 }, 'place-a');
    assert.deepEqual(replayed, first);
    assert.equal(scene().revision, revision);
    assert.equal(received('window-a').length, count);
  });
});
