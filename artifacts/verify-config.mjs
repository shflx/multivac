// 受控环境无依赖；擦除真实源码的类型，仅注入测试 HOME，避免访问用户目录。
const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');
const assert = process.getBuiltinModule('node:assert/strict');
const { stripTypeScriptTypes } = process.getBuiltinModule('node:module');
const root = fs.mkdtempSync(path.join(process.cwd(), '.config-validation-'));
const home = path.join(root, 'home');
fs.mkdirSync(home);
const source = fs.readFileSync('apps/server/src/runtime-config.ts', 'utf8');
const javascript = stripTypeScriptTypes(source).replace(/^import .*;\n/gmu, '').replace(/\bexport /gu, '');
const names = ['lstatSync', 'realpathSync', 'homedir', 'dirname', 'isAbsolute', 'join', 'relative', 'resolve', 'sep', 'createHash'];
const values = [fs.lstatSync, fs.realpathSync, () => home, path.dirname, path.isAbsolute, path.join, path.relative, path.resolve, path.sep, process.getBuiltinModule('node:crypto').createHash];
const { resolveRuntimeConfig, runtimeEnvironment } = new Function(...names, `${javascript}\nreturn {resolveRuntimeConfig,runtimeEnvironment};`)(...values);
const resolve = (environment = {}, required) => resolveRuntimeConfig(environment, required, home);
let checks = 0;
function check(label, action) { action(); checks++; console.log('PASS', label); }
try {
  check('production兼容默认值且不依赖NODE_ENV', () => {
    const value = resolve({ NODE_ENV: 'development' });
    assert.equal(value.port, 4317); assert.equal(value.dataDir, path.join(home, '.multivac'));
    assert.equal(value.workRoot, path.join(home, 'Multivac')); assert.equal(value.cookieName, 'multivac_remote');
  });
  check('development默认独立目录、端口和Cookie', () => {
    const value = resolve({}, 'development');
    assert.equal(value.port, 4318); assert.equal(value.dataDir, path.join(home, '.multivac-dev'));
    assert.equal(value.workRoot, path.join(home, 'Multivac-dev')); assert.notEqual(value.cookieName, resolve().cookieName);
  });
  const input = { MULTIVAC_MODE: 'development', MULTIVAC_DATA_DIR: path.join(root, 'data'), MULTIVAC_WORK_ROOT: path.join(root, 'work'), MULTIVAC_PORT: ' 4450 ' };
  check('显式配置与子进程继承一致', () => {
    const value = resolve(input); assert.equal(value.port, 4450);
    assert.deepEqual(resolve(runtimeEnvironment(value, {})), value);
    assert.equal(resolve({ ...input, MULTIVAC_PORT: '4451' }).cookieName, value.cookieName);
    assert.notEqual(resolve({ ...input, MULTIVAC_DATA_DIR: path.join(root, 'other') }).cookieName, value.cookieName);
  });
  for (const mode of ['dev', 'test', 'Production']) check(`拒绝模式 ${mode}`, () => assert.throws(() => resolve({ MULTIVAC_MODE: mode })));
  check('拒绝入口模式冲突', () => assert.throws(() => resolve({ MULTIVAC_MODE: 'production' }, 'development')));
  for (const port of ['4318tail', '-1', '0', '65536', '1.5', '1e3']) check(`拒绝端口 ${port}`, () => assert.throws(() => resolve({ MULTIVAC_PORT: port })));
  check('拒绝Vite端口冲突', () => assert.throws(() => resolve({ MULTIVAC_MODE: 'development', MULTIVAC_PORT: '5173' })));
  check('拒绝相对工作根', () => assert.throws(() => resolve({ MULTIVAC_WORK_ROOT: 'relative' })));
  check('拒绝包含路径', () => assert.throws(() => resolve({ MULTIVAC_DATA_DIR: root, MULTIVAC_WORK_ROOT: path.join(root, 'work') })));
  for (const name of ['.multivac', 'Multivac', '.pi']) check(`拒绝开发复用 ${name}`, () => assert.throws(() => resolve({ MULTIVAC_MODE: 'development', MULTIVAC_DATA_DIR: path.join(home, name) })));
  fs.mkdirSync(path.join(home, '.multivac'));
  fs.symlinkSync(path.join(home, '.multivac'), path.join(root, 'alias'));
  check('拒绝符号链接指向生产及其未创建子目录', () => assert.throws(() => resolve({ MULTIVAC_MODE: 'development', MULTIVAC_DATA_DIR: path.join(root, 'alias', 'new') })));
  fs.symlinkSync(path.join(root, 'missing'), path.join(root, 'dangling'));
  check('拒绝悬空链接目录', () => assert.throws(() => resolve({ ...input, MULTIVAC_DATA_DIR: path.join(root, 'dangling', 'new') }), /无法解析/u));
  console.log(JSON.stringify({ result: 'passed', checks, node: process.version, limitation: '源码类型擦除，测试HOME注入；未运行npm入口' }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
