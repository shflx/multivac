import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MULTIVAC_PORT,
  optionalEnvironmentValue,
  resolveServerPort,
  resolveToolAuthorizationTimeoutMs,
} from '../src/environment.js';

test('空环境变量使用可运行默认值', () => {
  assert.equal(resolveServerPort(undefined), DEFAULT_MULTIVAC_PORT);
  assert.equal(resolveServerPort(''), DEFAULT_MULTIVAC_PORT);
  assert.equal(resolveServerPort('   '), DEFAULT_MULTIVAC_PORT);
  assert.equal(optionalEnvironmentValue(''), undefined);
  assert.equal(optionalEnvironmentValue(' medium '), 'medium');
});

test('授权等待时限未设置时用默认值，只接受正整数毫秒', () => {
  assert.equal(resolveToolAuthorizationTimeoutMs(undefined), undefined);
  assert.equal(resolveToolAuthorizationTimeoutMs('  '), undefined);
  assert.equal(resolveToolAuthorizationTimeoutMs(' 1500 '), 1500);
  for (const value of ['0', '-1', '1.5', '30m', '1e3']) {
    assert.throws(() => resolveToolAuthorizationTimeoutMs(value), /正整数/u, value);
  }
});
