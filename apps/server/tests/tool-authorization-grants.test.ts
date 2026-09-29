import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  GLOBAL_ASSISTANT_SESSION_ID,
  type AssistantPublicEvent,
  type ToolAuthorizationGrant,
  type ToolAuthorizationRequest,
} from '@multivac/contracts';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import {
  ToolAuthorizationService,
  ToolAuthorizationServiceError,
} from '../src/application/tool-authorization-service.js';
import {
  grantCovers,
  rememberableDirectory,
  rememberGuard,
  type ToolAuthorizationGrantQuery,
} from '../src/modules/tool-authorization/tool-authorization.js';
import type {
  CoordinatorToolAuthorizationDecision,
  CoordinatorToolAuthorizationRequest,
} from '../src/runtime/executors/coordinator-adapter.js';
import { judgeToolCall } from '../src/runtime/executors/pi-tool-boundary.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantStore,
  SqliteProjectRepository,
  SqliteSessionRegistryRepository,
  SqliteToolAuthorizationRepository,
} from '../src/storage/sqlite-assistant-store.js';

/**
 * 记住的授权：可记住范围的计算、匹配规则（子路径、同前缀兄弟目录、符号链接与 `..`、读与写、会话与项目），
 * 以及授权服务中的记住、自动放行、撤销与重启后仍然有效。
 */

const SESSION = 'work-a';
const SIBLING = 'work-b';
const OTHER = 'work-other';

function grant(overrides: Partial<ToolAuthorizationGrant> = {}): ToolAuthorizationGrant {
  return {
    grantId: 'grant-1',
    scope: 'session',
    sessionId: SESSION,
    projectId: null,
    access: 'write',
    directory: '/data/reports',
    sourceRequestId: 'request-1',
    createdAt: '2026-09-28T08:00:00.000Z',
    lastUsedAt: null,
    useCount: 0,
    revokedAt: null,
    ...overrides,
  };
}

function query(overrides: Partial<ToolAuthorizationGrantQuery> = {}): ToolAuthorizationGrantQuery {
  return { sessionId: SESSION, projectId: null, access: 'write', targetPath: '/data/reports/q3.md', ...overrides };
}

test('匹配规则：放行目录含子路径但不含同前缀的兄弟目录与上级；读与写分开；会话与项目范围各自归属；撤销即不匹配', () => {
  // 子路径：目录本身、直接子项与深层子项。
  assert.equal(grantCovers(grant(), query()), true);
  assert.equal(grantCovers(grant(), query({ targetPath: '/data/reports' })), true);
  assert.equal(grantCovers(grant(), query({ targetPath: '/data/reports/2026/q3/draft.md' })), true);
  // 同前缀的兄弟目录、上级与根外路径都不算。
  assert.equal(grantCovers(grant(), query({ targetPath: '/data/reports-old/q3.md' })), false);
  assert.equal(grantCovers(grant(), query({ targetPath: '/data/reportsx' })), false);
  assert.equal(grantCovers(grant(), query({ targetPath: '/data/other.md' })), false);
  assert.equal(grantCovers(grant(), query({ targetPath: '/data' })), false);

  // 读与写互不包含：记住修改不放开读取，记住读取也不放开修改。
  assert.equal(grantCovers(grant(), query({ access: 'read' })), false);
  assert.equal(grantCovers(grant({ access: 'read' }), query({ access: 'read' })), true);
  assert.equal(grantCovers(grant({ access: 'read' }), query()), false);

  // 会话范围只属于那个会话，即使另一个会话在同一个项目里。
  assert.equal(grantCovers(grant(), query({ sessionId: SIBLING, projectId: 'project-a' })), false);
  // 项目范围作用于项目中的全部会话；不属于项目或属于其他项目的会话不匹配。
  const projectGrant = grant({ scope: 'project', sessionId: null, projectId: 'project-a' });
  assert.equal(grantCovers(projectGrant, query({ sessionId: SIBLING, projectId: 'project-a' })), true);
  assert.equal(grantCovers(projectGrant, query({ sessionId: SESSION, projectId: null })), false);
  assert.equal(grantCovers(projectGrant, query({ sessionId: OTHER, projectId: 'project-b' })), false);

  // 撤销后不再匹配。
  assert.equal(grantCovers(grant({ revokedAt: '2026-09-28T09:00:00.000Z' }), query()), false);
});

