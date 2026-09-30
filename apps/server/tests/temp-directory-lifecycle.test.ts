import assert from 'node:assert/strict';
import {
  existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import type { WorkspaceSession } from '@multivac/contracts';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { PreferencesService } from '../src/application/preferences-service.js';
import { SessionWorkingDirectories } from '../src/application/session-working-directories.js';
import { TempDirectoryCleaner } from '../src/application/temp-directory-cleaner.js';
import { TempDirectoryRemovalPolicy } from '../src/application/temp-directory-removal.js';
import { measureDirectoryUsage } from '../src/modules/sessions/directory-usage.js';
import { cleanupDueAt, isCleanupDue } from '../src/modules/sessions/temp-directory-cleanup.js';
import {
  SqliteAssistantStore,
  SqlitePreferenceRepository,
  SqliteProjectRepository,
  SqliteSessionRegistryRepository,
  SqliteTempDirectoryCleanupRepository,
} from '../src/storage/sqlite-assistant-store.js';
import { DirectoryTrash, systemTrash, UnavailableTrash, XdgTrash } from '../src/storage/trash.js';
import { resolveMultivacWorkPaths } from '../src/storage/work-paths.js';
import { testApplicationEnvironment, testDataDir, testTrashDir, testWorkRoot } from './fixtures/test-environment.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function withRoot(name: string, run: (root: string) => Promise<void> | void): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `multivac-temp-lifecycle-${name}-`));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * 直接组装临时目录生命周期的各部分：会话记录、工作目录、清理计划、偏好与清理器。
 * 时钟可拨动，废纸篓是测试临时目录，运行时用一个集合模拟。
 */
function lifecycle(root: string) {
  const dataDir = testDataDir(root);
  const store = new SqliteAssistantStore(join(dataDir, 'multivac.sqlite'));
  const registry = new SqliteSessionRegistryRepository(store);
  const plans = new SqliteTempDirectoryCleanupRepository(store);
  const preferences = new PreferencesService(new SqlitePreferenceRepository(store));
  const projects = new SqliteProjectRepository(store);
  const workPaths = resolveMultivacWorkPaths(testWorkRoot(root), dataDir);
  let now = Date.UTC(2026, 8, 28, 8);
  const iso = () => new Date(now).toISOString();
  const runtimes = new Set<string>();
  const removal = new TempDirectoryRemovalPolicy({
    registry, projects, paths: workPaths, dataDir, hasRuntime: (sessionId) => runtimes.has(sessionId),
  });
  const directories = new SessionWorkingDirectories(workPaths, registry, dataDir, { plans, removal, now: iso });
  const trashDir = testTrashDir(root);
  const logs: string[] = [];
  const cleaner = new TempDirectoryCleaner({
    plans, registry, removal, paths: workPaths,
    trash: new DirectoryTrash(trashDir),
    retentionDays: () => preferences.tempRetentionDays(),
    now: () => now,
    log: (message) => logs.push(message),
  });

  /** 新建一个不属于项目的会话，临时目录里放入给定的文件。 */
  function addSession(sessionId: string, files: Record<string, string> = {}) {
    const directory = directories.allocateSessionTemp({ sessionId, title: sessionId, createdAt: iso() });
    registry.insertIfAbsent({ sessionId, title: sessionId, kind: 'work', workspaceId: 'default', createdAt: iso(), workingDirectory: directory });
    directories.ensure(directory);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(directory.path, name), content);
    return directory;
  }

  /** 挂载项目中的会话：工作目录是项目当时的主目录（挂载目录）。 */
  function addProjectSession(sessionId: string, projectId: string, path: string) {
    registry.insertIfAbsent({
      sessionId, title: sessionId, kind: 'work', workspaceId: projectId, createdAt: iso(),
      workingDirectory: { kind: 'project-mounted', path },
    });
  }

  return {
    store, registry, plans, preferences, projects, workPaths, directories, removal, cleaner, runtimes, trashDir, logs, addSession, addProjectSession,
    advanceDays(days: number) { now += days * DAY_MS; },
    archive(sessionId: string) {
      return directories.archive(registry.archive(sessionId, iso())!);
    },
    /** 与服务的恢复流程一致：先经 reopen 取消清理并补建目录，再清除归档标记。 */
    restore(sessionId: string) {
      const reopened = directories.reopen(registry.get(sessionId)!);
      registry.restore(sessionId);
      return reopened;
    },
  };
}

test('到期时间按起算时间 + 当前保留天数计算；从不清理与无法解析的时间不到期', () => {
  const since = '2026-09-01T00:00:00.000Z';
  assert.equal(cleanupDueAt(since, 30), Date.parse('2026-10-01T00:00:00.000Z'));
  assert.equal(cleanupDueAt(since, 7), Date.parse('2026-09-08T00:00:00.000Z'));
  assert.equal(cleanupDueAt(since, null), null);
  assert.equal(cleanupDueAt('not a date', 30), null);
  assert.equal(isCleanupDue(since, 7, Date.parse('2026-09-08T00:00:00.000Z')), true);
  assert.equal(isCleanupDue(since, 7, Date.parse('2026-09-07T23:59:59.999Z')), false);
  assert.equal(isCleanupDue(since, 90, Date.parse('2026-10-01T00:00:00.000Z')), false);
  assert.equal(isCleanupDue(since, null, Date.parse('2099-01-01T00:00:00.000Z')), false);
});

