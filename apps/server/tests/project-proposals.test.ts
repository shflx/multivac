import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Check } from 'typebox/value';
import {
  AssistantToolResultSchema,
  CreateProjectProposalPreviewSchema,
  GLOBAL_ASSISTANT_SESSION_ID,
  MoveSessionToProjectProposalPreviewSchema,
  ProposalSchema,
  type Proposal,
  type WorkbenchEvent,
} from '@multivac/contracts';
import { InternalToolService, MULTIVAC_INTERNAL_TOOLS } from '../src/application/internal-tools/index.js';
import type { InternalToolTurn } from '../src/application/internal-tools/internal-tool-service.js';
import { ProjectService } from '../src/application/project-service.js';
import {
  createProjectKind,
  mountDirectoryKind,
  moveSessionToProjectKind,
  setPrimaryDirectoryKind,
  unmountDirectoryKind,
} from '../src/application/proposals/project-proposals.js';
import { ProposalService, ProposalServiceError } from '../src/application/proposals/proposal-service.js';
import { SessionWorkingDirectories } from '../src/application/session-working-directories.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { WorkspaceSessionService, type SessionRuntimeHandle } from '../src/application/workspace-session-service.js';
import type { InternalToolOutcome } from '../src/modules/internal-tools/internal-tool.js';
import {
  SqliteAssistantStore,
  SqliteInternalToolCallRepository,
  SqliteProjectRepository,
  SqliteProposalRepository,
  SqliteSessionRegistryRepository,
  SqliteTempDirectoryCleanupRepository,
  SqliteWorkspaceRepository,
  SqliteWorkspaceSceneRepository,
} from '../src/storage/sqlite-assistant-store.js';
import { resolveMultivacWorkPaths } from '../src/storage/work-paths.js';
import { testDataDir, testWorkRoot } from './fixtures/test-environment.js';

/**
 * 项目与归入项目的对话操作（真实的 SQLite、项目与会话服务、提议服务与内部工具账本）：
 * - 提议类：新建项目、挂载 / 卸载目录、设主目录、归入项目只生成确认卡，校验与界面同一套；
 *   用户确认时按当前状态重新校验（目标已变化即过期、不执行），执行参数只来自提议记录与用户在卡上的选择；
 * - 管理类：项目改名、修改默认约束直接执行并带回执。
 */

type Ok = Extract<InternalToolOutcome, { ok: true }>;
type Failed = Extract<InternalToolOutcome, { ok: false }>;