test('可记住的范围：目标所在目录；根目录、用户主目录及其上级、工作文件根目录、内部数据目录都不能记住', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'multivac-remember-')));
  try {
    const home = join(root, 'home');
    const workRoot = join(root, 'work');
    const dataDir = join(home, '.multivac');
    await mkdir(dataDir, { recursive: true });
    await mkdir(workRoot);
    // 主目录经符号链接给出时，真实路径同样受保护。
    await symlink(home, join(root, 'home-link'));
    const guard = rememberGuard({ homeDir: join(root, 'home-link'), workRoot, dataDir });

    assert.equal(rememberableDirectory(join(home, 'code', 'app', 'main.ts'), guard), join(home, 'code', 'app'));
    assert.equal(rememberableDirectory(join(workRoot, 'sessions', 'other', 'note.md'), guard), join(workRoot, 'sessions', 'other'));
    assert.equal(rememberableDirectory('/etc.txt', guard), null, '文件系统根目录');
    assert.equal(rememberableDirectory(join(home, 'secret.txt'), guard), null, '用户主目录本身');
    assert.equal(rememberableDirectory(join(root, 'notes.txt'), guard), null, '包含主目录与工作文件根目录的上级');
    assert.equal(rememberableDirectory(join(workRoot, 'x.txt'), guard), null, '工作文件根目录本身');
    assert.equal(rememberableDirectory(join(dataDir, 'multivac.sqlite'), guard), null, '内部数据目录本身');
    assert.equal(rememberableDirectory(join(dataDir, 'pi', 'auth.json'), guard), null, '内部数据目录之中');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

interface Harness {
  root: string;
  outside: string;
  store: SqliteAssistantStore;
  events: AssistantPublicEvent[];
  /** 会话当前所属的项目，测试中可以改动。 */
  membership: Map<string, string>;
  service: () => ToolAuthorizationService;
  /** 在同一数据目录上关闭并重新打开存储（模拟服务重启）。 */
  reopen: () => void;
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'multivac-grants-')));
  const outside = join(root, 'outside');
  await mkdir(join(outside, 'reports'), { recursive: true });
  const databasePath = join(root, 'multivac.sqlite');
  const eventStream = new AssistantEventStream();
  const events: AssistantPublicEvent[] = [];
  eventStream.subscribe((event) => events.push(event));
  const membership = new Map([[SESSION, 'project-a'], [SIBLING, 'project-a'], [OTHER, 'project-b']]);
  const services: ToolAuthorizationService[] = [];

  let store = new SqliteAssistantStore(databasePath);
  const projects = new SqliteProjectRepository(store);
  for (const projectId of ['project-a', 'project-b']) {
    projects.create({
      projectId, name: projectId, directories: [{ kind: 'managed', path: join(root, 'work', 'projects', projectId) }],
      defaultConstraints: '', createdAt: '2026-09-28T07:00:00.000Z',
    });
  }
  const registry = new SqliteSessionRegistryRepository(store);
  const bindings = new SqliteAssistantBindingRepository(store);
  registry.insertIfAbsent({
    sessionId: GLOBAL_ASSISTANT_SESSION_ID, title: 'Multivac', kind: 'coordinator', workspaceId: 'default',
    createdAt: '2026-09-28T07:00:00.000Z', workingDirectory: { kind: 'multivac', path: join(root, 'work', 'multivac') },
  });
  bindings.insertIfAbsent({
    assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, piSessionId: 'pi-global', piSessionPath: '/pi/global.jsonl',
    updatedAt: '2026-09-28T07:00:00.000Z',
  });
  for (const sessionId of [SESSION, SIBLING, OTHER]) {
    registry.insertIfAbsent({
      sessionId, title: sessionId, kind: 'work', workspaceId: membership.get(sessionId)!,
      createdAt: '2026-09-28T07:00:00.000Z',
      workingDirectory: { kind: 'project-managed', path: join(root, 'work', 'projects', membership.get(sessionId)!) },
    });
    bindings.insertIfAbsent({
      assistantSessionId: sessionId, piSessionId: `pi-${sessionId}`, piSessionPath: `/pi/${sessionId}.jsonl`,
      updatedAt: '2026-09-28T07:00:00.000Z',
    });
  }

  const harness: Harness = {
    root,
    outside,
    get store() { return store; },
    events,
    membership,
    service: () => {
      const created = new ToolAuthorizationService({
        repository: new SqliteToolAuthorizationRepository(store),
        eventStream,
        currentCommandId: () => null,
        projectOf: (sessionId) => membership.get(sessionId) ?? null,
        rememberBoundary: { homeDir: join(root, 'home'), workRoot: join(root, 'work'), dataDir: join(root, 'data') },
      });
      services.push(created);
      return created;
    },
    reopen: () => {
      for (const service of services.splice(0)) service.dispose();
      store.close();
      store = new SqliteAssistantStore(databasePath);
    },
  };
  try {
    await run(harness);
  } finally {
    for (const service of services) service.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function access(
  sessionId: string,
  toolName: 'read' | 'edit' | 'write',
  targetPath: string,
  toolCallId = `call-${Math.random().toString(36).slice(2)}`,
): CoordinatorToolAuthorizationRequest {
  return {
    assistantSessionId: sessionId,
    toolName,
    toolCallId,
    requestedPath: targetPath,
    targetPath,
    workingDirectory: { kind: 'project-managed', path: '/work/projects/a' },
  };
}

/** 发起一次越界访问：命中记住的授权时立即返回 allowed；否则返回仍在等待的请求。 */
async function attempt(
  service: ToolAuthorizationService,
  request: CoordinatorToolAuthorizationRequest,
): Promise<{ decision?: CoordinatorToolAuthorizationDecision; pending?: ToolAuthorizationRequest; waiting: Promise<CoordinatorToolAuthorizationDecision> }> {
  const waiting = service.authorize(request, new AbortController().signal);
  const latest = service.list(request.assistantSessionId).at(-1);
  if (latest?.toolCallId === request.toolCallId && latest.status === 'pending') return { pending: latest, waiting };
  return { decision: await waiting, waiting };
}

function assertServiceError(code: ToolAuthorizationServiceError['code'], pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof ToolAuthorizationServiceError);
    assert.equal(error.code, code);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
}

