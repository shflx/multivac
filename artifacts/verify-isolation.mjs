// 受控环境中的汇总入口；不启动子进程或网络，不访问真实生产目录。
import { sourceJavaScript } from './source-loader.mjs';
const fs = process.getBuiltinModule('node:fs');
const results = [];
for (const script of ['verify-config.mjs', 'verify-pi-paths.mjs', 'verify-workroots.mjs', 'verify-browser-isolation.mjs']) {
  try { await import(`./${script}`); results.push({ script, passed: true }); }
  catch (error) { results.push({ script, passed: false, error: String(error) }); console.error('FAIL', script, String(error)); }
}
const files = [
  'apps/server/src/runtime-config.ts', 'apps/server/src/environment.ts', 'apps/server/src/main.ts',
  'apps/server/src/bootstrap/application.ts', 'apps/server/src/storage/data-paths.ts', 'apps/server/src/storage/work-paths.ts',
  'apps/server/src/application/project-service.ts', 'apps/server/src/application/session-working-directories.ts', 'apps/server/src/application/temp-directory-removal.ts',
  'apps/server/src/runtime/executors/pi-instance-paths.ts', 'apps/server/src/runtime/executors/pi-model-access-backend.ts',
  'apps/server/src/runtime/executors/pi-model-settings-catalog.ts', 'apps/server/src/runtime/executors/pi-coordinator-adapter.ts',
  'apps/server/src/runtime/executors/pi-session-factory.ts', 'apps/server/src/adapters/http/remote-access.ts',
  'apps/web/vite.config.ts', 'playwright.config.ts',
  'apps/server/tests/pi-instance-isolation.test.ts', 'apps/server/tests/work-root-isolation.test.ts',
  'apps/server/tests/remote-instance-cookie.test.ts', 'apps/server/tests/runtime-instance-integration.test.ts',
];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
try {
  for (const file of files) new AsyncFunction('importMeta', sourceJavaScript(file).replace(/\bimport\.meta\b/gu, 'importMeta').replace(/export default /gu, 'return '));
  for (const file of ['apps/server/package.json', 'apps/web/tsconfig.json', 'package.json']) JSON.parse(fs.readFileSync(file, 'utf8'));
  results.push({ script: 'syntax-and-json', passed: true, files: files.length });
  console.log(`PASS ${files.length}个TypeScript模块转换/语法及3个JSON配置检查（不是tsc类型检查）`);
} catch (error) { results.push({ script: 'syntax-and-json', passed: false, error: String(error) }); }
const leftovers = fs.readdirSync(process.cwd()).filter(name => /^\.(?:config-validation|pi-path-validation|workroot-validation|browser-isolation)-/u.test(name));
results.push({ script: 'temporary-directory-cleanup', passed: leftovers.length === 0, leftovers });
const report = { generatedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  result: results.every(item => item.passed) ? 'passed-with-unverified-integration' : 'failed', results,
  unverified: ['npm start/npm run dev真实入口', 'tsc与构建', '真实Pi SDK认证/模型调用/连接检查', 'SQLite旧版本升级及双应用持久恢复', '真实Vite监听代理及浏览器双页面/SSE', '真实Git worktree及授权UI'],
  method: '原生类型转换执行真实源码；测试HOME、内存业务记录及HTTP对象等替身已在各脚本说明；不等同完整应用集成测试' };
fs.writeFileSync('artifacts/validation-summary.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (results.some(item => !item.passed)) process.exitCode = 1;