test('废纸篓：重名时追加后缀、不覆盖；XDG 写入 files 与 info；不支持的平台明确报错', async () => {
  await withRoot('trash', (root) => {
    const trash = new DirectoryTrash(join(root, 'Trash'));
    const make = (name: string, content: string) => {
      const path = join(root, 'src', name);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'note.md'), content);
      return path;
    };
    const first = trash.moveToTrash(make('报告', '第一份'));
    // 废纸篓里已有同名的条目（含一个同名的空目录）时，都追加后缀，谁也不覆盖。
    mkdirSync(join(root, 'Trash', '报告-2'));
    const second = trash.moveToTrash(make('报告', '第二份'));
    assert.equal(first, join(root, 'Trash', '报告'));
    assert.equal(second, join(root, 'Trash', '报告-3'));
    assert.equal(readFileSync(join(first, 'note.md'), 'utf8'), '第一份');
    assert.equal(readFileSync(join(second, 'note.md'), 'utf8'), '第二份');
    assert.deepEqual(readdirSync(join(root, 'Trash', '报告-2')), []);
    assert.equal(existsSync(join(root, 'src', '报告')), false);
    // 源目录不存在时报错，也不留下占位。
    assert.throws(() => trash.moveToTrash(join(root, 'src', '不存在')));
    assert.deepEqual(readdirSync(join(root, 'Trash')).sort(), ['报告', '报告-2', '报告-3']);

    const xdg = new XdgTrash(join(root, 'xdg', 'Trash'), () => new Date(2026, 8, 28, 9, 5, 7));
    const a = xdg.moveToTrash(make('临时 目录', 'a'));
    const b = xdg.moveToTrash(make('临时 目录', 'b'));
    assert.equal(a, join(root, 'xdg', 'Trash', 'files', '临时 目录'));
    assert.equal(b, join(root, 'xdg', 'Trash', 'files', '临时 目录-2'));
    const info = readFileSync(join(root, 'xdg', 'Trash', 'info', '临时 目录-2.trashinfo'), 'utf8');
    assert.equal(info, `[Trash Info]\nPath=${join(root, 'src', '临时 目录').split('/').map(encodeURIComponent).join('/')}\nDeletionDate=2026-09-28T09:05:07\n`);
    assert.equal(readFileSync(join(b, 'note.md'), 'utf8'), 'b');
    // 移动失败时删除 trashinfo，不留下指向不存在条目的记录。
    assert.throws(() => xdg.moveToTrash(join(root, 'src', '不存在')));
    assert.deepEqual(readdirSync(join(root, 'xdg', 'Trash', 'info')).sort(), ['临时 目录-2.trashinfo', '临时 目录.trashinfo']);

    assert.throws(() => new UnavailableTrash('不支持').moveToTrash(), /不支持/);
    // 系统废纸篓按平台选择，构造时不访问文件系统。
    assert.ok(systemTrash({ platform: 'darwin', homeDir: '/Users/me' }) instanceof DirectoryTrash);
    assert.ok(systemTrash({ platform: 'linux', homeDir: '/home/me' }) instanceof XdgTrash);
    assert.ok(systemTrash({ platform: 'win32', homeDir: 'C:\\Users\\me' }) instanceof UnavailableTrash);
    assert.throws(() => new DirectoryTrash('relative/trash'));
  });
});

test('归档：空的临时目录直接删除；有文件时登记计划，到期移到废纸篓，恢复时重建空目录并说明', async () => {
  await withRoot('archive', (root) => {
    const life = lifecycle(root);
    try {
      const empty = life.addSession('empty');
      assert.equal(life.archive('empty'), 'removed');
      assert.equal(existsSync(empty.path), false);
      assert.equal(life.plans.get(empty.path), undefined);
      // 恢复时按原路径补建，不说成“移到了废纸篓”。
      assert.deepEqual(life.restore('empty'), { directory: empty, trashedDirectory: null });
      assert.equal(existsSync(empty.path), true);

      const full = life.addSession('full', { 'report.md': '调研报告' });
      assert.equal(life.archive('full'), 'scheduled');
      assert.equal(life.plans.get(full.path)?.reason, 'archived');

      // 默认保留 30 天：29 天时不动。
      life.advanceDays(29);
      assert.deepEqual(life.cleaner.sweep().trashed, []);
      assert.equal(readFileSync(join(full.path, 'report.md'), 'utf8'), '调研报告');

      life.advanceDays(1);
      const result = life.cleaner.sweep();
      assert.deepEqual(result.trashed.map((item) => [item.path, item.reason]), [[full.path, 'archived']]);
      const trashPath = result.trashed[0]!.trashPath;
      assert.equal(trashPath, join(life.trashDir, basename(full.path)));
      assert.equal(existsSync(full.path), false);
      assert.equal(readFileSync(join(trashPath, 'report.md'), 'utf8'), '调研报告');
      // 已清理的不再重复处理。
      assert.deepEqual(life.cleaner.sweep().trashed, []);

      const reopened = life.restore('full');
      assert.equal(reopened.trashedDirectory?.trashPath, trashPath);
      assert.ok(reopened.trashedDirectory?.trashedAt);
      assert.deepEqual(readdirSync(full.path), []);
      assert.equal(life.plans.get(full.path), undefined);
      // 再次归档又是空目录，直接删除。
      assert.equal(life.archive('full'), 'removed');
    } finally {
      life.store.close();
    }
  });
});