test('本会话内允许：记住卡片上写明的目录，同一会话之后的同类访问直接放行并留痕；读取、其他会话仍需确认；撤销后再次确认', async () => {
  await withHarness(async ({ outside, events, service: create }) => {
    const service = create();
    const reports = join(outside, 'reports');

    const first = await attempt(service, access(SESSION, 'write', join(reports, 'q3.md')));
    assert.deepEqual(first.pending?.remember, { directory: reports, projectId: 'project-a' });
    const approved = service.decide(SESSION, first.pending!.requestId, 'session');
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approval?.scope, 'session');
    assert.equal(approved.approval?.source, 'user');
    assert.deepEqual(await first.waiting, { allowed: true });

    const [remembered] = service.listGrants();
    assert.deepEqual({ ...remembered, grantId: typeof remembered?.grantId, createdAt: typeof remembered?.createdAt }, {
      grantId: 'string', scope: 'session', sessionId: SESSION, projectId: null, access: 'write',
      directory: reports, sourceRequestId: first.pending!.requestId, createdAt: 'string',
      lastUsedAt: null, useCount: 0, revokedAt: null,
    });
    assert.equal(approved.approval?.grantId, remembered!.grantId);
    // 同一决定幂等；改为其他决定报冲突。
    assert.deepEqual(service.decide(SESSION, first.pending!.requestId, 'session'), approved);
    assert.throws(() => service.decide(SESSION, first.pending!.requestId, 'once'), assertServiceError('AUTHORIZATION_CONFLICT', /本会话内/u));

    // 同一会话：子目录中的编辑与写入都直接放行，不经过待授权，只留下一条按记住的授权放行的记录。
    events.length = 0;
    const edit = await attempt(service, access(SESSION, 'edit', join(reports, '2026', 'q4.md'), 'call-auto'));
    assert.deepEqual(edit.decision, { allowed: true });
    const auto = service.list(SESSION).at(-1)!;
    assert.equal(auto.toolCallId, 'call-auto');
    assert.equal(auto.status, 'approved');
    assert.deepEqual(auto.approval, { scope: 'session', source: 'grant', grantId: remembered!.grantId });
    assert.equal(auto.remember, null);
    assert.deepEqual(events.map((event) => event.type), ['assistant.authorization.resolved']);
    const used = service.listGrants()[0]!;
    assert.equal(used.useCount, 1);
    assert.equal(used.lastUsedAt, auto.createdAt);
    // 自动放行的记录不能再作决定。
    assert.throws(() => service.decide(SESSION, auto.requestId, 'deny'), assertServiceError('AUTHORIZATION_CONFLICT', /按已记住的授权放行/u));

    // 读取与修改分开；同前缀的兄弟目录不在范围内；其他会话（即使同一项目）不适用。
    assert.ok((await attempt(service, access(SESSION, 'read', join(reports, 'q3.md')))).pending);
    assert.ok((await attempt(service, access(SESSION, 'write', join(outside, 'reports-old', 'q3.md')))).pending);
    assert.ok((await attempt(service, access(SIBLING, 'write', join(reports, 'q3.md')))).pending);

    // 撤销即时生效：之后的同类访问重新产生待授权请求；重复撤销返回同一条记录。
    const revoked = service.revokeGrant(remembered!.grantId);
    assert.notEqual(revoked.revokedAt, null);
    assert.deepEqual(service.revokeGrant(remembered!.grantId), revoked);
    assert.deepEqual(service.listGrants(), []);
    assert.throws(() => service.revokeGrant('missing'), assertServiceError('NOT_FOUND'));
    const again = await attempt(service, access(SESSION, 'write', join(reports, 'q3.md')));
    assert.equal(again.pending?.status, 'pending');
    // 按已撤销授权放行过的记录保留原样，便于追溯。
    assert.equal(service.list(SESSION).find((item) => item.toolCallId === 'call-auto')?.approval?.grantId, remembered!.grantId);
  });
});

