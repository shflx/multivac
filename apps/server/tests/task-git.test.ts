import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TaskGitService } from '../src/application/task-git-service.js';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

const exec = promisify(execFile);
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-git-'));
  const source = join(root, 'source'), workRoot = join(root, 'work');
  await mkdir(source); await mkdir(join(workRoot, 'tasks'), { recursive: true });
  const git = async (directory: string, args: string[]) => (await exec('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-C', directory, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  })).stdout.trim();
  await git(source, ['init', '-b', 'main']);
  await writeFile(join(source, 'code.txt'), 'baseline\n');
  await writeFile(join(source, 'other.txt'), 'other baseline\n');
  await git(source, ['add', '.']); await git(source, ['commit', '-m', 'baseline']);
  const baseline = await git(source, ['rev-parse', 'HEAD']);
  const name = createHash('sha256').update('task:original-run').digest('hex');
  const directory = join(workRoot, 'tasks', name);
  const branch = `multivac-task-${name.slice(0, 20)}`;
  await git(source, ['worktree', 'add', '-b', branch, directory, baseline]);
  const runId = 'resumed-run';
  let active = true, allowance = 1024 * 1024;
  const phases: string[] = [];
  const service = new TaskGitService({ workRoot,
    source: () => { if (!active) throw new Error('lease-invalid'); return { runId, directory, sourceDirectory: source }; },
    lease: (_id, phase) => { phases.push(phase); return allowance; },
  });
  return { root, source, directory, branch, baseline, service, phases, git,
    stop: () => { active = false; }, smallBudget: () => { allowance = 30; }, restoreBudget: () => { allowance = 1024 * 1024; },
    close: () => rm(root, { recursive: true, force: true }) };
}

test('真实受控 Git 可查看并提交恢复后的任务 worktree，主分支与无关暂存内容保持原样', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'code.txt'), 'task change\n');
    await writeFile(join(f.directory, 'new.txt'), 'new file\n');
    await writeFile(join(f.directory, 'other.txt'), 'unrelated staged\n');
    await f.git(f.directory, ['add', 'other.txt']);
    const state = await f.service.inspect('session', {}, signal());
    assert.match(state, /task change/); assert.match(state, /new.txt/);
    const staged = await f.service.inspect('session', { staged: true }, signal());
    assert.match(staged, /unrelated staged/);
    const result = await f.service.commit('session', { paths: ['code.txt', 'new.txt'], message: 'fix: 修复任务代码\n\n保留无关暂存内容。' }, signal());
    const sha = await f.git(f.directory, ['rev-parse', 'HEAD']);
    assert.match(result, new RegExp(sha)); assert.notEqual(sha, f.baseline);
    assert.equal(await f.git(f.source, ['rev-parse', 'HEAD']), f.baseline);
    assert.equal(await f.git(f.directory, ['show', 'HEAD:other.txt']), 'other baseline');
    assert.equal(await f.git(f.directory, ['show', 'HEAD:new.txt']), 'new file');
    assert.equal(await f.git(f.directory, ['diff', '--cached', '--name-only']), 'other.txt');
    assert.equal(await f.git(f.directory, ['show', '-s', '--format=%an <%ae>', 'HEAD']), 'Multivac <multivac@localhost>');
    await rm(join(f.directory, 'new.txt'));
    await f.service.commit('session', { paths: ['new.txt'], message: 'fix: 提交文件删除' }, signal());
    assert.equal(await f.git(f.directory, ['ls-tree', '--name-only', 'HEAD', 'new.txt']), '');
    assert.equal(await f.git(f.directory, ['diff', '--cached', '--name-only']), 'other.txt');
    assert.deepEqual(f.phases, Array.from({ length: 4 }, () => ['starting', 'settled']).flat());
  } finally { await f.close(); }
});

