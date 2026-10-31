import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Task } from '@multivac/contracts';
import { createPlatformCapabilities } from '../src/runtime/platform-capabilities.js';
import { TaskWorkingDirectories } from '../src/application/task-working-directories.js';
import { gitEnvironment, gitNullDevice } from '../src/application/git-platform.js';
import { describeNodeDependencies } from '../src/application/task-node-dependencies.js';
import { renderTaskExecutionPrompt } from '../src/application/task-execution-prompt.js';

test('Windows 新任务在创建目录、分支或读取项目来源前拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-win-task-'));
  try {
    let queried = false;
    const directories = new TaskWorkingDirectories(root, () => { queried = true; throw new Error(); }, [], createPlatformCapabilities({ platform: 'win32', arch: 'x64' }));
    await assert.rejects(directories.prepare({ taskId: 'task', title: 'task', projectId: 'p' } as Task, 'run', new AbortController().signal), /实机验证/);
    assert.equal(queried, false); assert.deepEqual(await readdir(root), []);
    await writeFile(join(root, 'package-lock.json'), '{}');
    assert.match((await describeNodeDependencies(root, 'win32'))!, /不使用 APFS 克隆/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('Git for Windows 使用本机环境与凭据配置，不传模型秘密，工作目录不读全局 Git 配置', () => {
  const source = { Path: 'C:\\Git\\cmd', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me', HOME: 'C:\\Users\\me', OPENAI_API_KEY: 'secret' };
  assert.equal(gitNullDevice('win32'), 'NUL');
  const working = gitEnvironment('win32', source, 'worktree', 'C:\\tasks');
  assert.equal(working.HOME, 'C:\\tasks'); assert.equal(working.USERPROFILE, 'C:\\tasks'); assert.equal(working.GIT_CONFIG_GLOBAL, 'NUL');
  assert.equal(working.OPENAI_API_KEY, undefined); assert.equal(working.Path, source.Path);
  const publishing = gitEnvironment('win32', source, 'publish');
  assert.equal(publishing.USERPROFILE, source.USERPROFILE); assert.equal(publishing.GIT_CONFIG_GLOBAL, undefined);
  assert.equal(publishing.GCM_INTERACTIVE, 'Never'); assert.equal(publishing.GIT_TERMINAL_PROMPT, '0');
});
test('Windows 初始和继续提示词声明实际解释器，保留目录、批准及恢复要求', () => {
  const task = { taskId: 'task', title: 'title', goal: 'goal', scope: '', acceptanceCriteria: '', feedback: null, acceptance: true };
  for (const resumed of [false, true]) {
    const prompt = renderTaskExecutionPrompt(task, { childCount: 0, resumed, platform: 'win32' });
    assert.match(prompt, /Windows PowerShell 5.1/); assert.match(prompt, /npm.cmd/);
    assert.match(prompt, /结果未知先核对|未知结果先只读对账|未知工具结果先只读对账/);
    assert.match(prompt, /外发仍须真实用户许可/);
  }
});