test('本项目内始终允许：作用于同一项目的其他会话；其他项目、移出项目后不适用；同一范围不重复记住', async () => {
  await withHarness(async ({ outside, membership, service: create }) => {
    const service = create();
    const reports = join(outside, 'reports');

    // 同一项目的两个会话各有一张待授权的卡，都选“本项目内”：只记住一条。
    const first = await attempt(service, access(SESSION, 'read', join(reports, 'q3.md')));
    const second = await attempt(service, access(SIBLING, 'read', join(reports, 'q4.md')));
    service.decide(SESSION, first.pending!.requestId, 'project');
    service.decide(SIBLING, second.pending!.requestId, 'project');
    const grants = service.listGrants();
    assert.equal(grants.length, 1);
    const [projectGrant] = grants;
    assert.equal(projectGrant?.scope, 'project');
    assert.equal(projectGrant?.projectId, 'project-a');
    assert.equal(projectGrant?.sessionId, null);
    assert.equal(projectGrant?.access, 'read');
    assert.equal(service.list(SIBLING).at(-1)?.approval?.grantId, projectGrant!.grantId);

    const sibling = await attempt(service, access(SIBLING, 'read', join(reports, 'deep', 'notes.md')));
    assert.deepEqual(sibling.decision, { allowed: true });
    assert.deepEqual(service.list(SIBLING).at(-1)?.approval, { scope: 'project', source: 'grant', grantId: projectGrant!.grantId });
    // 其他项目的会话、类别不同的访问仍需确认。
    assert.ok((await attempt(service, access(OTHER, 'read', join(reports, 'q3.md')))).pending);
    assert.ok((await attempt(service, access(SIBLING, 'write', join(reports, 'q3.md')))).pending);
    // 按会话当前所在的项目匹配：移出项目后不再适用。
    membership.delete(SIBLING);
    assert.ok((await attempt(service, access(SIBLING, 'read', join(reports, 'q3.md')))).pending);

    // 决定按请求创建时记下的项目：之后会话换了项目，记住的仍是请求所在的项目。
    const other = await attempt(service, access(OTHER, 'read', join(outside, 'shared', 'x.md')));
    assert.equal(other.pending?.remember?.projectId, 'project-b');
    membership.set(OTHER, 'project-a');
    service.decide(OTHER, other.pending!.requestId, 'project');
    assert.deepEqual(service.listGrants().map((item) => item.projectId).sort(), ['project-a', 'project-b']);
    assert.ok((await attempt(service, access(OTHER, 'read', join(outside, 'shared', 'y.md')))).pending);
    membership.set(OTHER, 'project-b');
    assert.deepEqual((await attempt(service, access(OTHER, 'read', join(outside, 'shared', 'y.md')))).decision, { allowed: true });
  });
});