test('到期前恢复会话即取消清理；恢复后再怎么拨时钟都不清理', async () => {
  await withRoot('restore', (root) => {
    const life = lifecycle(root);
    try {
      const directory = life.addSession('back', { 'draft.md': '草稿' });
      life.archive('back');
      life.advanceDays(10);
      assert.equal(life.restore('back').trashedDirectory, null);
      assert.equal(life.plans.get(directory.path), undefined);
      life.advanceDays(365);
      const result = life.cleaner.sweep();
      assert.deepEqual([result.trashed, result.cancelled], [[], []]);
      assert.equal(readFileSync(join(directory.path, 'draft.md'), 'utf8'), '草稿');

      // 计划残留（例如恢复绕过了 reopen）时，清理前核对记录发现会话未归档，同样不清理并取消计划。
      life.plans.schedule({ path: directory.path, reason: 'archived', sessionId: 'back', since: '2020-01-01T00:00:00.000Z' });
      assert.deepEqual(life.cleaner.sweep().cancelled, [directory.path]);
      assert.equal(existsSync(join(directory.path, 'draft.md')), true);
    } finally {
      life.store.close();
    }
  });
});

test('修改保留时长按起算时间动态生效；从不清理时一律保留；有运行时的会话本次跳过', async () => {
  await withRoot('preference', (root) => {
    const life = lifecycle(root);
    try {
      const a = life.addSession('a', { 'a.md': 'a' });
      life.archive('a');
      life.advanceDays(10);
      assert.deepEqual(life.cleaner.sweep().trashed, []);

      // 30 天改为 7 天：已归档 10 天的随即到期。先改为从不：再久也不清理。
      life.preferences.update({ tempRetentionDays: null });
      life.advanceDays(1000);
      assert.deepEqual(life.cleaner.sweep(), { trashed: [], removed: [], cancelled: [], failed: [] });
      assert.equal(existsSync(join(a.path, 'a.md')), true);

      life.preferences.update({ tempRetentionDays: 90 });
      const b = life.addSession('b', { 'b.md': 'b' });
      life.archive('b');
      life.advanceDays(30);
      // a 已归档 1040 天，b 只有 30 天：只清理 a。
      assert.deepEqual(life.cleaner.sweep().trashed.map((item) => item.sessionId), ['a']);
      life.preferences.update({ tempRetentionDays: 7 });
      // 会话此刻有运行时（可能正在被恢复或访问）：本次不动它，计划保留。
      life.runtimes.add('b');
      assert.deepEqual(life.cleaner.sweep().trashed, []);
      assert.ok(life.plans.get(b.path));
      life.runtimes.delete('b');
      assert.deepEqual(life.cleaner.sweep().trashed.map((item) => item.sessionId), ['b']);

      // 偏好持久化，存储中的非法值回退为默认 30 天。
      assert.deepEqual(new PreferencesService(new SqlitePreferenceRepository(life.store)).get(), { tempRetentionDays: 7 });
      new SqlitePreferenceRepository(life.store).set('tempRetentionDays', 14);
      assert.deepEqual(life.preferences.get(), { tempRetentionDays: 30 });
    } finally {
      life.store.close();
    }
  });
});

