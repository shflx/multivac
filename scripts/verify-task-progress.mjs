// 使用同步内置模块入口，避免隔离运行时枚举 fs 的延迟异步导出。
const assert = process.getBuiltinModule('assert/strict');
const { readFileSync, writeFileSync, mkdirSync, existsSync } = process.getBuiltinModule('fs');
const { createHash } = process.getBuiltinModule('crypto');
const { stripTypeScriptTypes } = process.getBuiltinModule('module');
// node:test 在此受控运行时加载 os 时会触发原生断言；仅适配测试中的方法替换。
const restorers = [];
const mock = {
  method(target, name, implementation = target[name]) {
    const original = target[name]; const calls = [];
    const replacement = function (...args) { calls.push(args); return Reflect.apply(implementation, this, args); };
    replacement.mock = { callCount: () => calls.length };
    target[name] = replacement;
    restorers.push(() => { target[name] = original; });
    return replacement;
  },
  restoreAll() { for (const restore of restorers.splice(0).reverse()) restore(); },
};

// 依赖未安装的隔离目录中，运行原有测试回调和实际状态、SQL、事件实现。
// 只替换第三方契约校验与浏览器入口；不启动子进程、不访问网络。
// 测试只处理 JSON 响应，不加载会初始化系统模块的原生 fetch 实现。
delete globalThis.fetch;
delete globalThis.Response;
Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: async () => { throw new Error('验证禁止真实网络请求'); } });
Object.defineProperty(globalThis, 'Response', { configurable: true, writable: true, value: class {
  constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; this.ok = this.status >= 200 && this.status < 300; }
  async json() { return JSON.parse(this.body); }
} });
const sources = new Map();
function read(path) {
  const value = readFileSync(path, 'utf8'); sources.set(path, value); return value;
}
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const withoutImports = (source) => source.replace(/^import\s[\s\S]*?;\n/gm, '');
const transpile = (source) => stripTypeScriptTypes(source, { mode: 'transform', disableExperimentalWarning: true });
const contracts = read('packages/contracts/src/task.ts');
function between(source, from, to) {
  const start = source.indexOf(from); const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `源码边界不存在：${from}`);
  return source.slice(start, end);
}
const schemas = ['TaskListSchema', 'TaskReceiptSchema', 'TaskDetailSchema', 'TaskRelationsSchema', 'TaskQuerySchema', 'TaskSchema',
  'ConfirmHumanTaskSchema', 'CreateTaskSchema', 'UpdateTaskSchema', 'DeleteTaskSchema', 'CreateTaskGroupSchema', 'AssistantApiErrorResponseSchema'];