async function withWorld(run: (world: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'multivac-project-proposals-'));
  const world = await setup(root);
  try {
    await run(world);
  } finally {
    world.store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function setup(root: string) {
  const dataDir = testDataDir(root);
  const home = join(root, 'home');
  const code = join(root, 'code');
  mkdirSync(home, { recursive: true });
  mkdirSync(code, { recursive: true });
  const workPaths = resolveMultivacWorkPaths(testWorkRoot(root), dataDir);
  const store = new SqliteAssistantStore(join(dataDir, 'multivac.sqlite'));
  const registry = new SqliteSessionRegistryRepository(store);
  const workspaces = new SqliteWorkspaceRepository(store);
  const directories = new SessionWorkingDirectories(workPaths, registry, dataDir, {
    plans: new SqliteTempDirectoryCleanupRepository(store),
  });
  directories.prepareOnStartup();
  // 运行中的会话由测试指定（含等待授权）；归入在互斥区内执行时服务会再判一次。
  const running = new Set<string>();
  const runtimes = {
    acquire: (record: { sessionId: string }): SessionRuntimeHandle => ({
      initialize: async () => undefined,
      isRunning: () => running.has(record.sessionId),
    }),
    release: () => undefined,
    get: (sessionId: string): SessionRuntimeHandle | undefined =>
      running.has(sessionId) ? { initialize: async () => undefined, isRunning: () => true } : undefined,
  };
  const events = new WorkbenchEvents();
  const published: WorkbenchEvent[] = [];
  events.subscribe((event) => published.push(event));
  const sessions = new WorkspaceSessionService({
    repository: registry, runtimes, workingDirectories: directories, workspaces,
    sceneRepository: new SqliteWorkspaceSceneRepository(store), events,
  });
  const ids = ['proj-1', 'proj-2', 'proj-3', 'proj-4'];
  const projects = new ProjectService({
    projects: new SqliteProjectRepository(store), workspaces, workPaths, dataDir, homeDir: home, events,
    newId: () => ids.shift()!,
  });
  const dependencies = { projects };
  const proposals = new ProposalService({
    repository: new SqliteProposalRepository(store),
    workbenchEvents: events,
    kinds: [
      createProjectKind(dependencies),
      mountDirectoryKind(dependencies),
      unmountDirectoryKind(dependencies),
      setPrimaryDirectoryKind(dependencies),
      moveSessionToProjectKind({ sessions, workspaces: () => projects.listWorkspaces().workspaces }),
    ],
  });
  const turn: InternalToolTurn = { commandId: 'turn-1', windowId: 'window-a', view: null };
  const tools = new InternalToolService({
    tools: MULTIVAC_INTERNAL_TOOLS,
    // 与应用中相同：项目只给查询与只改名称 / 默认约束的方法，修改目录与新建项目只在提议种类中。
    services: {
      projects: {
        listWorkspaces: () => projects.listWorkspaces(),
        listProjects: () => projects.listProjects(),
        renameProject: (projectId, name, origin) => projects.renameProject(projectId, name, origin),
        setDefaultConstraints: (projectId, text, origin) => projects.setDefaultConstraints(projectId, text, origin),
      },
      sessions,
      transcripts: { readMessages: () => [] },
    } as never,
    calls: new SqliteInternalToolCallRepository(store),
    currentTurn: () => turn,
    proposals,
  });
  let calls = 0;
  const invoke = async (toolName: string, args: Record<string, unknown>, toolCallId = `call-${calls += 1}`) => {
    const outcome = await tools.invoke(
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
    assert.equal(outcome.ok, false, outcome.ok ? outcome.content : undefined);
    return (outcome as Failed).reason;
  };
  /** 提出并返回生成的那一张提议。 */
  const propose = async (toolName: string, args: Record<string, unknown>): Promise<{ outcome: Ok; proposal: Proposal }> => {
    const toolCallId = `call-${calls += 1}`;
    const outcome = await ok(toolName, args, toolCallId);
    const proposal = proposals.list(GLOBAL_ASSISTANT_SESSION_ID).find((item) => item.toolCallId === toolCallId);
    assert.ok(proposal, '应当生成提议');
    assert.equal(Check(ProposalSchema, proposal), true);
    return { outcome, proposal };
  };
  const decide = (proposalId: string, decision: 'confirm' | 'cancel', options?: unknown) =>
    proposals.decide(GLOBAL_ASSISTANT_SESSION_ID, proposalId, decision, { windowId: 'window-b', commandId: null }, options);
  const mkdir = (...parts: string[]) => {
    const path = join(code, ...parts);
    mkdirSync(path, { recursive: true });
    return path;
  };
  return {
    root, home, code, store, workPaths, sessions, projects, proposals, running, published,
    invoke, ok, failed, propose, decide, mkdir,
  };
}

test('新建项目：只生成与界面同一核对的确认卡，确认前什么都不建；确认后项目与同名工作区出现，回执带“切到工作区”“项目设置”', async () => {
  await withWorld(async ({ ok, failed, propose, decide, projects, workPaths, published, mkdir, code }) => {
    const target = mkdir('notes');

    // 挂载目录：卡上是规范化后的路径与类型；工具只说“已提出，等待你确认”，项目并没有创建。
    const mounted = await propose('propose_create_project', { name: '读书笔记', directory: `${target}/./` });
    assert.equal(mounted.outcome.result.summary, '已提出，等待你确认');
    assert.match(mounted.outcome.content, /等待用户在对话中的确认卡上确认；确认之前没有执行任何操作/u);
    assert.equal(mounted.proposal.title, '新建项目「读书笔记」');
    assert.deepEqual(mounted.proposal.preview, { name: '读书笔记', directory: { kind: 'mounted', path: target } });
    assert.equal(mounted.proposal.problem, null);
    assert.equal(Check(CreateProjectProposalPreviewSchema, mounted.proposal.preview), true);
    assert.equal(projects.listProjects().projects.length, 0);
    assert.equal(published.filter((event) => event.type === 'workspace.changed').length, 0);

    // 托管目录：卡上给出托管路径，确认前不创建目录。
    const managed = await propose('propose_create_project', { name: '周报' });
    const managedPath = join(workPaths.projectsDir, '周报');
    assert.deepEqual(managed.proposal.preview, { name: '周报', directory: { kind: 'managed', path: managedPath } });
    assert.equal(existsSync(managedPath), false);

    // 非法目录与名称：卡上写明服务端原因（与“新建项目…”同一句），不能确认。
    const problems = await Promise.all([
      propose('propose_create_project', { name: '甲', directory: join(code, 'missing') }),
      propose('propose_create_project', { name: '乙', directory: '/' }),
      propose('propose_create_project', { name: '丙', directory: 'relative/path' }),
      propose('propose_create_project', { name: '默认工作区' }),
    ]);
    assert.deepEqual(problems.map(({ proposal }) => proposal.problem), [
      `目录不存在：${join(code, 'missing')}`,
      '不能挂载根目录：它包含整台电脑的文件，请选择具体的项目目录。',
      '目录必须是绝对路径，例如 /Users/me/code 或 ~/code：relative/path',
      '“默认工作区”是保留名称，请换一个项目名称。',
    ]);
    assert.equal(problems[0]!.outcome.result.summary, '已提出，但目前不能执行');
    assert.match(problems[0]!.outcome.content, /但目前不能执行：目录不存在/u);
    assert.deepEqual(problems[0]!.proposal.preview, { name: '甲', directory: { kind: 'mounted', path: join(code, 'missing') } });

    // 确认：执行与界面相同的新建，工作区事件带上作出决定的窗口；回执有两个入口。
    const executed = await decide(mounted.proposal.proposalId, 'confirm');
    assert.equal(executed.status, 'executed');
    const project = projects.listProjects().projects[0]!;
    assert.deepEqual([project.name, project.directories], ['读书笔记', [{ kind: 'mounted', path: target }]]);
    assert.ok(projects.listWorkspaces().workspaces.some((workspace) => workspace.workspaceId === project.projectId && workspace.name === '读书笔记'));
    assert.deepEqual(executed.outcome, {
      summary: '已创建项目「读书笔记」',
      refs: [
        { kind: 'project', projectId: project.projectId, label: '读书笔记' },
        { kind: 'workspace', workspaceId: project.projectId, label: '读书笔记' },
      ],
      receipt: {
        headline: '已创建项目「读书笔记」',
        detail: `同名工作区已就绪；目录：挂载目录 ${target}，目录内的修改将自动执行`,
        actions: [
          { kind: 'open-workspace', workspaceId: project.projectId },
          { kind: 'open-project', projectId: project.projectId },
        ],
      },
    });
    const created = published.filter((event) => event.type === 'workspace.changed');
    assert.equal(created.length, 1);
    // 来源是作出决定的窗口与提出它的那一轮：作出决定的窗口也按事件写回新项目（决定接口只返回提议）。
    assert.deepEqual(created[0]!.origin, { windowId: 'window-b', commandId: 'turn-1' });

    // 重复确认幂等：原样返回，不再新建。
    assert.equal((await decide(mounted.proposal.proposalId, 'confirm')).status, 'executed');
    assert.equal(projects.listProjects().projects.length, 1);

    // 已是某个项目的目录（含其他写法）：不生成卡片，直接说明它在哪个项目里、不用重复创建。
    const reason = await failed('propose_create_project', { name: '重复', directory: `${target}/` });
    assert.match(reason, new RegExp(`已经是项目 \\[读书笔记\\]\\(multivac://project/${project.projectId}\\)（id: ${project.projectId}）的目录，不用重复创建`, 'u'));

    // 不合法的卡不能靠确认执行：重新校验不通过即过期（界面上确认按钮本就不可用）。
    const invalid = await decide(problems[0]!.proposal.proposalId, 'confirm');
    assert.deepEqual([invalid.status, invalid.reason], ['expired', `目录不存在：${join(code, 'missing')}`]);

    // 目标已变化：托管目录的位置在提出之后被占用（重名序号变化），确认时过期、什么都不建。
    mkdirSync(managedPath, { recursive: true });
    const moved = await decide(managed.proposal.proposalId, 'confirm');
    assert.equal(moved.status, 'expired');
    assert.equal(moved.reason, `将使用的目录已变为 项目托管目录 ${managedPath}-2（卡上是 ${managedPath}）。`);
    assert.equal(projects.listProjects().projects.length, 1);
    assert.equal(existsSync(`${managedPath}-2`), false);

    // 没有卡上选项的种类不接受选项。
    const another = await propose('propose_create_project', { name: '另一个' });
    await assert.rejects(decide(another.proposal.proposalId, 'confirm', { moveFiles: true }),
      (error: unknown) => error instanceof ProposalServiceError && error.code === 'INVALID_REQUEST');
    assert.equal(projects.listProjects().projects.length, 1);

    // 名称在提出之后被别的项目占用：过期。
    await ok('rename_project', { projectId: project.projectId, name: '另一个' });
    const taken = await decide(another.proposal.proposalId, 'confirm');
    assert.deepEqual([taken.status, taken.reason], ['expired', '已有同名项目「另一个」，请换一个名称。']);
  });
});

test('挂载 / 卸载 / 设主目录：与设置 · 项目同一套校验与说明；未确认不改目录；确认时目录已被别处挂载、主目录已变化即过期', async () => {
  await withWorld(async ({ failed, propose, decide, projects, mkdir, code }) => {
    const first = mkdir('app');
    const second = mkdir('docs');
    const third = mkdir('design');
    const project = projects.createProject({ name: '应用', directory: first }).project;
    const other = projects.createProject({ name: '别的', directory: mkdir('other') }).project;
    const directoriesOf = (projectId = project.projectId) => projects.getProject(projectId).directories.map((item) => item.path);

    // 对象不存在：工具失败，不生成卡片。
    assert.match(await failed('propose_mount_directory', { projectId: 'nope', directory: second }),
      /没有提出挂载目录：没有 id 为 nope 的项目。可以先用 list_projects 查看项目 id。/u);
    assert.match(await failed('propose_unmount_directory', { projectId: project.projectId, directory: second }),
      new RegExp(`没有提出卸载目录：项目「应用」中没有目录 ${second}。它现在的目录：${first}。`, 'u'));
    assert.match(await failed('propose_set_primary_directory', { projectId: project.projectId, directory: 'docs' }),
      /没有提出设主目录：目录必须是绝对路径/u);

    // 挂载：卡片写明将挂载的目录；非法目录（与设置页同一句原因）不能确认。
    const mount = await propose('propose_mount_directory', { projectId: project.projectId, directory: `${second}/` });
    assert.equal(mount.proposal.title, `把 ${second}/ 挂载到项目「应用」`);
    assert.deepEqual(mount.proposal.preview, { projectName: '应用', directory: { kind: 'mounted', path: second } });
    const invalidMounts = await Promise.all([
      propose('propose_mount_directory', { projectId: project.projectId, directory: first }),
      propose('propose_mount_directory', { projectId: project.projectId, directory: join(other.directories[0]!.path) }),
      propose('propose_mount_directory', { projectId: project.projectId, directory: join(code, 'missing') }),
    ]);
    assert.deepEqual(invalidMounts.map(({ proposal }) => proposal.problem), [
      `同一个目录不能出现两次：${first}`,
      `这个目录已属于项目「别的」：${other.directories[0]!.path}`,
      `目录不存在：${join(code, 'missing')}`,
    ]);
    // 只剩一个目录不能卸载；已经是主目录不必再设。
    const onlyOne = await propose('propose_unmount_directory', { projectId: project.projectId, directory: first });
    assert.equal(onlyOne.proposal.problem, '项目至少保留一个目录；要换目录，先挂载新目录再卸载这个。');
    const alreadyPrimary = await propose('propose_set_primary_directory', { projectId: project.projectId, directory: first });
    assert.equal(alreadyPrimary.proposal.problem, '它已经是项目「应用」的主目录。');
    assert.deepEqual(directoriesOf(), [first]);

    // 确认挂载：目录排在最后；回执打开项目设置。
    const mounted = await decide(mount.proposal.proposalId, 'confirm');
    assert.equal(mounted.status, 'executed');
    assert.deepEqual(directoriesOf(), [first, second]);
    assert.deepEqual(mounted.outcome?.receipt?.actions, [{ kind: 'open-project', projectId: project.projectId }]);
    assert.match(mounted.outcome!.receipt!.detail, /目录内的修改将自动执行。修改目录只影响之后新建的会话/u);

    // 目录在提出之后被别的项目挂载：确认时过期，不挂载。
    const late = await propose('propose_mount_directory', { projectId: project.projectId, directory: third });
    projects.updateProject(other.projectId, { directories: [...directoriesOf(other.projectId), third] });
    const expired = await decide(late.proposal.proposalId, 'confirm');
    assert.deepEqual([expired.status, expired.reason], ['expired', `这个目录已属于项目「别的」：${third}`]);
    assert.deepEqual(directoriesOf(), [first, second]);

    // 设主目录：主目录在提出之后换过即过期；按当前状态再提一次后确认。
    const setPrimary = await propose('propose_set_primary_directory', { projectId: project.projectId, directory: second });
    assert.deepEqual(setPrimary.proposal.preview, {
      projectName: '应用', directory: { kind: 'mounted', path: second }, previousPrimary: { kind: 'mounted', path: first },
    });
    const unmountPrimary = await propose('propose_unmount_directory', { projectId: project.projectId, directory: first });
    assert.deepEqual(unmountPrimary.proposal.preview, {
      projectName: '应用', directory: { kind: 'mounted', path: first }, primary: true,
      nextPrimary: { kind: 'mounted', path: second },
    });
    const primary = await decide(setPrimary.proposal.proposalId, 'confirm');
    assert.equal(primary.status, 'executed');
    assert.deepEqual(directoriesOf(), [second, first]);
    assert.equal(primary.outcome?.receipt?.headline, `「应用」的主目录已改为 ${second}`);
    // 卸载卡是按“它是主目录”提出的：确认时它已不是主目录，过期。
    const stale = await decide(unmountPrimary.proposal.proposalId, 'confirm');
    assert.deepEqual([stale.status, stale.reason], ['expired', '它已经不是主目录了。']);
    assert.deepEqual(directoriesOf(), [second, first]);

    // 卸载：只解除关系，目录本身不删除。
    const unmount = await propose('propose_unmount_directory', { projectId: project.projectId, directory: first });
    const unmounted = await decide(unmount.proposal.proposalId, 'confirm');
    assert.equal(unmounted.status, 'executed');
    assert.deepEqual(directoriesOf(), [second]);
    assert.equal(existsSync(first), true);
    assert.match(unmounted.outcome!.receipt!.detail, /目录本身和其中的文件没有删除/u);
  });
});

test('归入项目：卡片内容与界面归入卡同一份核对；文件是否移入只取用户在卡上的选择；运行中、已归档、文件变化与目录变化都不执行', async () => {
  await withWorld(async ({ failed, propose, decide, projects, proposals, sessions, running, mkdir }) => {
    const project = projects.createProject({ name: '研究', directory: mkdir('research') }).project;
    const projectDir = project.directories[0]!.path;
    writeFileSync(join(projectDir, 'README.md'), '项目自己的文件');
    const { session } = await sessions.create({ sessionId: 'work-a', title: '接口调研' });
    const temp = session.workingDirectory.path;
    writeFileSync(join(temp, 'notes.md'), '笔记');
    writeFileSync(join(temp, 'README.md'), '临时目录里的同名文件');
    const place = () => sessions.get('work-a').workspaceId;

    // 对象不存在、已在项目中、已归档：工具失败，不生成卡片。
    assert.match(await failed('propose_move_session_to_project', { sessionId: 'nope', projectId: project.projectId }),
      /没有提出归入项目：没有 id 为 nope 的会话/u);
    assert.match(await failed('propose_move_session_to_project', { sessionId: 'work-a', projectId: 'nope' }),
      /没有提出归入项目：没有 id 为 nope 的项目/u);
    assert.match(await failed('propose_move_session_to_project', { sessionId: GLOBAL_ASSISTANT_SESSION_ID, projectId: project.projectId }),
      /没有提出归入项目：.*只有工作会话可以归入项目/u);

    // 卡片内容：目录从哪里换到哪里、提出时的运行状态、临时目录的条目与同名条目（与界面归入卡同一份核对）。
    const { proposal } = await propose('propose_move_session_to_project', {
      sessionId: 'work-a', projectId: project.projectId, moveFiles: false,
    });
    assert.equal(proposal.title, '把「接口调研」归入项目「研究」');
    assert.equal(Check(MoveSessionToProjectProposalPreviewSchema, proposal.preview), true);
    assert.deepEqual(proposal.preview, {
      sessionTitle: '接口调研', projectName: '研究', fromWorkspaceId: 'default', fromWorkspaceName: '默认工作区', fromProject: false,
      move: sessions.previewMoveToProject('work-a', project.projectId),
    });
    assert.equal(place(), 'default');

    // 卡上的选择必须由用户给出：不带选择、带不合规的选择都拒绝，提议仍待确认。
    for (const options of [undefined, {}, { moveFiles: 'yes' }, { moveFiles: true, extra: 1 }]) {
      await assert.rejects(decide(proposal.proposalId, 'confirm', options),
        (error: unknown) => error instanceof ProposalServiceError && error.code === 'INVALID_REQUEST');
    }
    const statusOf = (proposalId: string) =>
      proposals.list(GLOBAL_ASSISTANT_SESSION_ID).find((item) => item.proposalId === proposalId)?.status;
    assert.equal(statusOf(proposal.proposalId), 'pending');

    // 运行中（含等待授权）：确认时过期，写明先停止，什么都不改。
    running.add('work-a');
    const busy = await decide(proposal.proposalId, 'confirm', { moveFiles: true });
    assert.deepEqual([busy.status, busy.reason], ['expired', '会话正在运行（或在等待授权），请先停止这一轮，再归入项目。']);
    assert.equal(place(), 'default');
    running.delete('work-a');

    // 临时目录里的文件在提出之后变了：选择移入时过期，不会移入卡上没有列出的文件。
    const again = await propose('propose_move_session_to_project', { sessionId: 'work-a', projectId: project.projectId });
    writeFileSync(join(temp, 'later.md'), '提出之后写下的');
    const changed = await decide(again.proposal.proposalId, 'confirm', { moveFiles: true });
    assert.equal(changed.status, 'expired');
    assert.match(changed.reason!, /临时目录里的文件在提出之后有变化（现在 3 项），为避免移入卡上没有列出的文件，没有执行/u);
    assert.equal(existsSync(join(projectDir, 'later.md')), false);

    // 模型建议不移入（moveFiles: false），用户在卡上勾选移入：按用户的选择，同名的不覆盖、留在原处。
    const third = await propose('propose_move_session_to_project', {
      sessionId: 'work-a', projectId: project.projectId, moveFiles: false,
    });
    const moved = await decide(third.proposal.proposalId, 'confirm', { moveFiles: true });
    assert.equal(moved.status, 'executed', moved.reason ?? undefined);
    assert.equal(place(), project.projectId);
    assert.equal(sessions.get('work-a').workingDirectory.path, projectDir);
    assert.deepEqual(readdirSync(projectDir).sort(), ['README.md', 'later.md', 'notes.md']);
    assert.equal(readFileSync(join(projectDir, 'README.md'), 'utf8'), '项目自己的文件');
    assert.deepEqual(readdirSync(temp), ['README.md']);
    assert.equal(moved.outcome?.receipt?.headline, '已把「接口调研」归入「研究」');
    assert.match(moved.outcome!.receipt!.detail, /2 项已移入项目目录；1 项与项目目录中已有的同名或没能移动，留在原临时目录/u);
    assert.deepEqual(moved.outcome?.receipt?.actions, [{ kind: 'open-session', sessionId: 'work-a' }]);

    // 同一会话再提一次（已在项目中）：工具失败；此前那张过期的卡再确认也不执行。
    assert.match(await failed('propose_move_session_to_project', { sessionId: 'work-a', projectId: project.projectId }),
      /没有提出归入项目：会话已在这个项目中。/u);
    assert.equal((await decide(again.proposal.proposalId, 'confirm', { moveFiles: true })).status, 'expired');

    // 不移入：文件留在原临时目录；同一会话的另一张卡在它归入之后再确认，目标已变化、过期。
    const { session: other } = await sessions.create({ sessionId: 'work-b', title: '草稿' });
    writeFileSync(join(other.workingDirectory.path, 'draft.md'), '草稿');
    const keep = await propose('propose_move_session_to_project', { sessionId: 'work-b', projectId: project.projectId });
    const duplicate = await propose('propose_move_session_to_project', { sessionId: 'work-b', projectId: project.projectId });
    const kept = await decide(keep.proposal.proposalId, 'confirm', { moveFiles: false });
    assert.equal(kept.status, 'executed');
    assert.equal(existsSync(join(other.workingDirectory.path, 'draft.md')), true);
    assert.equal(existsSync(join(projectDir, 'draft.md')), false);
    assert.match(kept.outcome!.receipt!.detail, /临时目录里的文件留在原处/u);
    const late = await decide(duplicate.proposal.proposalId, 'confirm', { moveFiles: false });
    assert.deepEqual([late.status, late.reason], ['expired', '会话「草稿」已不在「默认工作区」中（提出之后被移动过）。']);

    // 提出之后会话被归档：过期，不恢复也不归入。
    await sessions.create({ sessionId: 'work-c', title: '旧会话' });
    const archivedCard = await propose('propose_move_session_to_project', { sessionId: 'work-c', projectId: project.projectId });
    sessions.archive('work-c');
    const archived = await decide(archivedCard.proposal.proposalId, 'confirm', { moveFiles: true });
    assert.deepEqual([archived.status, archived.reason], ['expired', '会话「旧会话」已归档。']);
    assert.equal(sessions.get('work-c').workspaceId, 'default');
    assert.match(await failed('propose_move_session_to_project', { sessionId: 'work-c', projectId: project.projectId }),
      /会话「旧会话」已归档，已归档的会话不能归入项目/u);
  });
});

test('项目改名与默认约束：直接执行、同名工作区随之改名、回执带“项目设置”；默认约束如实说明还不会自动带入会话', async () => {
  await withWorld(async ({ ok, failed, projects, published, mkdir }) => {
    const project = projects.createProject({ name: '应用', directory: mkdir('app') }).project;
    projects.createProject({ name: '别的' });
    published.length = 0;

    const renamed = await ok('rename_project', { projectId: project.projectId, name: '  新应用 ' });
    assert.equal(projects.getProject(project.projectId).name, '新应用');
    assert.ok(projects.listWorkspaces().workspaces.some((workspace) => workspace.workspaceId === project.projectId && workspace.name === '新应用'));
    assert.deepEqual(renamed.result.receipt, {
      headline: '已把项目改名为「新应用」',
      detail: '原名「应用」；同名工作区随之改名',
      actions: [{ kind: 'open-project', projectId: project.projectId }],
    });
    assert.deepEqual(published.map((event) => event.type === 'workspace.changed' ? event.origin : null),
      [{ windowId: 'window-a', commandId: 'turn-1' }]);

    // 同名：没有改动、没有回执；重名、保留名：以服务端原因失败。
    const same = await ok('rename_project', { projectId: project.projectId, name: '新应用' });
    assert.equal(same.result.receipt, undefined);
    assert.match(await failed('rename_project', { projectId: project.projectId, name: '别的' }), /没有项目改名：已有同名项目「别的」/u);
    assert.match(await failed('rename_project', { projectId: 'nope', name: 'x' }), /没有 id 为 nope 的项目/u);

    const constraints = await ok('update_project_constraints', { projectId: project.projectId, defaultConstraints: ' 只改 docs/ ' });
    assert.equal(projects.getProject(project.projectId).defaultConstraints, '只改 docs/');
    assert.match(constraints.content, /默认约束目前只保存在项目中，还不会自动带入会话/u);
    assert.deepEqual(constraints.result.receipt, {
      headline: '已更新「新应用」的默认约束',
      detail: '默认约束目前只保存在项目中，还不会自动带入会话。',
      actions: [{ kind: 'open-project', projectId: project.projectId }],
    });
    const cleared = await ok('update_project_constraints', { projectId: project.projectId, defaultConstraints: '' });
    assert.equal(cleared.result.receipt?.headline, '已清空「新应用」的默认约束');
    assert.equal((await ok('update_project_constraints', { projectId: project.projectId, defaultConstraints: '' })).result.receipt, undefined);

    // 管理类工具碰不到目录：参数中多给目录一律拒绝，目录不变。
    assert.match(await failed('rename_project', { projectId: project.projectId, name: 'x', directories: ['/'] }), /调用没有执行/u);
    assert.deepEqual(projects.getProject(project.projectId).directories.length, 1);
  });
});
