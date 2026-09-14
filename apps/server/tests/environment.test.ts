import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MULTIVAC_PORT,
  optionalEnvironmentValue,
  resolveServerPort,
} from '../src/environment.js';

test('空环境变量使用可运行默认值', () => {
  assert.equal(resolveServerPort(undefined), DEFAULT_MULTIVAC_PORT);
  assert.equal(resolveServerPort(''), DEFAULT_MULTIVAC_PORT);
  assert.equal(resolveServerPort('   '), DEFAULT_MULTIVAC_PORT);
  assert.equal(optionalEnvironmentValue(''), undefined);
  assert.equal(optionalEnvironmentValue(' medium '), 'medium');
});