test('真实受控 Git 不执行 hooks、签名、外部过滤器或 diff 命令', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture();
  try {
    const marker = join(f.directory, 'external-executed');
    const hooks = join(f.directory, 'hooks'); await mkdir(hooks);
    for (const hook of ['pre-commit', 'post-commit', 'prepare-commit-msg', 'commit-msg']) await writeFile(join(hooks, hook), `#!/bin/sh\n/usr/bin/touch '${marker}'\n`, { mode: 0o755 });
    await f.git(f.source, ['config', 'core.hooksPath', hooks]);
    await f.git(f.source, ['config', 'commit.gpgSign', 'true']);
    await f.git(f.source, ['config', 'gpg.program', '/nonexistent/task-gpg']);
    await f.git(f.source, ['config', 'filter.danger.clean', `/usr/bin/touch '${marker}'`]);
    await f.git(f.source, ['config', 'filter.danger.process', `/usr/bin/touch '${marker}'`]);
    await f.git(f.source, ['config', 'filter.danger.required', 'true']);
    await f.git(f.source, ['config', 'diff.danger.textconv', `/usr/bin/touch '${marker}'`]);
    await f.git(f.source, ['config', 'diff.external', `/usr/bin/touch '${marker}'`]);
    await writeFile(join(f.directory, '.gitattributes'), 'code.txt filter=danger diff=danger\n');
    await writeFile(join(f.directory, 'code.txt'), 'safe content\n');
    assert.match(await f.service.inspect('session', {}, signal()), /safe content/);
    await f.service.commit('session', { paths: ['code.txt', '.gitattributes'], message: 'fix: 安全提交' }, signal());
    assert.equal(await f.git(f.directory, ['show', 'HEAD:code.txt']), 'safe content');
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('真实受控 Git 拒绝越界路径、符号链接、篡改的仓库指针和非任务分支', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture();
  try {
    for (const path of ['../source/code.txt', '/etc/passwd', '.git', '.', 'hooks/../code.txt']) {
      await assert.rejects(f.service.commit('session', { paths: [path], message: 'fix: blocked' }, signal()), /相对文件路径/);
    }
    await symlink(f.source, join(f.directory, 'escape'));
    await assert.rejects(f.service.commit('session', { paths: ['escape/code.txt'], message: 'fix: blocked' }, signal()), /符号链接/);
    const pointer = await readFile(join(f.directory, '.git'), 'utf8');
    await rm(join(f.directory, '.git'));
    await symlink(join(f.source, '.git', 'config'), join(f.directory, '.git'));
    await assert.rejects(f.service.inspect('session', {}, signal()), /Git 指针无效/);
    await rm(join(f.directory, '.git'));
    await writeFile(join(f.directory, '.git'), `gitdir: ${join(f.source, '.git')}\n`);
    await assert.rejects(f.service.inspect('session', {}, signal()), /关联发生变化/);
    await writeFile(join(f.directory, '.git'), pointer);
    await f.git(f.directory, ['checkout', '-b', 'unrelated']);
    await assert.rejects(f.service.inspect('session', {}, signal()), /任务分支发生变化/);
    assert.equal(await f.git(f.source, ['rev-parse', 'HEAD']), f.baseline);
    assert.equal(f.phases.filter(p => p === 'starting').length, f.phases.filter(p => p === 'settled').length);
  } finally { await f.close(); }
});

test('真实受控 Git 不继承服务端 Git 环境，并在输出额度耗尽或取消时结算租约', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture();
  const old = process.env.GIT_TRACE;
  process.env.GIT_TRACE = join(f.directory, 'inherited-trace');
  try {
    await f.service.inspect('session', {}, signal());
    await assert.rejects(readFile(join(f.directory, 'inherited-trace')), { code: 'ENOENT' });
    await writeFile(join(f.directory, 'code.txt'), 'large change\n'.repeat(1000));
    f.smallBudget();
    await assert.rejects(f.service.inspect('session', {}, signal()), /输出超过当前额度/);
    assert.deepEqual(f.phases, ['starting', 'settled', 'starting', 'settled']);
    f.restoreBudget();
    const controller = new AbortController();
    let abortedLiveChild = false;
    const poll = setInterval(() => {
      if (!f.service.processesStopped('session')) { abortedLiveChild = true; controller.abort(); }
    }, 1);
    try { await assert.rejects(f.service.inspect('session', {}, controller.signal), { name: 'AbortError' }); }
    finally { clearInterval(poll); }
    assert.equal(abortedLiveChild, true);
    assert.equal(f.service.processesStopped('session'), true);
    assert.deepEqual(f.phases.slice(-2), ['starting', 'settled']);
    f.stop();
    await assert.rejects(f.service.commit('session', { paths: ['code.txt'], message: 'fix: blocked' }, signal()), /lease-invalid/);
    assert.equal(await f.git(f.directory, ['rev-parse', 'HEAD']), f.baseline);
  } finally {
    if (old === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = old;
    await f.close();
  }
});

test('任务会话实际注入受控 Git：真实提交记入共享额度，重放不重复提交，暂停后拒绝执行', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture();
  const environment = testApplicationEnvironment(f.root);
  const seed = new SqliteAssistantStore(join(environment.MULTIVAC_DATA_DIR!, 'multivac.sqlite'));
  seed.createProject({ projectId: 'project', name: '测试仓库', directories: [{ kind: 'mounted', path: f.source }], defaultConstraints: '', createdAt: new Date().toISOString() });
  seed.close();
  const adapter = new FakeCoordinatorAdapter();
  const app = createMultivacApplication({ ...environment, MULTIVAC_COORDINATOR_ADAPTER: 'fake' }, { coordinatorAdapter: adapter });
  try {
    await app.ready;
    const task = app.tasks.create({ commandId: 'create', projectId: 'project', title: '提交代码', goal: '修改并提交 code.txt' }).task;
    adapter.armPromptCompletionBarrier();
    await app.taskExecution.control(task.taskId, { commandId: 'start', revision: task.revision, action: 'start' });
    await adapter.waitForPromptCompletionBarrierEntry();
    const run = app.tasks.detail(task.taskId).runs![0]!;
    const created = adapter.calls.find(call => call.method === 'createSession' && call.input.assistantSessionId === run.sessionId);
    assert.ok(created?.method === 'createSession');
    const tools = created.input.internalTools!;
    const invoke = (toolName: string, toolCallId: string, args: unknown) => tools.invoke({ assistantSessionId: run.sessionId, toolName, toolCallId, args }, signal());
    await writeFile(join(run.directory!.path, 'code.txt'), 'integration change\n');
    assert.equal((await invoke('inspect_task_git', 'inspect', {})).ok, true);
    const args = { paths: ['code.txt'], message: 'fix: 集成提交' };
    const committed = await invoke('commit_task_code', 'commit', args);
    assert.equal(committed.ok, true, JSON.stringify(committed));
    assert.deepEqual(await invoke('commit_task_code', 'commit', args), committed);
    assert.equal(await f.git(run.directory!.path, ['rev-list', '--count', 'HEAD']), '2');
    assert.equal(await f.git(f.source, ['rev-parse', 'HEAD']), f.baseline);
    const accounted = app.tasks.detail(task.taskId).runs![0]!;
    assert.ok(accounted.outputBytes! > 0);
    assert.deepEqual(accounted.nativePendingIds, []);
    const pause = app.taskExecution.control(task.taskId, { commandId: 'pause', revision: app.tasks.get(task.taskId).revision, action: 'pause' });
    adapter.releasePromptCompletionBarrier();
    await pause;
    assert.equal(app.tasks.detail(task.taskId).runs![0]!.stopConfirmed, true);
    const blocked = await invoke('commit_task_code', 'after-pause', args);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.match(blocked.reason, /已停止|变化/);
    assert.equal(await f.git(run.directory!.path, ['rev-list', '--count', 'HEAD']), '2');
  } finally { adapter.releasePromptCompletionBarrier(); await app.taskExecution.idle(); app.close(); await f.close(); }
});

test('真实受控 Git 拒绝通过仓库 include 配置读取元数据范围之外的文件', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, 'private-config');
    await writeFile(outside, '[filter "private-canary"]\n clean = /usr/bin/false\n');
    await f.git(f.source, ['config', 'include.path', outside]);
    await assert.rejects(f.service.inspect('session', {}, signal()), error => {
      assert.match((error as Error).message, /Operation not permitted/);
      assert.doesNotMatch((error as Error).message, /private-canary/);
      return true;
    });
    assert.deepEqual(f.phases, ['starting', 'settled']);
    assert.equal(await f.git(f.source, ['rev-parse', 'HEAD']), f.baseline);
  } finally { await f.close(); }
});
