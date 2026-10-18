import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(serverRoot, '../..');

async function typescriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return typescriptFiles(path);
      return entry.isFile() && /\.tsx?$/u.test(path) ? [path] : [];
    }),
  );
  return nested.flat();
}

test('Pi SDK 依赖只存在于 server runtime executors 内部', async () => {
  const roots = [
    join(repositoryRoot, 'packages/contracts/src'),
    join(serverRoot, 'src'),
    join(repositoryRoot, 'apps/web/src'),
  ];
  const violations: string[] = [];

  for (const root of roots) {
    for (const file of await typescriptFiles(root)) {
      const source = await readFile(file, 'utf8');
      const importsPi = /(?:from\s+|import\s*(?:\(|))['"]@earendil-works\/pi-/u.test(source);
      const allowed = file.startsWith(join(serverRoot, 'src/runtime/executors/'));
      if (importsPi && !allowed) {
        violations.push(relative(repositoryRoot, file));
      }
    }
  }

  assert.deepEqual(violations, []);
});

/** 相对导入语句（含 import type 与 export ... from），返回目标说明符及是否仅类型导入。 */
function relativeImports(source: string): { specifier: string; typeOnly: boolean }[] {
  const pattern = /^\s*(?:import|export)\s+(type\s+)?[^'";]*?from\s+['"](\.[^'"]+)['"]/gmu;
  return Array.from(source.matchAll(pattern), (match) => ({ specifier: match[2]!, typeOnly: Boolean(match[1]) }));
}

async function importsInto(fromDirectory: string, targetDirectory: string, typeOnlyAllowed: boolean): Promise<string[]> {
  const sourceRoot = join(serverRoot, 'src');
  const importers: string[] = [];
  for (const file of await typescriptFiles(join(sourceRoot, fromDirectory))) {
    const source = await readFile(file, 'utf8');
    const hit = relativeImports(source).some(({ specifier, typeOnly }) => {
      const target = relative(sourceRoot, resolve(dirname(file), specifier));
      return target.startsWith(`${targetDirectory}/`) && !(typeOnlyAllowed && typeOnly);
    });
    if (hit) importers.push(relative(sourceRoot, file));
  }
  return importers.sort();
}

test('存储实现不在运行时依赖应用层；业务错误从所属业务模块导入', async () => {
  // 仅允许以类型方式实现应用层声明的端口（例如偏好与消息文件来源仓储）。
  assert.deepEqual(await importsInto('storage', 'application', true), []);
});

test('应用层只依赖业务端口，不引用具体存储实现', async () => {
  // 仓储端口归 modules/*，SQLite 实现由 bootstrap 装配；类型导入同样不允许。
  assert.deepEqual(await importsInto('application', 'storage', false), []);
});

test('执行器之外不出现 Pi 命名的会话身份字段，身份使用与 harness 无关的命名', async () => {
  // 只有两处保留旧名：迁移前的历史迁移原文（旧库按版本重放），以及读取旧数据用的字段名对照。
  const allowed = new Set([
    join(serverRoot, 'src/storage/sqlite-legacy-schema.ts'),
    join(repositoryRoot, 'packages/contracts/src/legacy-identity.ts'),
  ]);
  const roots = [
    join(repositoryRoot, 'packages/contracts/src'),
    ...['application', 'storage', 'modules', 'adapters', 'bootstrap'].map((name) => join(serverRoot, 'src', name)),
    join(repositoryRoot, 'apps/web/src'),
  ];
  const pattern = /\b[a-zA-Z]*Pi(?:Session|Entry|Turn)(?:Id|Path|Ref)\b|\bpi(?:Session|Entry|Turn)[A-Za-z]*\b|\b[a-z_]*pi_(?:session|entry|turn)[a-z_]*\b/gu;
  const found: string[] = [];
  for (const root of roots) {
    for (const file of await typescriptFiles(root)) {
      if (allowed.has(file)) continue;
      for (const match of (await readFile(file, 'utf8')).matchAll(pattern)) found.push(`${relative(repositoryRoot, file)}: ${match[0]}`);
    }
  }
  assert.deepEqual(found, []);
});

test('执行器端口归业务模块，应用层与业务模块不引用具体执行器实现', async () => {
  // CoordinatorAdapter、任务隔离与进程监护等端口位于 modules/*；具体实现由 bootstrap 装配。
  assert.deepEqual(await importsInto('application', 'runtime', false), []);
  assert.deepEqual(await importsInto('modules', 'runtime', false), []);
});

test('bootstrap 只经 harness 注册表装配执行器，不直接引用具体适配器、模型目录与访问后端', async () => {
  // 新增执行器在 harness-registry 中登记；Fake 夹具额外向 E2E 控制面提供对象。
  const allowed = [
    'fake-harness', 'fake-model-access-backend', 'harness', 'harness-registry',
    'managed-bash-tool', 'pi-skill-parser', 'process-runtime',
  ];
  const used = new Set<string>();
  for (const file of await typescriptFiles(join(serverRoot, 'src/bootstrap'))) {
    for (const { specifier } of relativeImports(await readFile(file, 'utf8'))) {
      const match = /runtime\/executors\/([a-z-]+)\.js$/u.exec(specifier);
      if (match) used.add(match[1]!);
    }
  }
  assert.deepEqual([...used].filter((name) => !allowed.includes(name)).sort(), []);
});