const support = moduleUrl(transpile(`
export const Check = () => true;
${schemas.map((name) => `export const ${name} = {};`).join('\n')}
export const DEFAULT_AGENT_ID = 'general';
export const DEFAULT_TASK_BUDGET = { maxRuns: 20, maxMillis: 21600000, maxOutputBytes: 16777216 };
export const UNKNOWN_CHANGE_ORIGIN = { windowId: null };
${between(contracts, 'export function satisfiesTaskDependency(', 'const NullableId')}
${between(contracts, 'export function taskViewStatus(', 'export const TaskQuerySchema')}
`));
const api = moduleUrl(transpile(`import { Check, AssistantApiErrorResponseSchema } from '${support}';
const WINDOW_ID_HEADER = 'x-multivac-window-id';
const windowId = () => 'validation-window';
const notifyAccessFailure = () => {};
${between(read('apps/web/src/data/assistant-api.ts'), 'export class AssistantApiError', '/**\n * 会话级接口前缀')}`));
const panel = moduleUrl(transpile(`import { taskViewStatus } from '${support}';
${withoutImports(read('apps/web/src/features/tasks/task-panel-state.ts'))}`));
const providerSource = read('apps/web/src/features/tasks/tasks-provider.tsx');
const store = moduleUrl(transpile(`import { TaskListSchema, TaskReceiptSchema, TaskDetailSchema, TaskRelationsSchema } from '${support}';
import { AssistantApiError, fetchJson } from '${api}';
import { matchesTask } from '${panel}';
${withoutImports(providerSource.slice(0, providerSource.indexOf('const Context = createContext')))}`));
const queries = moduleUrl(transpile(withoutImports(read('apps/web/src/features/tasks/task-relation-queries.ts'))));
const tree = moduleUrl(transpile(withoutImports(read('apps/web/src/features/tasks/task-tree-state.ts'))));
const service = moduleUrl(transpile(`import { randomUUID } from 'node:crypto';
import { Check, ConfirmHumanTaskSchema, CreateTaskSchema, UpdateTaskSchema, DeleteTaskSchema, CreateTaskGroupSchema, TaskQuerySchema, TaskSchema,
  UNKNOWN_CHANGE_ORIGIN, satisfiesTaskDependency, DEFAULT_AGENT_ID, DEFAULT_TASK_BUDGET } from '${support}';
${withoutImports(read('apps/server/src/application/task-service.ts'))}`));
const repository = moduleUrl(transpile(`import { Check, DEFAULT_AGENT_ID, TaskSchema } from '${support}';
${withoutImports(read('apps/server/src/storage/sqlite-task-repository.ts'))}`));
const events = moduleUrl(transpile(withoutImports(read('apps/server/src/application/workbench-events.ts'))));
const modules = { TasksStore: store, TaskRelationQuery: queries, taskTreeRows: tree, TaskService: service, WorkbenchEvents: events, SqliteTaskRepository: repository };
const tests = [];
globalThis.__registerTaskProgressTest = (name, run) => tests.push({ name, run });
const paths = [
  'apps/web/tests/task-progress.test.ts',
  'apps/web/tests/tasks-store.test.ts',
  'apps/web/tests/task-relations-state.test.ts',
  'apps/server/tests/task-progress.test.ts',
];
for (const path of paths) {
  let source = read(path).replace("import test from 'node:test';", 'const test = globalThis.__registerTaskProgressTest;');
  source = source.replace(/^import type[^;]*;\n/gm, '');
  source = source.replace(/^import (\{[^}]+\}) from '([^']+)';/gm, (original, names, target) => {
    if (target.startsWith('node:')) return original;
    if (target === '@multivac/contracts') return `import ${names} from '${support}';`;
    const name = Object.keys(modules).find((name) => names.includes(name));
    assert.ok(name, `未声明的测试依赖：${target}`);
    return `import ${names} from '${modules[name]}';`;
  });
  await import(moduleUrl(transpile(source)));
}
delete globalThis.__registerTaskProgressTest;
const results = [];
for (const { name, run } of tests) {
  try {
    await run({ mock });
    await new Promise((resolve) => setImmediate(resolve));
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
  } finally { mock.restoreAll(); }
}
const syntaxChecks = ['tests/e2e/task-progress.spec.ts'].map((path) => {
  try { transpile(read(path)); return { path, passed: true }; }
  catch (error) { return { path, passed: false, error: error.message }; }
});
const report = {
  node: process.version,
  dependenciesInstalled: existsSync('node_modules/typescript'),
  scope: '执行实际 TasksStore、关系查询、TaskService、SQLite 聚合、WorkbenchEvents 及四个测试文件的原始回调。使用 Node 类型擦除；契约 Check、浏览器鉴权、JSON Response、测试 mock 和 React 入口由适配器替换。',
  limitations: ['未执行第三方契约校验、React 渲染、TypeScript 类型检查或浏览器端到端测试。', '多窗口按独立缓存和广播订阅验证；重连按连接后的缓存失效及补读验证，未运行真实 SSE 连接。'],
  passed: results.every((result) => result.passed) && syntaxChecks.every((result) => result.passed),
  total: results.length,
  results,
  syntaxChecks,
  sourceHashes: Object.fromEntries([...sources].map(([path, source]) => [path, createHash('sha256').update(source).digest('hex')])),
};
mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/task-progress-verification.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