test('不能扩大的决定：会话不属于项目时不能选本项目内，目标所在目录范围过大时只能单次批准', async () => {
  await withHarness(async ({ root, membership, service: create }) => {
    const service = create();
    membership.delete(SESSION);
    const noProject = await attempt(service, access(SESSION, 'write', join(root, 'outside', 'reports', 'a.md')));
    assert.equal(noProject.pending?.remember?.projectId, null);
    assert.throws(() => service.decide(SESSION, noProject.pending!.requestId, 'project'),
      assertServiceError('INVALID_DECISION', /不属于项目/u));
    assert.equal(service.list(SESSION).at(-1)?.status, 'pending', '无效的决定不改变请求');

    // 目标直接位于用户主目录中：放行目录就是主目录，不提供记住。
    const broad = await attempt(service, access(SESSION, 'read', join(root, 'home', 'secret.txt')));
    assert.equal(broad.pending?.remember, null);
    assert.throws(() => service.decide(SESSION, broad.pending!.requestId, 'session'),
      assertServiceError('INVALID_DECISION', /范围过大/u));
    assert.equal(service.decide(SESSION, broad.pending!.requestId, 'once').approval?.scope, 'once');
    assert.deepEqual(service.listGrants(), []);
  });
});

test('全局 Multivac 不记住授权：没有可记住的范围、不接受记住的决定；过去记住的会话范围授权不再匹配、不再列出', async () => {
  await withHarness(async ({ outside, store, service: create }) => {
    const service = create();
    const reports = join(outside, 'reports');

    const pending = await attempt(service, access(GLOBAL_ASSISTANT_SESSION_ID, 'write', join(reports, 'a.md')));
    assert.equal(pending.pending?.remember, null);
    assert.throws(() => service.decide(GLOBAL_ASSISTANT_SESSION_ID, pending.pending!.requestId, 'session'),
      assertServiceError('INVALID_DECISION', /Multivac 的对话不记住授权/u));
    assert.equal(service.list(GLOBAL_ASSISTANT_SESSION_ID).at(-1)?.status, 'pending', '无效的决定不改变请求');
    assert.equal(service.decide(GLOBAL_ASSISTANT_SESSION_ID, pending.pending!.requestId, 'once').approval?.scope, 'once');
    assert.deepEqual(service.listGrants(), []);

    // 旧版本为全局 Multivac 记住的会话范围授权：仍在库中，但不再放行，也不再列出。
    const repository = new SqliteToolAuthorizationRepository(store);
    const legacy = repository.create({
      requestId: 'legacy-request', sessionId: GLOBAL_ASSISTANT_SESSION_ID, commandId: null, toolName: 'write',
      toolCallId: 'legacy-call', requestedPath: join(reports, 'old.md'), targetPath: join(reports, 'old.md'),
      workingDirectory: { kind: 'multivac', path: '/work/multivac' }, createdAt: '2026-09-28T07:30:00.000Z',
      expiresAt: '2026-09-28T08:00:00.000Z', remember: { directory: reports, projectId: null },
    }).request;
    repository.resolve(legacy.requestId, 'approved', '2026-09-28T07:31:00.000Z', {
      scope: 'session',
      grant: {
        grantId: 'legacy-grant', scope: 'session', sessionId: GLOBAL_ASSISTANT_SESSION_ID, projectId: null,
        access: 'write', directory: reports, sourceRequestId: legacy.requestId, createdAt: '2026-09-28T07:31:00.000Z',
      },
    });
    assert.equal(repository.listGrants().length, 1);
    assert.deepEqual(service.listGrants(), []);
    const again = await attempt(service, access(GLOBAL_ASSISTANT_SESSION_ID, 'write', join(reports, 'b.md')));
    assert.equal(again.pending?.status, 'pending');
    assert.equal(again.pending?.remember, null);

    // 工作会话照常可以记住。
    const work = await attempt(service, access(SESSION, 'write', join(reports, 'c.md')));
    assert.deepEqual(work.pending?.remember, { directory: reports, projectId: 'project-a' });
  });
});