test('只清理 sessions/ 下的临时目录：Multivac 工作目录、项目目录、越界路径与符号链接一律不动', async () => {
  await withRoot('guard', (root) => {
    const life = lifecycle(root);
    try {
      const { workPaths } = life;
      mkdirSync(workPaths.projectsDir, { recursive: true });
      const managed = join(workPaths.projectsDir, '技术研究');
      mkdirSync(managed);
      writeFileSync(join(workPaths.multivacDir, 'keep.md'), '全局');
      writeFileSync(join(managed, 'keep.md'), '项目');
      const since = '2020-01-01T00:00:00.000Z';

      // 项目会话与全局会话归档时不登记计划。
      life.registry.insertIfAbsent({
        sessionId: 'in-project', title: '项目会话', kind: 'work', workspaceId: 'default', createdAt: since,
        workingDirectory: { kind: 'project-managed', path: managed },
      });
      assert.equal(life.archive('in-project'), 'kept');

      // 即使计划（被篡改或出错）指向 multivac/、projects/ 下的目录、sessions/ 本身或更深的子目录，也不清理。
      const outside = join(root, 'elsewhere');
      mkdirSync(outside);
      writeFileSync(join(outside, 'keep.md'), '别处');
      const nested = life.addSession('nested', { 'x.md': 'x' });
      mkdirSync(join(nested.path, 'sub'));
      for (const path of [workPaths.multivacDir, managed, workPaths.sessionsDir, outside, join(nested.path, 'sub')]) {
        life.plans.schedule({ path, reason: 'orphaned', sessionId: 'nobody', since });
      }
      // sessions/ 下指向项目目录的符号链接：不跟随，也不移走链接。
      const link = join(workPaths.sessionsDir, 'link-to-project');
      symlinkSync(managed, link);
      life.plans.schedule({ path: link, reason: 'orphaned', sessionId: 'nobody', since });
      // 位于 sessions/ 下、归档后才被项目挂载为目录（或其中有被挂载的子目录）的临时目录：属于项目，不清理。
      const mounted = life.addSession('mounted', { 'code.ts': 'x' });
      const containing = life.addSession('containing', { 'y.md': 'y' });
      mkdirSync(join(containing.path, 'repo'));
      life.archive('mounted');
      life.archive('containing');
      life.projects.create({
        projectId: 'p-1', name: '挂载', defaultConstraints: '', createdAt: since,
        directories: [{ kind: 'mounted', path: mounted.path }, { kind: 'mounted', path: join(containing.path, 'repo') }],
      });
      life.advanceDays(400);

      const result = life.cleaner.sweep();
      assert.deepEqual(result.trashed, []);
      assert.deepEqual(new Set(result.cancelled), new Set([
        workPaths.multivacDir, managed, workPaths.sessionsDir, outside, join(nested.path, 'sub'), link, mounted.path, containing.path,
      ]));
      assert.equal(readFileSync(join(workPaths.multivacDir, 'keep.md'), 'utf8'), '全局');
      assert.equal(readFileSync(join(managed, 'keep.md'), 'utf8'), '项目');
      assert.equal(readFileSync(join(outside, 'keep.md'), 'utf8'), '别处');
      assert.ok(lstatSync(link).isSymbolicLink());
      assert.equal(existsSync(join(mounted.path, 'code.ts')), true);
      assert.equal(existsSync(join(containing.path, 'repo')), true);
      assert.equal(existsSync(life.trashDir), false);
      assert.ok(life.logs.length >= 6);
    } finally {
      life.store.close();
    }
  });
});

test('到期清理前核对其他会话：已登记清理的临时目录被挂载为项目目录后又卸载，仍被项目会话（含已归档的、使用其中子目录的）使用时不清理', async () => {
  await withRoot('shared', (root) => {
    const life = lifecycle(root);
    try {
      const since = '2026-09-01T00:00:00.000Z';
      const elsewhere = join(root, 'elsewhere');
      mkdirSync(elsewhere);
      // 临时会话归档、登记了清理之后，目录才被挂载为项目主目录（挂载按路径进行，不看会话是否归档）。
      const shared = life.addSession('temp', { 'code.ts': '项目代码' });
      const outer = life.addSession('outer', { 'notes.md': '笔记' });
      const repo = join(outer.path, 'repo');
      mkdirSync(repo);
      // 作为对照：没有其他会话使用的临时目录照常清理。
      life.addSession('alone', { 'a.md': 'a' });
      for (const sessionId of ['temp', 'outer', 'alone']) assert.equal(life.archive(sessionId), 'scheduled');

      // 项目中新建的会话以挂载目录为工作目录；另一个项目挂载临时目录中的子目录，它的会话后来也归档了。
      life.projects.create({
        projectId: 'p-1', name: '挂载', defaultConstraints: '', createdAt: since,
        directories: [{ kind: 'mounted', path: shared.path }],
      });
      life.addProjectSession('in-project', 'p-1', shared.path);
      life.projects.create({
        projectId: 'p-2', name: '子目录', defaultConstraints: '', createdAt: since,
        directories: [{ kind: 'mounted', path: repo }],
      });
      life.addProjectSession('in-repo', 'p-2', repo);
      life.registry.archive('in-repo', since);
      // 从项目设置卸载这些目录（已有会话仍用原路径）：只看当前项目目录已经看不到它们。
      for (const projectId of ['p-1', 'p-2']) {
        life.projects.update(projectId, { directories: [{ kind: 'mounted', path: elsewhere }], updatedAt: since });
      }

      life.advanceDays(31);
      const result = life.cleaner.sweep();
      assert.deepEqual(result.trashed.map((item) => item.sessionId), ['alone']);
      assert.deepEqual(new Set(result.cancelled), new Set([shared.path, outer.path]));
      assert.equal(readFileSync(join(shared.path, 'code.ts'), 'utf8'), '项目代码');
      assert.equal(readFileSync(join(outer.path, 'notes.md'), 'utf8'), '笔记');
      assert.equal(existsSync(repo), true);
      assert.ok(life.logs.some((message) => message.includes('其他会话') && message.includes(shared.path)));

      // 孤立目录同理：按路径包含关系核对，不只比较完全相同的路径。
      const left = life.addSession('moved', { 'b.md': 'b' });
      mkdirSync(join(left.path, 'sub'));
      life.registry.setWorkingDirectory('moved', { kind: 'project-mounted', path: elsewhere });
      life.directories.orphan(left, 'moved');
      assert.ok(life.plans.get(left.path));
      life.addProjectSession('in-sub', 'p-1', join(left.path, 'sub'));
      life.advanceDays(31);
      assert.deepEqual(life.cleaner.sweep().cancelled, [left.path]);
      assert.equal(existsSync(join(left.path, 'b.md')), true);
    } finally {
      life.store.close();
    }
  });
});

