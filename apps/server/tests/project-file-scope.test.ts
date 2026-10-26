import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GLOBAL_ASSISTANT_SESSION_ID, type WorkingDirectory } from '@multivac/contracts';
import { withFileMutationQueue, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { setImmediate as nextTick } from 'node:timers/promises';
import { projectFileScope } from '../src/application/project-file-scope.js';
import { ProjectService } from '../src/application/project-service.js';
import { SessionWorkingDirectories } from '../src/application/session-working-directories.js';
import { ToolAuthorizationService } from '../src/application/tool-authorization-service.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { resolveMultivacWorkPaths } from '../src/modules/sessions/work-paths.js';
import { createBoundaryFileTools, createToolBoundaryExtension, judgeToolCall } from '../src/runtime/executors/pi-tool-boundary.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

async function fixture() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'multivac-project-file-scope-')));
  const paths = Object.fromEntries(['primary', 'extra', 'other', 'extra-sibling', 'data', 'home'].map(name => [name, join(root, name)])) as Record<string, string>;
  for (const path of Object.values(paths)) await mkdir(path);
  const store = new SqliteAssistantStore(join(paths.data!, 'store.sqlite'));
  const workPaths = resolveMultivacWorkPaths(join(root, 'work'), paths.data!);
  const projects = new ProjectService({ projects: store.projects, workspaces: store.workspaces, workPaths, dataDir: paths.data!, homeDir: paths.home! });
  const a = projects.createProject({ name: 'a', directory: paths.primary! }).project;
  const b = projects.createProject({ name: 'b', directory: paths.other! }).project;
  const directories = new SessionWorkingDirectories(workPaths, store.sessions, paths.data!);
  const addSession = (id: string, directory?: WorkingDirectory) => {
    const { record } = store.sessions.insertIfAbsent({
      sessionId: id, title: id, kind: 'work', workspaceId: a.projectId, createdAt: new Date().toISOString(),
      workingDirectory: directory ?? directories.allocateForNewSession(projects.getProject(a.projectId), { sessionId: id, title: id, createdAt: new Date().toISOString() }),
    });
    store.bindings.insertIfAbsent({ assistantSessionId: id, harness: 'pi', runtimeSessionId: `pi-${id}`, runtimeSessionRef: join(paths.data!, `${id}.jsonl`), updatedAt: new Date().toISOString() });
    return record;
  };
  const old = addSession('old');
  const tasks = new Set<string>();
  const scope = projectFileScope({ sessions: store.sessions, workspaces: store.workspaces, projects: store.projects, isTaskSession: id => tasks.has(id) });
  const authorization = new ToolAuthorizationService({
    repository: store.toolAuthorizations, eventStream: new AssistantEventStream(), currentCommandId: () => null,
    projectOf: id => store.workspaces.get(store.sessions.get(id)?.workspaceId ?? '')?.project?.projectId ?? null,
    rememberBoundary: { homeDir: paths.home!, workRoot: workPaths.workRoot, dataDir: paths.data! },
  });
  let approval: 'deny' | 'once' | 'session' = 'deny';
  let callId = 0;
  const toolsFor = (id: string, cwd = store.sessions.get(id)!.workingDirectory!) => createBoundaryFileTools({
    cwd: cwd.path, projectDirectories: () => scope(id, cwd),
    authorizeOutsideAccess: async (access, signal) => {
      const waiting = authorization.authorize({ ...access, assistantSessionId: id, workingDirectory: cwd }, signal);
      const request = authorization.list(id).find(request => request.toolCallId === access.toolCallId && request.status === 'pending');
      if (request) authorization.decide(id, request.requestId, approval);
      return waiting;
    },
  });
  const invoke = async (tools: ReturnType<typeof toolsFor>, name: string, path: string, extra: Record<string, unknown> = {}) => {
    const tool = tools.find(tool => tool.name === name)!;
    return tool.execute(`call-${++callId}`, { path, ...extra }, new AbortController().signal, undefined, {} as ExtensionContext);
  };
  const mount = () => projects.updateProject(a.projectId, { directories: [paths.primary!, paths.extra!] });
  const unmount = () => projects.updateProject(a.projectId, { directories: [paths.primary!] });
  return { root, paths, store, projects, a, b, old, addSession, tasks, scope, toolsFor, invoke, mount, unmount, authorization,
    approve: (value: typeof approval) => { approval = value; },
    cleanup: async () => { authorization.dispose(); store.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test('真实 Pi 文件定义 + SQLite + 授权服务：已有/新建会话、挂载、卸载、主目录、当前归属按执行时记录生效', async () => {
  const f = await fixture();
  try {
    const oldTools = f.toolsFor('old');
    const file = join(f.paths.extra!, 'probe.txt');
    f.mount();
    f.addSession('new');
    for (const tools of [oldTools, f.toolsFor('new')]) {
      await f.invoke(tools, 'write', file, { content: 'before' });
      await f.invoke(tools, 'edit', file, { edits: [{ oldText: 'before', newText: 'after' }] });
      const result = await f.invoke(tools, 'read', file);
      assert.match(JSON.stringify(result), /after/);
      assert.equal(await readFile(file, 'utf8'), 'after');
      await f.invoke(tools, 'write', join(f.paths.primary!, 'main.txt'), { content: 'main' });
    }
    assert.equal(f.authorization.list('old').length + f.authorization.list('new').length, 0);

    // 已通过 tool_call 的同批调用，在真正执行前卸载，不能沿用挂载许可。
    const hook = createToolBoundaryExtension({ cwd: f.old.workingDirectory!.path, projectDirectories: () => f.scope('old', f.old.workingDirectory!), fileExecutionGuarded: true }).handlers.get('tool_call')![0]!;
    const queued = { type: 'tool_call', toolName: 'write', toolCallId: 'queued', input: { path: file, content: 'must not write' } };
    assert.equal(await hook(queued, {}), undefined);
    f.unmount();
    await assert.rejects(f.invoke(oldTools, 'write', file, { content: 'must not write' }), /未获授权|拒绝/);
    assert.equal(await readFile(file, 'utf8'), 'after');
    for (const name of ['read', 'edit']) await assert.rejects(f.invoke(oldTools, name, file, { edits: [{ oldText: 'after', newText: 'wrong' }] }), /未获授权|拒绝/);
    assert.equal(f.authorization.list('old').filter(item => item.status === 'denied').length, 3);

    f.mount();
    f.projects.updateProject(f.a.projectId, { directories: [f.paths.extra!, f.paths.primary!] });
    assert.equal(f.store.sessions.get('old')!.workingDirectory!.path, f.paths.primary);
    assert.equal(f.addSession('new-primary').workingDirectory!.path, f.paths.extra);
    // 删除旧主目录这一项目来源，既有 cwd 仍有效。
    f.projects.updateProject(f.a.projectId, { directories: [f.paths.extra!] });
    await f.invoke(oldTools, 'write', join(f.paths.primary!, 'cwd.txt'), { content: 'still cwd' });
    await f.invoke(oldTools, 'read', file);

    // 同一组工具闭包读取当前归属，不缓存创建时的项目。
    f.store.sessions.moveToWorkspace('old', { fromWorkspaceId: f.a.projectId, toWorkspaceId: f.b.projectId, workingDirectory: f.old.workingDirectory! });
    await assert.rejects(f.invoke(oldTools, 'read', file), /未获授权|拒绝/);
    await f.invoke(oldTools, 'write', join(f.paths.other!, 'b.txt'), { content: 'current project' });
    assert.equal(await readFile(join(f.paths.other!, 'b.txt'), 'utf8'), 'current project');
  } finally { await f.cleanup(); }
});

test('卸载只移除挂载来源：既有 cwd 和真实记住的独立授权仍有效，撤销独立授权后重新要求确认', async () => {
  const f = await fixture();
  try {
    const tools = f.toolsFor('old');
    const file = join(f.paths.extra!, 'grant.txt');
    f.approve('session');
    await f.invoke(tools, 'write', file, { content: 'independent' });
    const grant = f.authorization.listGrants()[0]!;
    assert.equal(grant.scope, 'session');
    f.approve('deny');
    f.mount();
    f.addSession('cwd-extra', { kind: 'project-mounted', path: f.paths.extra! });
    const cwdTools = f.toolsFor('cwd-extra');
    f.unmount();
    await f.invoke(tools, 'edit', file, { edits: [{ oldText: 'independent', newText: 'grant survived' }] });
    assert.equal(f.authorization.list('old').at(-1)!.approval?.source, 'grant');
    await f.invoke(cwdTools, 'read', file);
    assert.equal(f.authorization.list('cwd-extra').length, 0);
    f.authorization.revokeGrant(grant.grantId);
    await assert.rejects(f.invoke(tools, 'write', file, { content: 'revoked' }), /未获授权|拒绝/);
    assert.equal(await readFile(file, 'utf8'), 'grant survived');
  } finally { await f.cleanup(); }
});

test('项目范围按真实路径判定：链接逃逸、..、同前缀兄弟目录、失效挂载、待授权目标变化继续拦截', async () => {
  const f = await fixture();
  try {
    f.mount();
    const tools = f.toolsFor('old');
    const secret = join(f.paths.other!, 'secret.txt');
    await writeFile(secret, 'secret');
    await symlink(f.paths.other!, join(f.paths.extra!, 'escape'));
    await symlink('missing-target', join(f.paths.extra!, 'dangling'));
    await symlink('loop', join(f.paths.extra!, 'loop'));
    for (const path of [join(f.paths.extra!, 'escape', 'secret.txt'), `${f.paths.extra}/../other/secret.txt`, join(f.paths['extra-sibling']!, 'probe.txt')]) {
      await assert.rejects(f.invoke(tools, 'write', path, { content: 'wrong' }), /未获授权|拒绝/);
    }
    assert.equal(await readFile(secret, 'utf8'), 'secret');
    await assert.rejects(f.invoke(tools, 'read', join(f.paths.extra!, 'loop')), /无法确认/);
    await assert.rejects(f.invoke(tools, 'read', join(f.paths.extra!, 'dangling')), /ENOENT/);
    await rm(f.paths.extra!, { recursive: true });
    await assert.rejects(f.invoke(tools, 'write', join(f.paths.extra!, 'gone.txt'), { content: 'wrong' }), /未获授权|拒绝/);

    const link = join(f.paths.other!, 'link');
    await symlink(secret, link);
    const changedTools = createBoundaryFileTools({ cwd: f.old.workingDirectory!.path, projectDirectories: () => f.scope('old', f.old.workingDirectory!), authorizeOutsideAccess: async () => {
      await rm(link); await symlink(join(f.paths.other!, 'changed.txt'), link); return { allowed: true };
    } });
    await assert.rejects(f.invoke(changedTools, 'write', link, { content: 'wrong' }), /实际目标.*发生了变化/);
    assert.equal(await readFile(secret, 'utf8'), 'secret');
  } finally { await f.cleanup(); }
});

test('Pi 真实文件队列：排队期间卸载时，出队后的 write/edit 重新确认且不修改文件', async () => {
  const f = await fixture();
  try {
    const file = join(f.paths.extra!, 'queued.txt');
    await writeFile(file, 'original');
    for (const name of ['write', 'edit']) {
      f.mount();
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const blocker = withFileMutationQueue(file, () => held);
      let scopeRead!: () => void;
      const planned = new Promise<void>(resolve => { scopeRead = resolve; });
      let reads = 0;
      let requests = 0;
      const tools = createBoundaryFileTools({
        cwd: f.old.workingDirectory!.path,
        projectDirectories: () => {
          const directories = f.scope('old', f.old.workingDirectory!);
          if (++reads === 2) scopeRead();
          return directories;
        },
        authorizeOutsideAccess: async () => { requests++; return { allowed: false, reason: '卸载后需要重新确认。' }; },
      });
      const waiting = f.invoke(tools, name, file, name === 'write' ? { content: 'wrong' } : { edits: [{ oldText: 'original', newText: 'wrong' }] });
      // 观察到预解析最后一次范围读取，再让 Promise 链进入 SDK 队列；不用时间猜测。
      await planned;
      await nextTick();
      f.unmount();
      release();
      await blocker;
      await assert.rejects(waiting, /卸载后需要重新确认/);
      assert.equal(requests, 1);
      assert.equal(await readFile(file, 'utf8'), 'original');
    }
  } finally { await f.cleanup(); }
});

test('身份来自真实记录和运行模式：全局、任务 Run、worktree/task-isolated 不获得项目范围', async () => {
  const f = await fixture();
  try {
    f.mount();
    const directory = f.old.workingDirectory!;
    assert.equal(f.scope('old', directory).length, 2);
    assert.deepEqual(f.scope(GLOBAL_ASSISTANT_SESSION_ID, directory), []);
    assert.deepEqual(f.scope('unknown', directory), []);
    for (const kind of ['task-isolated', 'worktree'] as const) {
      assert.deepEqual(f.scope('old', { kind, path: directory.path }), []);
      f.store.sessions.setWorkingDirectory('old', { kind, path: directory.path });
      assert.deepEqual(f.scope('old', directory), []);
    }
    f.store.sessions.setWorkingDirectory('old', directory);
    f.tasks.add('old');
    assert.deepEqual(f.scope('old', directory), []);
    assert.equal((await judgeToolCall('read', { path: join(f.paths.extra!, 'x') }, directory.path, {}, () => f.scope('old', directory))).type, 'outside');
    f.tasks.delete('old');
    f.store.sessions.archive('old', new Date().toISOString());
    assert.deepEqual(f.scope('old', directory), []);
  } finally { await f.cleanup(); }
});
