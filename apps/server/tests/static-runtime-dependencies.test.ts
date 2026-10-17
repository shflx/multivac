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

test('应用层对具体存储的依赖只减不增', async () => {
  // 存量依赖待按重构指南 R01 / R08 逐步迁移到业务端口；迁移后从清单删除，新增文件不得直接依赖存储。
  const legacy = [
    'application/bash-process-service.ts',
    'application/image-service.ts',
    'application/inbox-service.ts',
    'application/managed-process-service.ts',
    'application/model-usage-service.ts',
    'application/project-service.ts',
    'application/reading-service.ts',
    'application/reminder-scheduler.ts',
    'application/reminder-service.ts',
    'application/session-working-directories.ts',
    'application/skill-service.ts',
    'application/temp-directory-cleaner.ts',
    'application/temp-directory-removal.ts',
  ];
  assert.deepEqual(await importsInto('application', 'storage', false), legacy);
});

test('执行器端口归业务模块，应用层对具体执行器实现的依赖只减不增', async () => {
  // CoordinatorAdapter 等端口位于 modules/sessions；应用层只依赖端口，具体实现由 bootstrap 装配。
  // 存量依赖（进程监督脚本与原生任务工具）待按重构指南 R12 收进执行器端口后从清单删除。
  const legacy = [
    'application/bash-process-service.ts',
    'application/managed-process-service.ts',
    'application/task-working-directories.ts',
  ];
  assert.deepEqual(await importsInto('application', 'runtime', false), legacy);
  assert.deepEqual(await importsInto('modules', 'runtime', false), []);
});
