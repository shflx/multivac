import assert from 'node:assert/strict';
import test from 'node:test';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GLOBAL_ASSISTANT_SESSION_ID, type WorkingDirectory } from '@multivac/contracts';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { ProjectService } from '../src/application/project-service.js';
import { SessionWorkingDirectories } from '../src/application/session-working-directories.js';
import { resolveMultivacWorkPaths } from '../src/modules/sessions/work-paths.js';
import { projectBashScope } from '../src/application/project-bash-scope.js';

async function fixture() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'multivac-project-bash-')));
  const primary = join(root, 'primary'), extra = join(root, 'extra'), other = join(root, 'other');
  const data = join(root, 'data'), home = join(root, 'home');
  for (const path of [primary, extra, other, data, home, join(root, 'extra-sibling')]) await mkdir(path);
  const store = new SqliteAssistantStore(join(data, 'store.sqlite'));
  const workPaths = resolveMultivacWorkPaths(join(root, 'work'), data);
  const projects = new ProjectService({ projects: store.projects, workspaces: store.workspaces, workPaths, dataDir: data, homeDir: home });
  const a = projects.createProject({ name: 'a', directory: primary }).project;
  const b = projects.createProject({ name: 'b', directory: other }).project;
  const directories = new SessionWorkingDirectories(workPaths, store.sessions, data);
  const add = (id: string, directory?: WorkingDirectory) => store.sessions.insertIfAbsent({
    sessionId: id, title: id, kind: 'work', workspaceId: a.projectId, createdAt: new Date().toISOString(),
    workingDirectory: directory ?? directories.forProject(projects.getProject(a.projectId)!),
  }).record.workingDirectory!;
  const old = add('old');
  const tasks = new Set<string>();
  const scope = projectBashScope({ sessions: store.sessions, workspaces: store.workspaces, projects: store.projects, isTaskSession: id => tasks.has(id) });
  const mount = () => projects.updateProject(a.projectId, { directories: [primary, extra] });
  const unmount = () => projects.updateProject(a.projectId, { directories: [primary] });
  return { root, primary, extra, other, store, projects, a, b, old, add, tasks, scope, mount, unmount,
    close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('bash 当前项目范围：已有/新会话、主附目录和子目录、默认 cwd、主目录及归属变化', async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.scope('old', f.old, f.extra), /当前已确认/);
    f.mount();
    const fresh = f.add('new');
    const child = join(f.extra, 'child'); await mkdir(child);
    for (const [id, cwd] of [['old', f.old], ['new', fresh]] as const) {
      assert.equal(f.scope(id, cwd).directory, f.primary);
      for (const path of [f.primary, f.extra, child]) assert.equal(f.scope(id, cwd, path).directory, path);
      assert.equal(f.scope(id, cwd, '../extra/child').directory, child);
      assert.deepEqual(f.store.sessions.get(id)!.workingDirectory, cwd);
    }
    f.projects.updateProject(f.a.projectId, { directories: [f.extra, f.primary] });
    assert.equal(f.add('new-primary').path, f.extra);
    assert.equal(f.scope('old', f.old).directory, f.primary);
    const original = f.add('extra-original', { kind: 'project-mounted', path: f.extra });
    f.unmount();
    assert.equal(f.scope('extra-original', original).directory, f.extra);
    assert.throws(() => f.scope('old', f.old, child), /当前已确认/);
    f.mount();
    f.store.sessions.moveToWorkspace('old', { fromWorkspaceId: f.a.projectId, toWorkspaceId: f.b.projectId, workingDirectory: f.old });
    assert.throws(() => f.scope('old', f.old, f.extra), /当前已确认/);
    assert.equal(f.scope('old', f.old, f.other).directory, f.other);
    assert.equal(f.scope('old', f.old).directory, f.primary);
  } finally { await f.close(); }
});

