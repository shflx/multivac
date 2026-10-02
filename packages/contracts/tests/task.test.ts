import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import { CreateTaskSchema, UpdateTaskSchema, TaskQuerySchema } from '../src/task.js';

test('任务命令只接受合法属性，不允许客户端直接写执行状态', () => {
  assert.equal(Check(CreateTaskSchema, { commandId: 'create-1', title: '目标', goal: '核对来源' }), true);
  assert.equal(Check(CreateTaskSchema, { commandId: 'c', title: '目标', goal: '核对', status: 'done' }), false);
  assert.equal(Check(UpdateTaskSchema, { commandId: 'u', revision: 1, patch: { title: '新目标' } }), true);
  assert.equal(Check(UpdateTaskSchema, { commandId: 'u', revision: 1, patch: { status: 'done' } }), false);
  assert.equal(Check(TaskQuerySchema, { limit: 101 }), false);
  assert.equal(Check(CreateTaskSchema, { commandId: 'c', title: '目标', goal: '核对', dependencyIds: ['a', 'a'] }), false);
});
