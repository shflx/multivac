import { loadSource, sourceJavaScript } from './source-loader.mjs';
const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');
const assert = process.getBuiltinModule('node:assert/strict');
const crypto = process.getBuiltinModule('node:crypto');
const root = fs.mkdtempSync(path.join(process.cwd(), '.pi-path-validation-'));
const home = path.join(root, 'home'); fs.mkdirSync(home);
const runtime = loadSource('apps/server/src/runtime-config.ts', { ...path, realpathSync: fs.realpathSync, homedir: () => home, createHash: crypto.createHash }, ['resolveRuntimeConfig', 'canonicalRuntimePath']);
const { resolvePiInstancePaths } = loadSource('apps/server/src/runtime/executors/pi-instance-paths.ts', { ...path, canonicalRuntimePath: runtime.canonicalRuntimePath }, ['resolvePiInstancePaths']);
const { resolveMultivacDataPaths } = loadSource('apps/server/src/storage/data-paths.ts', { ...path, mkdirSync: fs.mkdirSync, resolveRuntimeConfig: runtime.resolveRuntimeConfig }, ['resolveMultivacDataPaths']);
try {
  const production = runtime.resolveRuntimeConfig({ MULTIVAC_DATA_DIR: path.join(root, 'prod-data'), MULTIVAC_WORK_ROOT: path.join(root, 'prod-work') });
  const development = runtime.resolveRuntimeConfig({ MULTIVAC_MODE: 'development', MULTIVAC_DATA_DIR: path.join(root, 'dev-data'), MULTIVAC_WORK_ROOT: path.join(root, 'dev-work') });
  const legacy = path.join(root, 'legacy-pi');
  assert.equal(resolvePiInstancePaths(production, () => legacy).agentDir, legacy);
  const dev = resolvePiInstancePaths(development, () => { throw Error('global Pi queried'); });
  assert.equal(dev.authPath, path.join(development.dataDir, 'pi', 'auth.json'));
  assert.equal(dev.modelsStorePath, path.join(development.dataDir, 'pi', 'models-store.json'));
  const prodPaths = resolveMultivacDataPaths(production.dataDir);
  const devPaths = resolveMultivacDataPaths(development.dataDir);
  for (const [key, value] of Object.entries(devPaths)) {
    assert.ok(value.startsWith(development.dataDir)); assert.notEqual(value, prodPaths[key]);
  }
  fs.mkdirSync(legacy);
  fs.symlinkSync(legacy, path.join(development.dataDir, 'pi'));
  assert.throws(() => resolvePiInstancePaths(development, () => legacy), /不能链接/u);
  console.log('PASS Pi路径：生产保留历史、开发不查询全局、缓存同根、所有数据路径独立、拒绝Pi外部链接');
  const files = ['apps/server/src/bootstrap/application.ts', 'apps/server/src/runtime/executors/pi-coordinator-adapter.ts', 'apps/server/src/runtime/executors/pi-session-factory.ts', 'apps/server/src/runtime/executors/pi-model-access-backend.ts', 'apps/server/src/runtime/executors/pi-model-settings-catalog.ts'];
  // Function 无模块上下文；只在语法检查中将 import.meta 替换为同名形参，不执行应用。
  for (const file of files) new Function('importMeta', sourceJavaScript(file).replace(/\bimport\.meta\b/gu, 'importMeta'));
  console.log('PASS 5个修改模块原生TypeScript转换与JavaScript语法检查');
  console.log('未验证：真实SDK认证增删、模型调用、SQLite迁移；缺少依赖，不能用路径断言代替。');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