test('bash 真实目录边界：同前缀、..、文件、缺失目录及符号链接逃逸拒绝，合法链接钉住真实目录', async () => {
  const f = await fixture();
  try {
    f.mount();
    await writeFile(join(f.extra, 'file'), 'file');
    await symlink(f.other, join(f.extra, 'escape'));
    await symlink('absent', join(f.extra, 'dangling'));
    await symlink('loop', join(f.extra, 'loop'));
    await mkdir(join(f.extra, 'child'));
    await symlink(join(f.extra, 'child'), join(f.primary, 'inside'));
    assert.equal(f.scope('old', f.old, 'inside').directory, join(f.extra, 'child'));
    for (const path of [join(f.root, 'extra-sibling'), join(f.extra, '../other'), join(f.extra, 'escape')]) {
      assert.throws(() => f.scope('old', f.old, path), /当前已确认/);
    }
    for (const path of ['', join(f.extra, 'missing'), join(f.extra, 'file'), join(f.extra, 'dangling'), join(f.extra, 'loop')]) {
      assert.throws(() => f.scope('old', f.old, path), /有效的目录|无法确认真实路径/);
    }
    await rm(f.extra, { recursive: true });
    assert.throws(() => f.scope('old', f.old, f.extra), /无法确认真实路径/);
  } finally { await f.close(); }
});

test('bash 准备后复核：卸载、主目录移除、归属/cwd/归档变化、链接替换及目录消失不能沿用旧计划', async () => {
  const f = await fixture();
  try {
    f.mount();
    const plan = f.scope('old', f.old, f.extra);
    f.unmount(); assert.throws(plan.revalidate, /当前已确认/);
    f.mount();
    const beforePrimary = f.scope('old', f.old, f.extra);
    f.projects.updateProject(f.a.projectId, { directories: [f.extra] });
    beforePrimary.revalidate(); // 当前主目录仍可使用，原 cwd 来源也仍可使用。
    f.projects.updateProject(f.a.projectId, { directories: [f.primary] });
    assert.throws(beforePrimary.revalidate, /当前已确认/);
    f.mount();
    const beforeMove = f.scope('old', f.old, f.extra);
    f.store.sessions.moveToWorkspace('old', { fromWorkspaceId: f.a.projectId, toWorkspaceId: f.b.projectId, workingDirectory: f.old });
    assert.throws(beforeMove.revalidate, /当前已确认/);
    f.store.sessions.moveToWorkspace('old', { fromWorkspaceId: f.b.projectId, toWorkspaceId: f.a.projectId, workingDirectory: f.old });
    const child = join(f.extra, 'child'), second = join(f.extra, 'second'), link = join(f.primary, 'link');
    await mkdir(child); await mkdir(second); await symlink(child, link);
    const beforeLink = f.scope('old', f.old, link);
    await rm(link); await symlink(second, link);
    assert.throws(beforeLink.revalidate, /实际目标已发生变化/);
    const missing = f.scope('old', f.old, child);
    await rm(child, { recursive: true }); assert.throws(missing.revalidate, /无法确认真实路径/);
    const cwd = f.scope('old', f.old);
    f.store.sessions.setWorkingDirectory('old', { kind: 'project-mounted', path: f.extra });
    assert.throws(cwd.revalidate, /目录已变化/);
    f.store.sessions.setWorkingDirectory('old', f.old);
    const archived = f.scope('old', f.old);
    f.store.sessions.archive('old', new Date().toISOString());
    assert.throws(archived.revalidate, /已归档/);
  } finally { await f.close(); }
});

test('全局和隔离任务不获得项目或子目录执行能力，任务身份变化在复核时生效', async () => {
  const f = await fixture();
  try {
    f.mount(); await mkdir(join(f.primary, 'child'));
    assert.equal(f.scope(GLOBAL_ASSISTANT_SESSION_ID, f.old).directory, f.primary);
    assert.throws(() => f.scope(GLOBAL_ASSISTANT_SESSION_ID, f.old, f.extra), /原工作目录/);
    assert.throws(() => f.scope(GLOBAL_ASSISTANT_SESSION_ID, f.old, 'child'), /原工作目录/);
    const plan = f.scope('old', f.old, f.extra);
    f.tasks.add('old');
    assert.throws(plan.revalidate, /原工作目录/);
    assert.equal(f.scope('old', f.old).directory, f.primary);
    for (const kind of ['task-isolated', 'worktree'] as const) {
      const cwd = f.add(kind, { kind, path: f.primary });
      assert.equal(f.scope(kind, cwd).directory, f.primary);
      assert.throws(() => f.scope(kind, cwd, f.extra), /原工作目录/);
      assert.throws(() => f.scope(kind, cwd, 'child'), /原工作目录/);
    }
    assert.throws(() => f.scope('missing', f.old), /目录已变化/);
  } finally { await f.close(); }
});
