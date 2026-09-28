import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { GLOBAL_ASSISTANT_SESSION_ID } from '@multivac/contracts';
import { SessionWorkingDirectories } from '../src/application/session-working-directories.js';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import {
  firstAvailableName,
  isPathWithin,
  localDateStamp,
  SESSION_DIRECTORY_TITLE_MAX_LENGTH,
  sessionDirectoryShortId,
  sessionDirectoryTitle,
  sessionTempDirectoryName,
} from '../src/modules/sessions/working-directory.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
  SqliteSessionRegistryRepository,
} from '../src/storage/sqlite-assistant-store.js';
import { resolveMultivacWorkPaths, WorkRootConfigurationError } from '../src/storage/work-paths.js';
import { testApplicationEnvironment, testDataDir, testWorkRoot } from './fixtures/test-environment.js';

test('会话名转为目录名：替换非法字符与空白，合并连字符，限制长度，空名回退', () => {
  assert.equal(sessionDirectoryTitle('整理需求'), '整理需求');
  assert.equal(sessionDirectoryTitle('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
  assert.equal(sessionDirectoryTitle('  方案 讨论（二）  '), '方案-讨论-二');
  assert.equal(sessionDirectoryTitle('line\nbreak\ttab\u0000nul'), 'line-break-tab-nul');
  assert.equal(sessionDirectoryTitle('$(rm -rf ~); `echo` & ok'), 'rm-rf-echo-ok');
  assert.equal(sessionDirectoryTitle('..隐藏..'), '隐藏');
  assert.equal(sessionDirectoryTitle('v1.2_draft-final'), 'v1.2_draft-final');
  // 组合字符按 NFC 合成后再保留。
  assert.equal(sessionDirectoryTitle('Café'), 'Café');
  // 空名、全符号与 emoji 都回退为默认名。
  assert.equal(sessionDirectoryTitle('   '), '会话');
  assert.equal(sessionDirectoryTitle('///'), '会话');
  assert.equal(sessionDirectoryTitle('🚀🚀'), '会话');
  // 按字符截断，不会截出半个汉字，也不留下结尾连字符。
  const long = sessionDirectoryTitle('长'.repeat(100));
  assert.equal(Array.from(long).length, SESSION_DIRECTORY_TITLE_MAX_LENGTH);
  assert.equal(sessionDirectoryTitle(`${'a'.repeat(SESSION_DIRECTORY_TITLE_MAX_LENGTH - 1)} b`), 'a'.repeat(SESSION_DIRECTORY_TITLE_MAX_LENGTH - 1));
});

test('临时目录名由本地日期、会话名与短 id 组成', () => {
  assert.equal(sessionDirectoryShortId('3F2A9C1E-7B4D-4E1A-9F00-000000000000'), '3f2a9c1e');
  assert.equal(sessionDirectoryShortId('a.b'), 'ab');
  assert.match(sessionDirectoryShortId('...'), /^[0-9a-f]{8}$/u);
  assert.equal(sessionDirectoryShortId('...'), sessionDirectoryShortId('...'));
  assert.notEqual(sessionDirectoryShortId('...'), sessionDirectoryShortId('::'));

  // 日期取本地时区：本地 9 月 28 日深夜仍是 28 日。
  assert.equal(localDateStamp(new Date(2026, 8, 28, 23, 59)), '2026-09-28');
  assert.equal(localDateStamp(new Date(2026, 0, 5, 0, 0)), '2026-01-05');
  const createdAt = new Date(2026, 8, 28, 23, 30).toISOString();
  assert.equal(
    sessionTempDirectoryName({ sessionId: 'abc-123-def', title: '接口 / 约定', createdAt }),
    '2026-09-28-接口-约定-abc123de',
  );
  // 最长的目录名也远低于文件名 255 字节的上限。
  const longest = sessionTempDirectoryName({ sessionId: 'x'.repeat(128), title: '𠀀'.repeat(200), createdAt });
  assert.ok(Buffer.byteLength(longest) < 200);
});

test('重名时依次追加序号', () => {
  const taken = new Set(['name', 'name-2']);
  assert.equal(firstAvailableName('free', (candidate) => taken.has(candidate)), 'free');
  assert.equal(firstAvailableName('name', (candidate) => taken.has(candidate)), 'name-3');
});

test('路径包含关系按路径段判断', () => {
  assert.equal(isPathWithin('/a/b', '/a/b'), true);
  assert.equal(isPathWithin('/a/b', '/a/b/c'), true);
  assert.equal(isPathWithin('/a/b', '/a/bc'), false);
  assert.equal(isPathWithin('/a/b', '/a'), false);
  // 以 .. 开头的普通文件名仍在目录内。
  assert.equal(isPathWithin('/a/b', '/a/b/..c'), true);
  assert.equal(isPathWithin('/a/b', '/a/b/../c'), false);
});

test('工作文件根目录默认位于用户主目录下的 Multivac/，并创建 multivac/ 与 sessions/', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'multivac-work-home-'));
  const previousHome = process.env.HOME;
  // homedir() 读取 HOME；测试把它指向临时目录，不触碰真实用户目录。
  process.env.HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });
  const dataDir = join(home, '.multivac');
  mkdirSync(dataDir);
  const paths = resolveMultivacWorkPaths(undefined, dataDir);
  assert.deepEqual(paths, {
    workRoot: join(home, 'Multivac'),
    multivacDir: join(home, 'Multivac', 'multivac'),
    sessionsDir: join(home, 'Multivac', 'sessions'),
    projectsDir: join(home, 'Multivac', 'projects'),
  });
  assert.equal(statSync(paths.multivacDir).isDirectory(), true);
  assert.equal(statSync(paths.sessionsDir).isDirectory(), true);
  // projects/ 预留给项目功能，这里不创建。
  assert.equal(existsSync(paths.projectsDir), false);
});

