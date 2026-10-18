import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ControlledGitChannel } from '../src/application/controlled-git-channel.js';
import { GitReadService, workingGitBoundary, type GitReadInput } from '../src/application/git-read-service.js';
import { MULTIVAC_INTERNAL_TOOLS, WORK_SESSION_TASK_TOOLS } from '../src/application/internal-tools/index.js';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

const exec = promisify(execFile);
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'multivac-git-read-'));
  const source = join(root, 'source'), worktree = join(root, 'feature');
  await mkdir(source);
  const git = async (directory: string, args: string[]) => (await exec('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-C', directory, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  })).stdout.trim();
  await git(source, ['init', '-b', 'main']);
  await writeFile(join(source, 'code.txt'), 'baseline\n');
  await git(source, ['add', 'code.txt']); await git(source, ['commit', '-m', 'baseline']);
  await git(source, ['worktree', 'add', '-b', 'feature/中文', worktree]);
  await writeFile(join(worktree, 'code.txt'), 'feature one\nfeature two\nfeature three\n');
  await writeFile(join(worktree, 'only.txt'), 'feature-only\n');
  await git(worktree, ['add', 'code.txt', 'only.txt']); await git(worktree, ['commit', '-m', 'feat: 分支内容']);
  await writeFile(join(worktree, 'only.txt'), 'other worktree dirty\n');
  await writeFile(join(source, 'code.txt'), 'staged\n'); await git(source, ['add', 'code.txt']);
  await writeFile(join(source, 'code.txt'), 'unstaged\n');
  const phases: string[] = [];
  let budget = 1024 * 1024;
  const channel = new ControlledGitChannel();
  const service = new GitReadService({ channel, boundary: () => workingGitBoundary(source, []), lease: (_id, phase) => { phases.push(phase); return budget; } });
  const query = async (input: GitReadInput) => JSON.parse(await service.read('session', input, signal()));
  return { root, source, worktree, git, channel, service, query, phases, setBudget: (value: number) => { budget = value; },
    close: async () => { await channel.dispose(); await rm(root, { recursive: true, force: true }); } };
}

const native = { skip: process.platform !== 'darwin' };
test('只读 Git 从分支对象读取历史、文件和差异，保留工作树、暂存区与所有引用', native, async () => {
  const f = await fixture();
  try {
    const index = await readFile(join(f.source, '.git', 'index'));
    const refs = await f.git(f.source, ['show-ref']);
    const head = await f.git(f.source, ['rev-parse', 'HEAD']);
    const branches = await f.query({ operation: 'branches', limit: 1 });
    assert.equal(branches.branches[0].name, 'feature/中文'); assert.equal(branches.hasMore, true);
    assert.equal((await f.query({ operation: 'branches', offset: 1, limit: 1 })).branches[0].name, 'main');
    const log = await f.query({ operation: 'log', ref: 'feature/中文', limit: 1 });
    assert.equal(log.commits[0].message, 'feat: 分支内容'); assert.equal(log.hasMore, true);
    assert.equal((await f.query({ operation: 'log', ref: 'feature/中文', offset: 1, limit: 1 })).commits[0].message, 'baseline');
    const file = await f.query({ operation: 'file', ref: 'feature/中文', path: 'code.txt', offset: 1, limit: 1 });
    assert.equal(file.content, 'feature two'); assert.equal(file.totalLines, 3); assert.equal(file.hasMore, true);
    assert.equal(file.commit, log.commit);
    assert.equal((await f.query({ operation: 'file', ref: log.commit, path: 'only.txt' })).content, 'feature-only');
    assert.equal((await f.query({ operation: 'file', path: 'code.txt' })).content, 'baseline');
    const diff = await f.query({ operation: 'diff', from: 'main', to: 'refs/heads/feature/中文', paths: ['code.txt'] });
    assert.match(diff.diff, /\+feature one/); assert.doesNotMatch(diff.diff, /only.txt|unstaged/);
    assert.match((await f.query({ operation: 'diff', from: 'main', to: 'feature/中文', statOnly: true })).diff, /2 files changed/);
    assert.equal((await f.query({ operation: 'diff', from: 'main' })).diff, '没有差异。');
    assert.deepEqual(await readFile(join(f.source, '.git', 'index')), index);
    assert.equal(await f.git(f.source, ['show-ref']), refs);
    assert.equal(await f.git(f.source, ['rev-parse', 'HEAD']), head);
    assert.equal(await readFile(join(f.source, 'code.txt'), 'utf8'), 'unstaged\n');
    assert.equal(await readFile(join(f.worktree, 'only.txt'), 'utf8'), 'other worktree dirty\n');
  } finally { await f.close(); }
});

