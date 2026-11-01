import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import type { Project, Task } from '@multivac/contracts';
import { createPlatformCapabilities } from '../src/runtime/platform-capabilities.js';
import { TaskWorkingDirectories } from '../src/application/task-working-directories.js';
import { gitEnvironment, gitNullDevice } from '../src/application/git-platform.js';
import { describeNodeDependencies } from '../src/application/task-node-dependencies.js';
import { renderTaskExecutionPrompt } from '../src/application/task-execution-prompt.js';
import { taskProcessAlive } from '../src/application/task-scheduler.js';

test('Windows 已退出 PID 不会长期占用任务调度权', { skip: process.platform !== 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await once(child, 'exit');
  assert.equal(taskProcessAlive(process.pid), true);
  assert.equal(taskProcessAlive(child.pid!), false);
});

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

test('Windows 实机 Git worktree 固定基线并保留脏来源，工作树内可提交', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-win-git-task-'));
  const source = join(root, 'source');
  const git = (cwd: string, ...args: string[]) => execFileSync('git.exe', args, { cwd, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0' } }).trim();
  try {
    await mkdir(source);
    git(root, 'init', '-b', 'main', source);
    await writeFile(join(source, 'value.txt'), 'baseline\n');
    git(source, 'add', 'value.txt');
    git(source, '-c', 'user.name=Multivac', '-c', 'user.email=multivac@localhost', 'commit', '-m', 'baseline');
    const baseline = git(source, 'rev-parse', 'HEAD');
    await writeFile(join(source, 'value.txt'), 'dirty source\n');
    const capabilities = { platform: 'win32' as const, arch: 'x64', denial: () => null };
    const directories = new TaskWorkingDirectories(root, () => ({ directories: [{ path: source }] }) as Project, [], capabilities);
    const prepared = await directories.prepare({ taskId: 'task', title: 'Windows task', projectId: 'project' } as Task, 'run', new AbortController().signal);
    assert.equal(prepared.directory.kind, 'worktree'); assert.equal(prepared.baseline, baseline);
    assert.equal(git(prepared.directory.path, 'rev-parse', 'HEAD'), baseline);
    assert.equal(await readFile(join(prepared.directory.path, 'value.txt'), 'utf8'), 'baseline\n');
    assert.equal(await readFile(join(source, 'value.txt'), 'utf8'), 'dirty source\n');
    await writeFile(join(prepared.directory.path, 'value.txt'), 'task result\n');
    git(prepared.directory.path, 'add', 'value.txt');
    git(prepared.directory.path, '-c', 'user.name=Multivac', '-c', 'user.email=multivac@localhost', 'commit', '-m', 'task result');
    assert.equal(await readFile(join(source, 'value.txt'), 'utf8'), 'dirty source\n');
    assert.notEqual(git(prepared.directory.path, 'rev-parse', 'HEAD'), baseline);
  } finally { await rm(root, { recursive: true, force: true }); }
});