test('归档时删除空的临时目录与到期清理同一套判定：被挂载为项目目录或仍被其他会话使用时保留，不登记清理', async () => {
  await withRoot('archive-shared', (root) => {
    const life = lifecycle(root);
    try {
      const since = '2026-09-01T00:00:00.000Z';
      const elsewhere = join(root, 'elsewhere');
      mkdirSync(elsewhere);
      // 空的临时目录被挂载为项目主目录（项目里还没有会话）：属于项目，不删除。
      const mounted = life.addSession('mounted');
      life.projects.create({
        projectId: 'p-1', name: '挂载', defaultConstraints: '', createdAt: since,
        directories: [{ kind: 'mounted', path: mounted.path }],
      });
      // 空的临时目录被挂载、项目中新建了会话，随后卸载：项目会话仍在用，不删除。
      const unmounted = life.addSession('unmounted');
      life.projects.create({
        projectId: 'p-2', name: '已卸载', defaultConstraints: '', createdAt: since,
        directories: [{ kind: 'mounted', path: unmounted.path }],
      });
      life.addProjectSession('in-project', 'p-2', unmounted.path);
      life.projects.update('p-2', { directories: [{ kind: 'mounted', path: elsewhere }], updatedAt: since });
      // 作为对照：无人使用的空临时目录照常删除。
      const alone = life.addSession('alone');

      assert.equal(life.archive('mounted'), 'kept');
      assert.equal(life.archive('unmounted'), 'kept');
      assert.equal(life.archive('alone'), 'removed');
      assert.equal(existsSync(mounted.path), true);
      assert.equal(existsSync(unmounted.path), true);
      assert.equal(existsSync(alone.path), false);
      assert.equal(life.plans.get(mounted.path), undefined);
      assert.equal(life.plans.get(unmounted.path), undefined);

      // 其他入口（归入项目后删除空的原目录、新建失败的回收）同样经过这份判定。
      assert.equal(life.directories.discard(unmounted), false);
      assert.equal(existsSync(unmounted.path), true);
      // 恢复后照常使用原目录。
      assert.deepEqual(life.restore('unmounted'), { directory: unmounted, trashedDirectory: null });
    } finally {
      life.store.close();
    }
  });
});

test('归入项目后留下的临时目录从归入时起计时；再被会话记录引用时取消；启动时为存量归档会话补登记', async () => {
  await withRoot('orphan', (root) => {
    const life = lifecycle(root);
    try {
      const left = life.addSession('moved', { 'same.md': '留在原处' });
      // 模拟归入项目：会话记录改到项目目录，原临时目录不再被引用。
      life.registry.setWorkingDirectory('moved', { kind: 'project-managed', path: join(root, 'project') });
      life.directories.orphan(left, 'moved');
      assert.deepEqual({ ...life.plans.get(left.path), since: undefined }, {
        path: left.path, directoryKind: 'session-temp', reason: 'orphaned', sessionId: 'moved', since: undefined, trashedAt: null, trashPath: null,
      });
      life.advanceDays(30);
      assert.deepEqual(life.cleaner.sweep().trashed.map((item) => [item.path, item.reason]), [[left.path, 'orphaned']]);
      // 孤立目录没有会话再用，清理后计划结束。
      assert.equal(life.plans.get(left.path), undefined);

      const reused = life.addSession('reused', { 'a.md': 'a' });
      life.registry.setWorkingDirectory('reused', { kind: 'project-managed', path: join(root, 'project') });
      life.directories.orphan(reused, 'reused');
      assert.ok(life.plans.get(reused.path));
      life.registry.setWorkingDirectory('reused', reused);
      life.advanceDays(31);
      assert.deepEqual(life.cleaner.sweep().cancelled, [reused.path]);
      assert.equal(existsSync(join(reused.path, 'a.md')), true);

      // 到期时已是空目录：直接删除，不进废纸篓。
      const emptied = life.addSession('emptied', { 'b.md': 'b' });
      life.archive('emptied');
      unlinkSync(join(emptied.path, 'b.md'));
      life.advanceDays(31);
      assert.deepEqual(life.cleaner.sweep().removed, [emptied.path]);
      assert.equal(existsSync(emptied.path), false);

      // 生命周期上线前归档、仍有文件的会话：启动时从这次启动起计时登记，不按当年的归档时间立即清理。
      const legacy = life.addSession('legacy', { 'old.md': 'old' });
      life.store.archiveSession('legacy', '2020-01-01T00:00:00.000Z');
      life.directories.prepareOnStartup();
      assert.equal(life.plans.get(legacy.path)?.reason, 'archived');
      assert.deepEqual(life.cleaner.sweep().trashed, []);
      life.advanceDays(30);
      assert.deepEqual(life.cleaner.sweep().trashed.map((item) => item.sessionId), ['legacy']);
    } finally {
      life.store.close();
    }
  });
});