test('只读 Git 支持当前目录是 linked worktree，不向上搜索仓库或跟随伪造指针', native, async () => {
  const f = await fixture();
  try {
    const reader = new GitReadService({ channel: f.channel, boundary: () => workingGitBoundary(f.worktree, []), lease: () => 1024 * 1024 });
    assert.equal(JSON.parse(await reader.read('session', { operation: 'file', ref: 'main', path: 'code.txt' }, signal())).content, 'baseline');
    const nested = join(f.source, 'nested'); await mkdir(nested);
    await assert.rejects(workingGitBoundary(nested, []), /不向上搜索/);
    await assert.rejects(workingGitBoundary(f.source, [f.source]), /受保护目录/);
    const pointer = await readFile(join(f.worktree, '.git'), 'utf8');
    await writeFile(join(f.worktree, '.git'), `gitdir: ${join(f.source, '.git')}\n`);
    await assert.rejects(workingGitBoundary(f.worktree, []));
    await writeFile(join(f.worktree, '.git'), pointer);
    const metadata = join(f.source, '.git', 'worktrees', 'feature', 'commondir');
    const common = await readFile(metadata, 'utf8');
    await writeFile(join(f.root, 'private-meta'), 'private canary');
    await rm(metadata); await symlink(join(f.root, 'private-meta'), metadata);
    await assert.rejects(workingGitBoundary(f.worktree, []), /不跟随符号链接/);
    await rm(metadata); await writeFile(metadata, common);
    await rm(join(f.worktree, '.git')); await symlink(join(f.source, '.git'), join(f.worktree, '.git'));
    await assert.rejects(workingGitBoundary(f.worktree, []), /符号链接/);
  } finally { await f.close(); }
});

test('只读 Git 拒绝命令、修订表达式、越界路径、目录、历史符号链接和超限文件', native, async () => {
  const f = await fixture();
  try {
    for (const operation of ['fetch', 'checkout', 'commit']) await assert.rejects(f.service.read('session', { operation } as GitReadInput, signal()), /操作与参数/);
    for (const ref of ['HEAD~1', 'HEAD:code.txt', 'refs/remotes/origin/main', '--upload-pack=/tmp/evil', 'main\n--stat']) await assert.rejects(f.query({ operation: 'log', ref }));
    for (const path of ['../private', '/etc/passwd', '.git/config', 'a/../../private']) await assert.rejects(f.query({ operation: 'file', path }), /安全相对路径/);
    await assert.rejects(f.query({ operation: 'file', path: 'missing.txt' }), /常规文件/);
    await assert.rejects(f.query({ operation: 'log', limit: 101 }), /分页/);
    await assert.rejects(f.query({ operation: 'file', path: 'code.txt', from: 'main' }), /操作与参数/);
    await writeFile(join(f.root, 'private'), 'private canary\n');
    await symlink(join(f.root, 'private'), join(f.worktree, 'escape'));
    await writeFile(join(f.worktree, 'binary'), Buffer.from([0, 255, 1]));
    await writeFile(join(f.worktree, 'large'), 'x'.repeat(769 * 1024));
    await f.git(f.worktree, ['add', 'escape', 'binary', 'large']); await f.git(f.worktree, ['commit', '-m', 'test: 读取边界']);
    await assert.rejects(f.query({ operation: 'file', ref: 'feature/中文', path: 'escape' }), /符号链接/);
    await assert.rejects(f.query({ operation: 'file', ref: 'feature/中文', path: 'binary' }), /UTF-8/);
    await assert.rejects(f.query({ operation: 'file', ref: 'feature/中文', path: 'large' }), /768 KiB/);
  } finally { await f.close(); }
});

