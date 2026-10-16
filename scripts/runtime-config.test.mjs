import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRuntimeConfig, runtimeEnvironment } from '../apps/server/src/runtime-config.ts';

const directory = mkdtempSync(join(process.cwd(), '.runtime-config-test-'));
const home = join(directory, 'home');
mkdirSync(home);
const resolve = (environment = {}, required) => resolveRuntimeConfig(environment, required, home);

try {
  await test('明确模式的默认目录与端口；NODE_ENV 不决定数据归属', () => {
    const production = resolve({ NODE_ENV: 'development' });
    const development = resolve({ MULTIVAC_MODE: 'development', NODE_ENV: 'production' });
    assert.equal(production.dataDir, join(home, '.multivac'));
    assert.equal(production.workRoot, join(home, 'Multivac'));
    assert.equal(production.port, 4317);
    assert.equal(production.cookieName, 'multivac_remote');
    assert.equal(development.dataDir, join(home, '.multivac-dev'));
    assert.equal(development.workRoot, join(home, 'Multivac-dev'));
    assert.equal(development.port, 4318);
    assert.notEqual(development.cookieName, production.cookieName);
    assert.equal(resolve({}, 'development').mode, 'development');
  });
  await test('显式配置覆盖默认值，同一有效配置传给子进程', () => {
    const input = { MULTIVAC_MODE: 'development', MULTIVAC_PORT: ' 4450 ',
      MULTIVAC_DATA_DIR: join(directory, 'data'), MULTIVAC_WORK_ROOT: join(directory, 'work') };
    const config = resolve(input);
    assert.equal(config.port, 4450);
    assert.equal(config.dataDir, input.MULTIVAC_DATA_DIR);
    const inherited = runtimeEnvironment(config, { UNRELATED_SETTING: 'retained' });
    assert.deepEqual(resolve(inherited), config);
    assert.equal(inherited.UNRELATED_SETTING, 'retained');
    assert.equal(resolve({ ...input, MULTIVAC_PORT: '4451' }).cookieName, config.cookieName);
    assert.notEqual(resolve({ ...input, MULTIVAC_DATA_DIR: join(directory, 'other') }).cookieName, config.cookieName);
  });
  await test('非法模式、入口冲突、无效端口与目录重叠均拒绝', () => {
    for (const value of ['test', 'dev', 'Production']) assert.throws(() => resolve({ MULTIVAC_MODE: value }));
    assert.throws(() => resolve({ MULTIVAC_MODE: 'production' }, 'development'), /冲突/u);
    assert.throws(() => resolve({ MULTIVAC_MODE: 'development' }, 'production'), /冲突/u);
    for (const value of ['4318suffix', '1.5', '-1', '0', '65536', '1e3', 'NaN']) {
      assert.throws(() => resolve({ MULTIVAC_PORT: value }), /整数/u);
    }
    assert.throws(() => resolve({ MULTIVAC_WORK_ROOT: 'relative' }), /绝对路径/u);
    assert.throws(() => resolve({ MULTIVAC_DATA_DIR: '/', MULTIVAC_WORK_ROOT: join(directory, 'work') }));
    assert.throws(() => resolve({ MULTIVAC_DATA_DIR: join(directory, 'data'), MULTIVAC_WORK_ROOT: join(directory, 'data', 'work') }), /互不包含/u);
    assert.throws(() => resolve({ MULTIVAC_MODE: 'development', MULTIVAC_PORT: '5173' }), /Vite/u);
    for (const protectedName of ['.multivac', 'Multivac', '.pi']) {
      for (const variable of ['MULTIVAC_DATA_DIR', 'MULTIVAC_WORK_ROOT']) {
        assert.throws(() => resolve({ MULTIVAC_MODE: 'development', [variable]: join(home, protectedName) }), /开发目录/u);
      }
    }
  });
  await test('真实路径和未创建路径的已有祖先也参与冲突校验', () => {
    mkdirSync(join(home, '.multivac'));
    symlinkSync(join(home, '.multivac'), join(directory, 'production-alias'));
    assert.throws(() => resolve({ MULTIVAC_MODE: 'development', MULTIVAC_DATA_DIR: join(directory, 'production-alias', 'new-data') }), /开发目录/u);
    writeFileSync(join(directory, 'file'), 'not a directory');
    assert.throws(() => resolve({ MULTIVAC_DATA_DIR: join(directory, 'file', 'data') }));
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
