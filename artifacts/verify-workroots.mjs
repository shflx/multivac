import { loadSource } from './source-loader.mjs';
const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');
const assert = process.getBuiltinModule('node:assert/strict');
const crypto = process.getBuiltinModule('node:crypto');
// 只取所需同步接口，避免受控运行器中fs.promises懒加载的node:os崩溃。
const fileOps = Object.fromEntries(['existsSync', 'mkdirSync', 'readdirSync', 'realpathSync', 'rmdirSync', 'rmSync', 'statSync', 'lstatSync'].map(name => [name, fs[name]]));
const asyncFiles = Object.fromEntries(['cp', 'lstat', 'mkdir', 'readdir', 'realpath'].map(name => [name, async (...args) => fs[`${name}Sync`](...args)]));
const root = fs.mkdtempSync(path.join(process.cwd(), '.workroot-validation-'));
const runtime = loadSource('apps/server/src/runtime-config.ts', { ...path, lstatSync: fs.lstatSync, realpathSync: fs.realpathSync, homedir: () => root, createHash: crypto.createHash }, ['resolveRuntimeConfig', 'canonicalRuntimePath', 'WorkRootConfigurationError']);
const naming = loadSource('apps/server/src/modules/sessions/working-directory.ts', { ...path, createHash: crypto.createHash }, ['isPathWithin', 'firstAvailableName', 'sessionTempDirectoryName']);
const storage = loadSource('apps/server/src/storage/work-paths.ts', { ...path, ...fileOps, ...runtime, ...naming }, ['resolveMultivacWorkPaths', 'assertManagedWorkPath']);
const { TempDirectoryRemovalPolicy } = loadSource('apps/server/src/application/temp-directory-removal.ts', { ...path, ...fileOps, ...naming, ...storage }, ['TempDirectoryRemovalPolicy']);
const { SessionWorkingDirectories } = loadSource('apps/server/src/application/session-working-directories.ts', { ...path, ...fileOps, ...naming, ...storage, TempDirectoryRemovalPolicy }, ['SessionWorkingDirectories']);
const due = loadSource('apps/server/src/modules/sessions/temp-directory-cleanup.ts', {}, ['isCleanupDue']);
const { TempDirectoryCleaner } = loadSource('apps/server/src/application/temp-directory-cleaner.ts', { ...path, ...fileOps, ...due }, ['TempDirectoryCleaner']);
let now = Date.parse('2026-10-01T00:00:00Z');
function instance(name, strict) {
  const dataDir = path.join(root, `${name}-data`); fs.mkdirSync(dataDir);
  const paths = storage.resolveMultivacWorkPaths(path.join(root, `${name}-work`), dataDir, strict);
  const records = new Map(); const pending = new Map();
  const registry = { listAll: () => [...records.values()], get: id => records.get(id), isWorkingDirectoryRecorded: target => [...records.values()].some(item => item.workingDirectory?.path === target), setWorkingDirectory: (id, directory) => { records.get(id).workingDirectory = directory; } };
  const plans = { schedule: plan => pending.set(plan.path, { ...plan, directoryKind: 'session-temp', trashedAt: null, trashPath: null }), get: target => pending.get(target), listPending: () => [...pending.values()].filter(item => !item.trashedAt), markTrashed: (target, at, trashPath) => Object.assign(pending.get(target), { trashedAt: at, trashPath }), remove: target => pending.delete(target) };
  const removal = new TempDirectoryRemovalPolicy({ registry, projects: { list: () => [] }, paths, dataDir, hasRuntime: () => false });
  const directories = new SessionWorkingDirectories(paths, registry, dataDir, { plans, removal, now: () => new Date(now).toISOString() });
  const trashRoot = path.join(root, `${name}-trash`); fs.mkdirSync(trashRoot);
  const cleaner = new TempDirectoryCleaner({ plans, registry, removal, paths, retentionDays: () => 7, now: () => now, log: () => {}, trash: { moveToTrash: target => { const destination = path.join(trashRoot, path.basename(target)); fs.renameSync(target, destination); return destination; } } });
  return { paths, records, plans, removal, directories, cleaner, dataDir };
}
try {
  const prod = instance('production', false); const dev = instance('development', true);
  function add(value, id) {
    const directory = value.directories.allocateSessionTemp({ sessionId: id, title: '独立会话', createdAt: new Date(now).toISOString() });
    const record = { sessionId: id, kind: 'work', title: id, createdAt: new Date(now).toISOString(), archivedAt: null, workingDirectory: directory };
    value.records.set(id, record); value.directories.ensure(directory); fs.writeFileSync(path.join(directory.path, 'marker.txt'), id); return record;
  }
  const prodRecord = add(prod, 'prod-session'); const devRecord = add(dev, 'dev-session');
  fs.writeFileSync(path.join(prod.paths.multivacDir, 'production.txt'), 'production-global');
  fs.writeFileSync(path.join(dev.paths.multivacDir, 'development.txt'), 'development-global');
  assert.notEqual(prodRecord.workingDirectory.path, devRecord.workingDirectory.path);
  console.log('PASS 全局与临时会话使用两个独立真实工作根');
  devRecord.archivedAt = new Date(now).toISOString();
  assert.equal(dev.directories.archive(devRecord), 'scheduled');
  // 注入指向另一实例的遗留清理计划，验证不能清理。
  dev.plans.schedule({ path: prodRecord.workingDirectory.path, reason: 'orphaned', sessionId: 'foreign', since: new Date(now).toISOString() });
  now += 8 * 86400000;
  const sweep = dev.cleaner.sweep(); assert.equal(sweep.trashed.length, 1); assert.equal(sweep.cancelled.length, 1);
  assert.equal(fs.existsSync(devRecord.workingDirectory.path), false);
  assert.equal(fs.readFileSync(path.join(prodRecord.workingDirectory.path, 'marker.txt'), 'utf8'), 'prod-session');
  assert.equal(fs.readFileSync(path.join(prod.paths.multivacDir, 'production.txt'), 'utf8'), 'production-global');
  console.log('PASS 开发归档与到期清理真实移动文件，拒绝跨实例计划，生产文件保持不变');
  const reopened = dev.directories.reopen(devRecord); assert.ok(reopened.trashedDirectory);
  assert.equal(fs.existsSync(devRecord.workingDirectory.path), true); assert.equal(dev.plans.get(devRecord.workingDirectory.path), undefined);
  devRecord.archivedAt = null; dev.directories.prepareOnStartup();
  assert.equal(fs.readFileSync(path.join(prodRecord.workingDirectory.path, 'marker.txt'), 'utf8'), 'prod-session');
  console.log('PASS 恢复与启动补齐只重建开发目录，保留生产历史文件');
  assert.throws(() => dev.directories.ensure({ kind: 'session-temp', path: prodRecord.workingDirectory.path }), /本实例工作根/u);
  const shared = path.join(root, 'shared-external'); fs.mkdirSync(shared);
  dev.directories.prepare({ kind: 'project-mounted', path: shared }); prod.directories.prepare({ kind: 'project-mounted', path: shared });
  assert.equal(dev.removal.check(shared, null).verdict, 'refused');
  console.log('PASS 开发拒绝恢复外部托管路径；显式挂载测试目录可共享但不能自动清理');
  // tasks目录已有独立根与防外链检查；这里只执行无项目的分配，不执行Git或原生工具初始化。
  const { TaskWorkingDirectories } = loadSource('apps/server/src/application/task-working-directories.ts', { ...path, ...naming, ...asyncFiles, promisify: () => async () => { throw Error('不允许执行子进程'); }, execFile: () => {}, taskDirectoryName: () => 'isolated-task', taskBranchName: () => null, NativeTaskTools: { create: async () => ({ dispose() {} }) } }, ['TaskWorkingDirectories']);
  const task = { taskId: 'fixture', projectId: null };
  const prodTask = await new TaskWorkingDirectories(prod.paths.workRoot, () => null).prepare(task, 'prod', new AbortController().signal);
  const devTask = await new TaskWorkingDirectories(dev.paths.workRoot, () => null).prepare(task, 'dev', new AbortController().signal);
  assert.notEqual(prodTask.directory.path, devTask.directory.path);
  assert.ok(devTask.directory.path.startsWith(path.join(dev.paths.workRoot, 'tasks')));
  fs.mkdirSync(prod.paths.projectsDir, { recursive: true });
  fs.symlinkSync(prod.paths.projectsDir, path.join(dev.paths.workRoot, 'project-alias'));
  assert.throws(() => storage.assertManagedWorkPath(dev.paths, path.join(dev.paths.workRoot, 'project-alias', 'new')), /本实例工作根/u);
  console.log('PASS 任务目录独立分配，托管项目外链拒绝；未执行真实Git及原生任务工具');
  console.log('说明：使用内存记录/清理计划和测试废纸篓，执行真实目录生命周期源码与文件操作；未验证SQLite持久恢复或项目授权UI。');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