test('只读 Git 禁用外部 diff 与配置越界，不继承 Git 环境', native, async () => {
  const f = await fixture();
  const old = process.env.GIT_TRACE;
  process.env.GIT_TRACE = join(f.source, 'trace-canary');
  try {
    const marker = join(f.source, 'external-canary');
    await f.git(f.source, ['config', 'diff.external', `/usr/bin/touch '${marker}'`]);
    assert.match((await f.query({ operation: 'diff', from: 'main', to: 'feature/中文' })).diff, /feature one/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    await assert.rejects(readFile(join(f.source, 'trace-canary')), { code: 'ENOENT' });
    const outside = join(f.root, 'private-config');
    await writeFile(outside, '[filter "private-canary"]\n clean = /usr/bin/false\n');
    await f.git(f.source, ['config', 'include.path', outside]);
    await assert.rejects(f.query({ operation: 'branches' }), error => {
      assert.match((error as Error).message, /Operation not permitted/); assert.doesNotMatch((error as Error).message, /private-canary/); return true;
    });
  } finally { if (old === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = old; await f.close(); }
});

test('只读通道在操作系统层拒绝写入，不创建索引锁或修改分支', native, async () => {
  const f = await fixture();
  try {
    const refs = await f.git(f.source, ['show-ref']);
    await assert.rejects(f.channel.run('session', signal(), { readOnly: true, boundary: () => workingGitBoundary(f.source, []), lease: () => 1024 * 1024 }, git => git(['update-ref', 'refs/heads/not-allowed', 'HEAD'])), /Operation not permitted|Permission denied/);
    assert.equal(await f.git(f.source, ['show-ref']), refs);
    await assert.rejects(readFile(join(f.source, '.git', 'index.lock')), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('输出超限、取消和工作目录变化会终止只读 Git 并结算租约', native, async () => {
  const f = await fixture();
  try {
    f.setBudget(30);
    await assert.rejects(f.query({ operation: 'branches' }), /输出超过当前额度/);
    assert.deepEqual(f.phases, ['starting', 'settled']);
    f.setBudget(1024 * 1024);
    const controller = new AbortController();
    const timer = setInterval(() => { if (!f.channel.processesStopped('session')) controller.abort(); }, 1);
    try { await assert.rejects(f.service.read('session', { operation: 'branches' }, controller.signal), { name: 'AbortError' }); }
    finally { clearInterval(timer); }
    assert.equal(f.channel.processesStopped('session'), true);
    assert.deepEqual(f.phases.slice(-2), ['starting', 'settled']);
    let calls = 0;
    const moving = new GitReadService({ channel: f.channel, lease: () => 1024 * 1024, boundary: () => workingGitBoundary(++calls === 1 ? f.source : f.worktree, []) });
    await assert.rejects(moving.read('session', { operation: 'branches' }, signal()), /边界已失效/);
  } finally { await f.close(); }
});

test('应用为普通工作会话注入 read_git，实际读取其他分支，提交工具仍只属于任务', native, async () => {
  const f = await fixture();
  const environment = testApplicationEnvironment(f.root);
  const seed = new SqliteAssistantStore(join(environment.MULTIVAC_DATA_DIR!, 'multivac.sqlite'));
  seed.sessions.insertIfAbsent({ sessionId: 'git-work', title: '分支核对', kind: 'work', workspaceId: 'default', createdAt: new Date().toISOString(), workingDirectory: { kind: 'project-mounted', path: f.source } });
  seed.close();
  const adapter = new FakeCoordinatorAdapter();
  const app = createMultivacApplication({ ...environment, MULTIVAC_COORDINATOR_ADAPTER: 'fake' }, { coordinatorAdapter: adapter });
  try {
    await app.ready;
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const port = (app.server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/git-work/page-state`);
    assert.equal(response.status, 200, await response.text());
    const creation = adapter.calls.find(call => call.method === 'createSession' && call.input.assistantSessionId === 'git-work');
    assert.ok(creation?.method === 'createSession');
    const tools = creation.input.internalTools!;
    assert.equal(tools.specs.some(spec => spec.name === 'read_git'), true);
    assert.equal(tools.specs.some(spec => ['inspect_task_git', 'commit_task_code'].includes(spec.name)), false);
    assert.equal(MULTIVAC_INTERNAL_TOOLS.some(tool => tool.name === 'read_git'), false);
    assert.equal(WORK_SESSION_TASK_TOOLS.find(tool => tool.name === 'read_git')?.effect, 'query');
    const result = await tools.invoke({ assistantSessionId: 'git-work', toolName: 'read_git', toolCallId: 'read-other-branch', args: { operation: 'file', ref: 'feature/中文', path: 'only.txt' } }, signal());
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) assert.equal(JSON.parse(result.content).content, 'feature-only');
    const unknown = await tools.invoke({ assistantSessionId: 'git-work', toolName: 'read_git', toolCallId: 'arbitrary-command', args: { operation: 'fetch' } }, signal());
    assert.equal(unknown.ok, false);
  } finally { await new Promise<void>((resolve, reject) => app.server.close(error => error ? reject(error) : resolve())); await app.close(); await f.close(); }
});


test('服务关闭等待 Git 子进程退出及租约结算，之后拒绝新查询', native, async () => {
  const f = await fixture();
  try {
    let entered!: () => void;
    const live = new Promise<void>(resolve => { entered = resolve; });
    const timer = setInterval(() => { if (!f.channel.processesStopped('session')) entered(); }, 1);
    const read = assert.rejects(f.service.read('session', { operation: 'branches' }, signal()), /已停止|未成功/);
    try { await live; await f.channel.dispose(); await read; }
    finally { clearInterval(timer); }
    assert.equal(f.channel.processesStopped('session'), true);
    assert.equal(f.channel.hasOperations, false);
    assert.deepEqual(f.phases, ['starting', 'settled']);
    await assert.rejects(f.query({ operation: 'branches' }), /通道已停止/);
  } finally { await f.close(); }
});


test('异步边界读取期间关闭通道，不再启动 Git 或执行查询动作', native, async () => {
  const f = await fixture();
  try {
    const boundary = await workingGitBoundary(f.source, []);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0, executed = false;
    const operation = assert.rejects(f.channel.run('session', signal(), {
      readOnly: true, lease: () => 1024 * 1024,
      boundary: async () => { if (++calls === 2) { entered(); await gate; } return boundary; },
    }, async () => { executed = true; }), /通道已停止/);
    await waiting;
    const closing = f.channel.dispose();
    release(); await closing; await operation;
    assert.equal(executed, false);
    assert.equal(f.channel.hasOperations, false);
  } finally { await f.close(); }
});