test('工作文件根目录与内部数据目录相互包含时明确报错，且不在数据目录中建目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-work-conflict-'));
  try {
    const dataDir = testDataDir(root);
    const inside = join(dataDir, 'work');
    assert.throws(() => resolveMultivacWorkPaths(inside, dataDir), (error: unknown) =>
      error instanceof WorkRootConfigurationError && /不得位于内部数据目录之下/u.test(error.message));
    assert.equal(existsSync(inside), false);
    assert.throws(() => resolveMultivacWorkPaths(dataDir, dataDir), WorkRootConfigurationError);
    // 内部数据目录也不能放进工作文件根目录。
    assert.throws(() => resolveMultivacWorkPaths(root, dataDir), WorkRootConfigurationError);
    assert.throws(() => resolveMultivacWorkPaths('relative/work', dataDir), /必须是绝对路径/u);

    // 经符号链接指向内部数据目录同样拒绝。
    const linked = join(root, 'linked-root');
    symlinkSync(dataDir, linked);
    assert.throws(() => resolveMultivacWorkPaths(linked, dataDir), WorkRootConfigurationError);
    const sneaky = join(root, 'sneaky');
    mkdirSync(join(dataDir, 'hidden-sessions'));
    mkdirSync(sneaky);
    symlinkSync(join(dataDir, 'hidden-sessions'), join(sneaky, 'sessions'));
    assert.throws(() => resolveMultivacWorkPaths(sneaky, dataDir), /实际位于内部数据目录/u);

    // 应用启动时同样校验，冲突时不启动。
    assert.throws(
      () => createMultivacApplication({ MULTIVAC_DATA_DIR: dataDir, MULTIVAC_WORK_ROOT: inside, MULTIVAC_FAKE_ASSISTANT: '1' }),
      WorkRootConfigurationError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('新建会话遇到重名目录时追加序号，已记录但目录已不存在的路径也不复用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-work-duplicate-'));
  const store = new SqliteAssistantStore(join(testDataDir(root), 'multivac.sqlite'));
  try {
    const registry = new SqliteSessionRegistryRepository(store);
    const paths = resolveMultivacWorkPaths(testWorkRoot(root), testDataDir(root));
    const directories = new SessionWorkingDirectories(paths, registry, testDataDir(root));
    const createdAt = new Date(2026, 8, 28, 10).toISOString();
    const base = join(paths.sessionsDir, '2026-09-28-同名会话-samepref');

    // 磁盘上已有同名目录（例如用户自己建的）。
    mkdirSync(base);
    writeFileSync(join(base, 'note.txt'), '用户文件');
    const first = directories.allocateSessionTemp({ sessionId: 'same-prefix-1', title: '同名会话', createdAt });
    assert.equal(first.path, `${base}-2`);
    registry.insertIfAbsent({
      sessionId: 'same-prefix-1', title: '同名会话', kind: 'work', workspaceId: 'default', createdAt, workingDirectory: first,
    });
    // 已被记录占用的路径即使目录尚不存在也不再分配。
    const second = directories.allocateSessionTemp({ sessionId: 'same-prefix-2', title: '同名会话', createdAt });
    assert.equal(second.path, `${base}-3`);
    // 大小写不同的同名记录同样视为占用。
    assert.equal(registry.isWorkingDirectoryRecorded(first.path.toUpperCase()), true);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('运行时启动前从记录取工作目录：补回被删除或只记录了路径的目录，拒绝缺失记录与内部数据目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-work-runtime-'));
  const dataDir = testDataDir(root);
  const store = new SqliteAssistantStore(join(dataDir, 'multivac.sqlite'));
  try {
    const registry = new SqliteSessionRegistryRepository(store);
    const paths = resolveMultivacWorkPaths(testWorkRoot(root), dataDir);
    const directories = new SessionWorkingDirectories(paths, registry, dataDir);
    directories.prepareOnStartup();
    const createdAt = new Date(2026, 8, 28, 10).toISOString();
    const workingDirectory = directories.allocateSessionTemp({ sessionId: 'runtime-a', title: '运行时', createdAt });
    registry.insertIfAbsent({ sessionId: 'runtime-a', title: '运行时', kind: 'work', workspaceId: 'default', createdAt, workingDirectory });

    // 记录了路径但目录尚不存在（已归档会话、用户手动删除）：启动运行时前按记录创建。
    assert.equal(existsSync(workingDirectory.path), false);
    assert.equal(directories.resolveForRuntime('runtime-a'), workingDirectory.path);
    assert.equal(statSync(workingDirectory.path).isDirectory(), true);
    assert.equal(directories.resolveForRuntime(GLOBAL_ASSISTANT_SESSION_ID), paths.multivacDir);

    // 每次都读取记录：记录更新后返回新目录（归入项目等切换工作目录的场景）。
    const moved = { kind: 'session-temp' as const, path: join(paths.sessionsDir, 'moved') };
    registry.setWorkingDirectory('runtime-a', moved);
    assert.equal(directories.resolveForRuntime('runtime-a'), moved.path);

    assert.throws(() => directories.resolveForRuntime('missing'), /没有有效的工作目录记录/u);
    // 用户挂载的目录不由 Multivac 创建，不存在时运行时不启动。
    registry.setWorkingDirectory('runtime-a', { kind: 'project-mounted', path: join(root, 'unmounted') });
    assert.throws(() => directories.resolveForRuntime('runtime-a'));
    assert.equal(existsSync(join(root, 'unmounted')), false);
    // 记录中的目录（含经符号链接）实际位于内部数据目录之下时拒绝。
    registry.setWorkingDirectory('runtime-a', { kind: 'session-temp', path: join(dataDir, 'inside') });
    assert.throws(() => directories.resolveForRuntime('runtime-a'), /内部数据目录/u);
    assert.equal(existsSync(join(dataDir, 'inside')), false);
    const link = join(paths.sessionsDir, 'link-to-data');
    symlinkSync(dataDir, link);
    registry.setWorkingDirectory('runtime-a', { kind: 'session-temp', path: link });
    assert.throws(() => directories.resolveForRuntime('runtime-a'), /内部数据目录/u);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** 模拟加入工作目录之前的数据库：删除工作目录列并回退迁移版本。 */
function downgradeToLegacyRegistry(databasePath: string): void {
  const raw = new DatabaseSync(databasePath);
  raw.exec(`
    ALTER TABLE assistant_session_registry DROP COLUMN working_directory_kind;
    ALTER TABLE assistant_session_registry DROP COLUMN working_directory_path;
    DELETE FROM schema_migrations WHERE version >= 12;
  `);
  raw.close();
}

test('存量迁移：工作会话（含已归档）补建临时目录，全局会话指向 multivac/，历史不变且可重复执行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-work-migration-'));
  const dataDir = testDataDir(root);
  const databasePath = join(dataDir, 'multivac.sqlite');
  try {
    // 旧版本留下的数据：两个进行中的工作会话（同名）、一个已归档会话，以及全局会话的绑定与草稿。
    const legacy = new SqliteAssistantStore(databasePath);
    const placeholder = { kind: 'session-temp' as const, path: '/placeholder' };
    for (const [sessionId, title, createdAt] of [
      ['legacy-a', '旧会话', new Date(2026, 8, 20, 9).toISOString()],
      ['legacy-b', '旧会话', new Date(2026, 8, 21, 9).toISOString()],
      ['legacy-archived', '已归档/会话', new Date(2026, 8, 22, 9).toISOString()],
    ] as const) {
      legacy.insertSessionIfAbsent({ sessionId, title, kind: 'work', workspaceId: 'default', createdAt, workingDirectory: placeholder });
    }
    legacy.archiveSession('legacy-archived', new Date(2026, 8, 23).toISOString());
    new SqliteAssistantBindingRepository(legacy).insertIfAbsent({
      assistantSessionId: 'legacy-a', piSessionId: 'pi-legacy-a',
      piSessionPath: '/legacy/pi-legacy-a.jsonl', updatedAt: '2026-09-20T00:00:00.000Z',
    });
    new SqliteAssistantPageStateRepository(legacy).save('legacy-a', {
      draft: '迁移前草稿', anchorEntryId: 'entry-3', anchorOffsetPx: 8, quote: null, revision: 0,
    });
    legacy.close();
    downgradeToLegacyRegistry(databasePath);

    const store = new SqliteAssistantStore(databasePath);
    const registry = new SqliteSessionRegistryRepository(store);
    assert.equal(registry.get('legacy-a')?.workingDirectory, null);
    assert.equal(registry.get(GLOBAL_ASSISTANT_SESSION_ID)?.workingDirectory, null);

    const paths = resolveMultivacWorkPaths(testWorkRoot(root), dataDir);
    const directories = new SessionWorkingDirectories(paths, registry, dataDir);
    directories.prepareOnStartup();

    const migrated = Object.fromEntries(registry.listAll().map((record) => [record.sessionId, record.workingDirectory]));
    assert.deepEqual(migrated, {
      [GLOBAL_ASSISTANT_SESSION_ID]: { kind: 'multivac', path: paths.multivacDir },
      'legacy-a': { kind: 'session-temp', path: join(paths.sessionsDir, '2026-09-20-旧会话-legacya') },
      'legacy-b': { kind: 'session-temp', path: join(paths.sessionsDir, '2026-09-21-旧会话-legacyb') },
      'legacy-archived': { kind: 'session-temp', path: join(paths.sessionsDir, '2026-09-22-已归档-会话-legacyar') },
    });
    // 未归档会话的目录已创建；已归档会话只记录路径，恢复时再创建。
    assert.deepEqual(readdirSync(paths.sessionsDir).sort(), ['2026-09-20-旧会话-legacya', '2026-09-21-旧会话-legacyb']);
    assert.equal(statSync(paths.multivacDir).isDirectory(), true);
    // 任何会话的工作目录都不在内部数据目录之下。
    for (const directory of Object.values(migrated)) assert.equal(isPathWithin(dataDir, directory!.path), false);

    // 历史绑定与页面现场不受影响。
    assert.equal(registry.get('legacy-a')?.piSessionPath, '/legacy/pi-legacy-a.jsonl');
    assert.equal(new SqliteAssistantPageStateRepository(store).get('legacy-a').draft, '迁移前草稿');

    // 重复执行不改变已有记录、不新建目录；用户删掉的进行中目录会补回。
    writeFileSync(join(paths.sessionsDir, '2026-09-20-旧会话-legacya', 'result.md'), '产出');
    await rm(join(paths.sessionsDir, '2026-09-21-旧会话-legacyb'), { recursive: true });
    directories.prepareOnStartup();
    assert.deepEqual(
      Object.fromEntries(registry.listAll().map((record) => [record.sessionId, record.workingDirectory])),
      migrated,
    );
    assert.deepEqual(readdirSync(paths.sessionsDir).sort(), ['2026-09-20-旧会话-legacya', '2026-09-21-旧会话-legacyb']);
    assert.equal(existsSync(join(paths.sessionsDir, '2026-09-20-旧会话-legacya', 'result.md')), true);

    // 调整工作文件根目录后，全局 Multivac 随之指向新的 multivac/；工作会话仍以记录为准。
    const movedPaths = resolveMultivacWorkPaths(join(root, 'moved'), dataDir);
    new SessionWorkingDirectories(movedPaths, registry, dataDir).prepareOnStartup();
    assert.deepEqual(registry.get(GLOBAL_ASSISTANT_SESSION_ID)?.workingDirectory, { kind: 'multivac', path: movedPaths.multivacDir });
    assert.deepEqual(registry.get('legacy-a')?.workingDirectory, migrated['legacy-a']);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('应用启动时完成存量迁移，接口返回的会话都带工作目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-work-migration-app-'));
  const environment = testApplicationEnvironment(root);
  const databasePath = join(testDataDir(root), 'multivac.sqlite');
  try {
    const legacy = new SqliteAssistantStore(databasePath);
    legacy.insertSessionIfAbsent({
      sessionId: 'legacy-app', title: '升级前会话', kind: 'work', workspaceId: 'default',
      createdAt: new Date(2026, 8, 26, 9).toISOString(), workingDirectory: { kind: 'session-temp', path: '/placeholder' },
    });
    legacy.close();
    downgradeToLegacyRegistry(databasePath);

    const app = createMultivacApplication(environment);
    try {
      await app.ready;
      await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
      const address = app.server.address();
      assert.ok(address && typeof address === 'object');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions`);
      const { sessions } = await response.json() as { sessions: Array<{ workingDirectory: unknown }> };
      const expected = join(testWorkRoot(root), 'sessions', '2026-09-26-升级前会话-legacyap');
      assert.deepEqual(sessions.map((session) => session.workingDirectory), [{ kind: 'session-temp', path: expected }]);
      assert.equal(statSync(expected).isDirectory(), true);
      assert.equal(statSync(join(testWorkRoot(root), 'multivac')).isDirectory(), true);
    } finally {
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
      app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