test('移到废纸篓失败（如平台不支持）时目录与计划都保留，下次检查时重试', async () => {
  await withRoot('failure', (root) => {
    const life = lifecycle(root);
    try {
      const directory = life.addSession('stuck', { 'a.md': 'a' });
      life.archive('stuck');
      life.advanceDays(31);
      const failing = new TempDirectoryCleaner({
        plans: life.plans, registry: life.registry, removal: life.removal, paths: life.workPaths,
        trash: new UnavailableTrash('当前平台不支持'),
        retentionDays: () => life.preferences.tempRetentionDays(),
        now: () => Date.now() + 365 * DAY_MS,
        log: () => {},
      });
      assert.deepEqual(failing.sweep().failed, [{ path: directory.path, error: '当前平台不支持' }]);
      assert.equal(existsSync(join(directory.path, 'a.md')), true);
      assert.ok(life.plans.get(directory.path));
      // 定时与偏好变化触发的检查不抛错。
      failing.sweepSafely();
      assert.deepEqual(life.cleaner.sweep().trashed.map((item) => item.sessionId), ['stuck']);
    } finally {
      life.store.close();
    }
  });
});

test('临时目录占用：不跟随符号链接、硬链接只计一次，条目过多时标记为不完整', async () => {
  await withRoot('usage', async (root) => {
    const sessions = join(root, 'sessions');
    const outside = join(root, 'outside');
    mkdirSync(join(sessions, 'a', 'deep'), { recursive: true });
    mkdirSync(join(sessions, 'b'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(sessions, 'a', 'one.txt'), '12345');
    writeFileSync(join(sessions, 'a', 'deep', 'two.txt'), '123');
    linkSync(join(sessions, 'a', 'one.txt'), join(sessions, 'b', 'same.txt'));
    writeFileSync(join(outside, 'big.bin'), Buffer.alloc(10_000));
    symlinkSync(outside, join(sessions, 'b', 'link'));
    const linkSize = lstatSync(join(sessions, 'b', 'link')).size;

    assert.deepEqual(await measureDirectoryUsage(sessions), { directories: 2, bytes: 8 + linkSize, truncated: false });
    assert.equal((await measureDirectoryUsage(sessions, { maxEntries: 2 })).truncated, true);
    assert.deepEqual(await measureDirectoryUsage(join(root, 'missing')), { directories: 0, bytes: 0, truncated: false });
  });
});

function httpJson(port: number, path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
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

test('HTTP：偏好读写与校验、临时目录占用、归档前核对，到期清理进入注入的废纸篓，恢复后说明并不再清理', async () => {
  await withRoot('http', async (root) => {
    const app = createMultivacApplication({ ...testApplicationEnvironment(root), MULTIVAC_E2E_CONTROL: '1' });
    await app.ready;
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const { port } = address;
    try {
      assert.deepEqual((await httpJson(port, '/api/preferences')).body, { preferences: { tempRetentionDays: 30 } });
      assert.equal((await httpJson(port, '/api/preferences', 'PATCH', { tempRetentionDays: 14 })).status, 400);
      assert.equal((await httpJson(port, '/api/preferences', 'PATCH', {})).status, 400);
      assert.equal((await httpJson(port, '/api/preferences', 'POST', { tempRetentionDays: 7 })).status, 405);

      const create = async (sessionId: string) =>
        (await httpJson(port, '/api/sessions', 'POST', { sessionId, title: sessionId })).body as WorkspaceSession;
      const kept = await create('kept');
      const back = await create('back');
      writeFileSync(join(kept.workingDirectory.path, 'report.md'), '保留的报告');
      writeFileSync(join(back.workingDirectory.path, 'draft.md'), '草稿');

      const usage = (await httpJson(port, '/api/temp-directories/usage')).body;
      assert.equal(usage.directories, 2);
      assert.equal(usage.bytes, Buffer.byteLength('保留的报告') + Buffer.byteLength('草稿'));
      assert.equal(usage.truncated, false);

      assert.deepEqual((await httpJson(port, '/api/sessions/kept/archive/preview')).body, {
        sessionId: 'kept', workingDirectory: kept.workingDirectory, files: { total: 1, names: ['report.md'] }, tempRetentionDays: 30,
      });
      assert.equal((await httpJson(port, '/api/sessions/missing/archive/preview')).status, 404);
      assert.equal((await httpJson(port, '/api/sessions/kept/archive', 'POST')).status, 200);
      assert.equal((await httpJson(port, '/api/sessions/back/archive', 'POST')).status, 200);
      // 已归档的会话不能再核对。
      assert.equal((await httpJson(port, '/api/sessions/kept/archive/preview')).status, 404);

      // 缩短为 7 天后立即按新时长检查：刚归档的还没到期。
      assert.deepEqual((await httpJson(port, '/api/preferences', 'PATCH', { tempRetentionDays: 7 })).body, {
        preferences: { tempRetentionDays: 7 },
      });
      assert.equal(existsSync(join(kept.workingDirectory.path, 'report.md')), true);

      // 到期前恢复 back；再拨快 8 天，只有 kept 进入注入的废纸篓。
      assert.deepEqual((await httpJson(port, '/api/sessions/back/restore', 'POST')).body.trashedDirectory, null);
      const sweep = (await httpJson(port, '/api/__e2e/temp-directories', 'POST', { advanceMs: 8 * DAY_MS })).body;
      assert.deepEqual(sweep.trashed.map((item: { sessionId: string }) => item.sessionId), ['kept']);
      const trashPath = sweep.trashed[0].trashPath as string;
      assert.equal(trashPath, join(testTrashDir(root), basename(kept.workingDirectory.path)));
      assert.equal(readFileSync(join(trashPath, 'report.md'), 'utf8'), '保留的报告');
      assert.equal(readFileSync(join(back.workingDirectory.path, 'draft.md'), 'utf8'), '草稿');
      assert.equal(existsSync(kept.workingDirectory.path), false);

      const restored = (await httpJson(port, '/api/sessions/kept/restore', 'POST')).body;
      assert.equal(restored.session.archivedAt, null);
      assert.equal(restored.trashedDirectory.trashPath, trashPath);
      assert.deepEqual(readdirSync(kept.workingDirectory.path), []);
      assert.equal((await httpJson(port, '/api/temp-directories/usage')).body.bytes, Buffer.byteLength('草稿'));
    } finally {
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
      app.close();
    }
  });
});

/** 启动测试应用（Fake、注入的废纸篓、测试控制路由），用完关闭。 */
async function withApplication(root: string, run: (port: number) => Promise<void>): Promise<void> {
  const app = createMultivacApplication({ ...testApplicationEnvironment(root), MULTIVAC_E2E_CONTROL: '1' });
  await app.ready;
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(address.port);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    app.close();
  }
}

test('HTTP：临时目录挂载为项目目录、项目中新建会话、卸载后（归档原临时会话在此前或此后），到期都不移走项目会话仍在使用的目录', async () => {
  await withRoot('http-shared', async (root) => {
    await withApplication(root, async (port) => {
      /** 挂载这个临时目录为新项目的目录，在项目中新建会话，再从项目设置卸载它（已有的项目会话仍用原路径）。 */
      const shareThenUnmount = async (temp: WorkspaceSession, name: string) => {
        // 一个目录只属于一个项目：每个项目卸载后换成各自的另一个目录。
        const elsewhere = join(root, `elsewhere-${temp.sessionId}`);
        mkdirSync(elsewhere);
        const created = await httpJson(port, '/api/projects', 'POST', { name, directory: temp.workingDirectory.path });
        assert.equal(created.status, 201);
        const projectId = created.body.project.projectId as string;
        const inProject = (await httpJson(port, '/api/sessions', 'POST', {
          sessionId: `${temp.sessionId}-project`, title: `${name}会话`, workspaceId: projectId,
        })).body as WorkspaceSession;
        assert.deepEqual(inProject.workingDirectory, { kind: 'project-mounted', path: temp.workingDirectory.path });
        assert.equal((await httpJson(port, `/api/projects/${projectId}`, 'PATCH', { directories: [elsewhere] })).status, 200);
      };
      const create = async (sessionId: string) => {
        const session = (await httpJson(port, '/api/sessions', 'POST', { sessionId, title: sessionId })).body as WorkspaceSession;
        writeFileSync(join(session.workingDirectory.path, 'code.ts'), sessionId);
        return session;
      };

      // 先归档（登记了清理），之后才挂载、新建项目会话、卸载：到期核对时发现仍被项目会话使用，取消计划。
      const before = await create('before');
      assert.equal((await httpJson(port, '/api/sessions/before/archive', 'POST')).status, 200);
      await shareThenUnmount(before, '先归档');
      // 按报告的顺序：挂载、新建项目会话、卸载之后再归档原临时会话。
      const after = await create('after');
      await shareThenUnmount(after, '后归档');
      assert.equal((await httpJson(port, '/api/sessions/after/archive', 'POST')).status, 200);

      const sweep = (await httpJson(port, '/api/__e2e/temp-directories', 'POST', { advanceMs: 31 * DAY_MS })).body;
      assert.deepEqual(sweep.trashed, []);
      assert.deepEqual(sweep.cancelled, [before.workingDirectory.path]);
      assert.equal(readFileSync(join(before.workingDirectory.path, 'code.ts'), 'utf8'), 'before');
      assert.equal(readFileSync(join(after.workingDirectory.path, 'code.ts'), 'utf8'), 'after');
      assert.equal(existsSync(testTrashDir(root)), false);
    });
  });
});

test('HTTP：空的临时目录被挂载为项目目录后，归档原会话与把会话归入这个项目都不删除它；归档核对不说“归档时删除”', async () => {
  await withRoot('http-archive-shared', async (root) => {
    await withApplication(root, async (port) => {
      const create = async (sessionId: string, workspaceId?: string) => (await httpJson(port, '/api/sessions', 'POST', {
        sessionId, title: sessionId, ...(workspaceId ? { workspaceId } : {}),
      })).body as WorkspaceSession;
      const createProject = async (name: string, directory: string) => {
        const created = await httpJson(port, '/api/projects', 'POST', { name, directory });
        assert.equal(created.status, 201);
        return created.body.project.projectId as string;
      };

      // 挂载后在项目中新建会话：归档原临时会话时不删除项目正在使用的空目录。
      const temp = await create('temp');
      const projectId = await createProject('挂载项目', temp.workingDirectory.path);
      const inProject = await create('in-project', projectId);
      assert.equal(inProject.workingDirectory.path, temp.workingDirectory.path);
      assert.equal((await httpJson(port, '/api/sessions/temp/archive/preview')).body.files, null);
      assert.equal((await httpJson(port, '/api/sessions/temp/archive', 'POST')).status, 200);
      assert.equal(existsSync(temp.workingDirectory.path), true);
      assert.deepEqual(readdirSync(temp.workingDirectory.path), []);

      // 会话的临时目录被挂载为项目主目录，再把会话归入这个项目：目录就是项目目录，不删除。
      const own = await create('own');
      const ownProject = await createProject('自己的目录', own.workingDirectory.path);
      const moved = await httpJson(port, '/api/sessions/own/move-to-project', 'POST', { projectId: ownProject, moveFiles: false });
      assert.equal(moved.status, 200);
      assert.equal(moved.body.sourceRemoved, false);
      assert.equal(moved.body.sourceInUse, true);
      assert.deepEqual(moved.body.session.workingDirectory, { kind: 'project-mounted', path: own.workingDirectory.path });
      assert.equal(existsSync(own.workingDirectory.path), true);
      const sweep = (await httpJson(port, '/api/__e2e/temp-directories', 'POST', { advanceMs: 400 * DAY_MS })).body;
      assert.deepEqual(sweep.trashed, []);
      assert.equal(existsSync(own.workingDirectory.path), true);
    });
  });
});

test('HTTP：归入项目的核对与结果写明原临时目录是否正被项目或其他会话使用（sourceInUse），在用的不删除、不登记清理', async () => {
  await withRoot('http-move-in-use', async (root) => {
    await withApplication(root, async (port) => {
      const create = async (sessionId: string) =>
        (await httpJson(port, '/api/sessions', 'POST', { sessionId, title: sessionId })).body as WorkspaceSession;
      const research = (await httpJson(port, '/api/projects', 'POST', { name: '研究' })).body.project.projectId as string;

      // 临时目录被另一个项目挂载（归入的是“研究”）：核对时就写明，归入后保留、到期也不清理。
      const shared = await create('shared');
      writeFileSync(join(shared.workingDirectory.path, 'notes.md'), '笔记');
      assert.equal((await httpJson(port, '/api/projects', 'POST', { name: '挂载', directory: shared.workingDirectory.path })).status, 201);
      const preview = (await httpJson(port, '/api/sessions/shared/move-to-project/preview', 'POST', { projectId: research })).body;
      assert.equal(preview.sourceInUse, true);
      assert.equal(preview.files.total, 1);
      const moved = (await httpJson(port, '/api/sessions/shared/move-to-project', 'POST', { projectId: research, moveFiles: false })).body;
      assert.deepEqual([moved.sourceRemoved, moved.sourceInUse], [false, true]);

      // 空的临时目录同样：被使用时不删除。
      const empty = await create('empty');
      assert.equal((await httpJson(port, '/api/projects', 'POST', { name: '空目录', directory: empty.workingDirectory.path })).status, 201);
      const emptied = (await httpJson(port, '/api/sessions/empty/move-to-project', 'POST', { projectId: research, moveFiles: true })).body;
      assert.deepEqual([emptied.sourceRemoved, emptied.sourceInUse], [false, true]);
      assert.equal(existsSync(empty.workingDirectory.path), true);

      // 对照：没有被使用的临时目录照常删除或登记清理，sourceInUse 为 false。
      const plain = await create('plain');
      writeFileSync(join(plain.workingDirectory.path, 'draft.md'), '草稿');
      assert.equal((await httpJson(port, '/api/sessions/plain/move-to-project/preview', 'POST', { projectId: research })).body.sourceInUse, false);
      const left = (await httpJson(port, '/api/sessions/plain/move-to-project', 'POST', { projectId: research, moveFiles: false })).body;
      assert.deepEqual([left.sourceRemoved, left.sourceInUse], [false, false]);

      const sweep = (await httpJson(port, '/api/__e2e/temp-directories', 'POST', { advanceMs: 31 * DAY_MS })).body;
      assert.deepEqual(sweep.trashed.map((item: { path: string }) => item.path), [plain.workingDirectory.path]);
      assert.equal(readFileSync(join(shared.workingDirectory.path, 'notes.md'), 'utf8'), '笔记');
    });
  });
});