test('按会话查询最近的授权请求：只含这个会话的，最近的在前，最多 50 条；不带会话时跨全部会话', async () => {
  await withHarness(async ({ outside, service: create }) => {
    const service = create();
    const reports = join(outside, 'reports');
    const first = await attempt(service, access(SESSION, 'write', join(reports, 'a.md'), 'call-a1'));
    service.decide(SESSION, first.pending!.requestId, 'deny');
    const sibling = await attempt(service, access(SIBLING, 'read', join(reports, 'b.md'), 'call-b1'));
    service.decide(SIBLING, sibling.pending!.requestId, 'once');
    await attempt(service, access(SESSION, 'read', join(reports, 'c.md'), 'call-a2'));

    assert.deepEqual(service.recent(SESSION).map((item) => item.toolCallId), ['call-a2', 'call-a1']);
    assert.deepEqual(service.recent(SIBLING).map((item) => item.toolCallId), ['call-b1']);
    assert.deepEqual(service.recent('missing'), []);
    assert.deepEqual(service.recent().map((item) => item.toolCallId), ['call-a2', 'call-b1', 'call-a1']);

    for (let index = 0; index < 55; index += 1) {
      const request = await attempt(service, access(OTHER, 'read', join(reports, `${index}.md`), `call-o${index}`));
      service.decide(OTHER, request.pending!.requestId, 'deny');
    }
    const other = service.recent(OTHER);
    assert.equal(other.length, 50);
    assert.equal(other[0]?.toolCallId, 'call-o54');
    assert.equal(other.at(-1)?.toolCallId, 'call-o5');
    assert.deepEqual(service.recent(SESSION).map((item) => item.toolCallId), ['call-a2', 'call-a1']);
  });
});

test('符号链接与 `..` 不能绕过记住的范围：匹配使用与边界判定相同的真实路径', async () => {
  await withHarness(async ({ root, outside, service: create }) => {
    const service = create();
    const workDir = join(root, 'work', 'projects', 'project-a');
    await mkdir(workDir, { recursive: true });
    const reports = join(outside, 'reports');
    const secret = join(root, 'secret');
    await mkdir(secret);
    // 放行目录里有一个指向目录外其他位置的链接。
    await symlink(secret, join(reports, 'escape'));
    // 另一个目录经链接指回放行目录。
    await symlink(reports, join(outside, 'alias'));

    const judge = async (toolName: 'read' | 'write', path: string) => {
      const verdict = await judgeToolCall(toolName, { path, content: 'x' }, workDir);
      assert.equal(verdict.type, 'outside');
      return verdict.type === 'outside' ? verdict.targetPath : '';
    };
    const first = await attempt(service, access(SESSION, 'write', await judge('write', join(reports, 'a.md'))));
    service.decide(SESSION, first.pending!.requestId, 'session');

    // 经放行目录中的链接写到目录外：真实路径在 secret 中，重新确认。
    const viaLink = await judge('write', join(reports, 'escape', 'key.txt'));
    assert.equal(viaLink, join(secret, 'key.txt'));
    assert.ok((await attempt(service, access(SESSION, 'write', viaLink))).pending);
    // `..` 按字面消去后落在放行目录之外，同样重新确认。
    const dotted = await judge('write', join(reports, 'sub', '..', '..', 'reports-old', 'x.md'));
    assert.equal(dotted, join(outside, 'reports-old', 'x.md'));
    assert.ok((await attempt(service, access(SESSION, 'write', dotted))).pending);
    // 经别名链接指回放行目录：真实路径在范围内，直接放行。
    const alias = await judge('write', join(outside, 'alias', 'b.md'));
    assert.equal(alias, join(reports, 'b.md'));
    assert.deepEqual((await attempt(service, access(SESSION, 'write', alias))).decision, { allowed: true });
  });
});

test('重启后记住的决定仍然有效，撤销同样持久', async () => {
  await withHarness(async ({ outside, service: create, reopen }) => {
    const reports = join(outside, 'reports');
    const before = create();
    const first = await attempt(before, access(SESSION, 'write', join(reports, 'a.md')));
    before.decide(SESSION, first.pending!.requestId, 'session');

    reopen();
    const after = create();
    after.invalidateOnStartup();
    const [remembered] = after.listGrants();
    assert.equal(remembered?.directory, reports);
    assert.deepEqual((await attempt(after, access(SESSION, 'write', join(reports, 'b.md')))).decision, { allowed: true });

    after.revokeGrant(remembered!.grantId);
    reopen();
    const restarted = create();
    assert.deepEqual(restarted.listGrants(), []);
    assert.ok((await attempt(restarted, access(SESSION, 'write', join(reports, 'c.md')))).pending);
    // 最近的授权请求跨会话、最近的在前，含按记住的授权放行的记录。
    const recent = restarted.recent();
    assert.deepEqual(recent.map((item) => [item.status, item.approval?.source ?? null]), [
      ['pending', null], ['approved', 'grant'], ['approved', 'user'],
    ]);
  });
});
