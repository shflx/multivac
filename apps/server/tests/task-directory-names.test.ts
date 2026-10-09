import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { taskBranchName, taskDirectoryName } from '../src/application/task-directory-names.js';

const exec = promisify(execFile);

test('任务名称保留可读标题，同名任务与不同执行保留独立且稳定的身份', async () => {
  const task = { taskId: 'task-a', title: '修复运行日志展示' };
  const name = taskDirectoryName(task, 'run-a');
  assert.match(name, /^修复运行日志展示-[a-f0-9]{20}$/u);
  assert.equal(taskDirectoryName(task, 'run-a'), name);
  assert.notEqual(taskDirectoryName({ ...task, taskId: 'task-b' }, 'run-a'), name);
  assert.notEqual(taskDirectoryName(task, 'run-b'), name);
  assert.equal(taskBranchName(name), `multivac-task-${name}`);
  await exec('git', ['check-ref-format', '--branch', taskBranchName(name)!]);
});

test('特殊标题、纯符号、Unicode 和长标题生成合法有界的目录及 Git 分支', async () => {
  for (const title of ['Fix UI / Logs .. @{draft} [x] ~ ^ : ? * \\', '... .lock', '💡 !!!', 'İ'.repeat(100), '修复日志'.repeat(100), 'Café 日志展示', 'Cafe\u0301 日志展示']) {
    const name = taskDirectoryName({ taskId: 'task', title }, 'run');
    assert.ok(Buffer.byteLength(name) < 200);
    assert.doesNotMatch(name, /[.\s/\\@{}\[\]~^:?*]/u);
    assert.ok(taskBranchName(name));
    await exec('git', ['check-ref-format', '--branch', taskBranchName(name)!]);
  }
  assert.match(taskDirectoryName({ taskId: 'task', title: '💡 !!!' }, 'run'), /^task-/);
  assert.equal(taskDirectoryName({ taskId: 'task', title: 'Café' }, 'run'), taskDirectoryName({ taskId: 'task', title: 'Cafe\u0301' }, 'run'));
});

test('旧目录保持原分支映射，伪造、越界和不规范名称拒绝匹配', () => {
  const legacy = 'a'.repeat(64);
  assert.equal(taskBranchName(legacy), `multivac-task-${legacy.slice(0, 20)}`);
  for (const name of ['../escape', 'other', 'a'.repeat(63), `../task-${'a'.repeat(20)}`, `fix..logs-${'a'.repeat(20)}`, `FIX-${'a'.repeat(20)}`, `${'x'.repeat(41)}-${'a'.repeat(20)}`]) {
    assert.equal(taskBranchName(name), null);
  }
});
