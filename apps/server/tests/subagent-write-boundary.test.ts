import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SqliteSubagentRepository, SUBAGENT_MIGRATION } from '../src/storage/sqlite-subagent-repository.js';
import { SubagentWriteCoordinator } from '../src/application/subagent-write-coordinator.js';
import { createBoundaryFileTools, judgeToolCall } from '../src/runtime/executors/pi-tool-boundary.js';
import { isPathWithin } from '../src/modules/sessions/working-directory.js';
import { presetAgents } from '../src/modules/agents/agent.js';
import type { SubagentRecord } from '../src/modules/agents/subagent-run.js';

async function world(run: (data: { root: string; repository: SqliteSubagentRepository; guard: SubagentWriteCoordinator; record: (id: string, mode: 'read' | 'write' | 'execute', scopes: string[]) => SubagentRecord }) => Promise<void>) {
  await mkdir('.tmp', { recursive: true }); const root = await mkdtemp(resolve('.tmp/subagent-boundary-'));
  const db = new DatabaseSync(':memory:'); db.exec(SUBAGENT_MIGRATION); const repository = new SqliteSubagentRepository(db);
  const guard = new SubagentWriteCoordinator(repository, async (_id, path) => isPathWithin(root, path));
  const record = (id: string, mode: 'read' | 'write' | 'execute', writeScope: string[]): SubagentRecord => ({ context: '', fingerprint: id, workingDirectory: { kind: 'temporary', path: root }, execution: null, runtimeConfig: null, markers: {},
    run: { id, sessionId: id, parentSessionId: 'parent', parentCommandId: 'turn', parentToolCallId: id, taskId: null, taskRunId: null, agent: presetAgents('now')[1]!, executor: null,
      mode, goal: 'goal', deliverable: 'result', reason: 'independent', writeScope, status: 'running', summary: '', summaryTruncated: false, outputBytes: 0, elapsedMs: 0, toolCalls: 0, totalTokens: null, currentStep: null,
      changedFiles: [], commitHashes: [], maxMillis: 10000, maxOutputBytes: 10000, stopConfirmed: false, createdAt: 'now', startedAt: 'now', endedAt: null } });
  try { await run({ root, repository, guard, record }); } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

test('真实路径规范化拒绝目录外及符号链接逃逸，重叠包含被拒；相邻名称可并发', async () => world(async ({ root, repository, guard, record }) => {
  await mkdir(join(root, 'allowed')); await mkdir(join(root, 'other'));
  await symlink(join(root, 'other'), join(root, 'allowed', 'link'));
  const a = record('a', 'write', ['allowed']); await guard.normalize(a); guard.admit(a); repository.save(a);
  for (const scope of ['allowed/file', 'allowed/..', './allowed']) {
    const b = record('b', 'write', [scope]); await guard.normalize(b); assert.throws(() => guard.admit(b), /冲突/);
  }
  const adjacent = record('adjacent', 'write', ['allowed-more']); await guard.normalize(adjacent); guard.admit(adjacent);
  const escape = record('escape', 'write', ['../outside']); await assert.rejects(guard.normalize(escape), /父级/);
  const verdict = await judgeToolCall('write', { path: 'allowed/link/out.txt' }, root, {}, () => [], { mode: 'write', writeScope: a.run.writeScope });
  assert.equal(verdict.type, 'block');
}));

test('分工写实际文件工具强制范围，父级相关写入被拒；停止后恢复', async () => world(async ({ root, repository, guard, record }) => {
  const a = record('a', 'write', ['allowed']); await guard.normalize(a); guard.admit(a); repository.save(a);
  const options = { cwd: root, subagent: { mode: 'write' as const, writeScope: a.run.writeScope }, guard: { sessionId: 'a', tools: guard } };
  const write = createBoundaryFileTools(options).find(tool => tool.name === 'write')!;
  await write.execute('one', { path: 'allowed/file.txt', content: 'bounded' }, new AbortController().signal, undefined, {} as never);
  assert.equal(await readFile(join(root, 'allowed/file.txt'), 'utf8'), 'bounded');
  await assert.rejects(write.execute('two', { path: 'other.txt', content: 'escape' }, new AbortController().signal, undefined, {} as never), /writeScope/);
  assert.throws(() => guard.acquire('parent', 'write', join(root, 'allowed/file.txt')), /父级/);
  guard.acquire('parent', 'write', join(root, 'outside.txt'))();
  assert.deepEqual(repository.bySession('a')!.run.changedFiles, [join(root, 'allowed/file.txt')]);
  a.run.stopConfirmed = true; repository.save(a); guard.acquire('parent', 'write', join(root, 'allowed/file.txt'))();
}));

test('执行独占与分工写互斥，只读可并行；父级所有写入和 bash 被拒；未停止不释放', async () => world(async ({ root, repository, guard, record }) => {
  const a = record('a', 'execute', ['allowed']); await guard.normalize(a); guard.admit(a); repository.save(a);
  const read = record('read', 'read', []); guard.admit(read); repository.save(read);
  for (const mode of ['execute', 'write'] as const) { const other = record(mode, mode, ['other']); await guard.normalize(other); assert.throws(() => guard.admit(other), /独占/); }
  assert.throws(() => guard.acquire('parent', 'write', join(root, 'other')), /独占/);
  assert.throws(() => guard.acquire('parent', 'bash'), /独占/);
  guard.acquire('parent', 'read', join(root, 'allowed'))();
  guard.acquire('a', 'bash')();
  a.run.status = 'interrupted'; repository.save(a);
  assert.throws(() => guard.acquire('parent', 'bash'), /独占/);
  a.run.stopConfirmed = true; repository.save(a); guard.acquire('parent', 'bash')();
}));

test('已开始的父级 I/O 或 bash 阻止冲突受理；租约释放才可受理', async () => world(async ({ root, guard, record }) => {
  const release = guard.acquire('parent', 'write', join(root, 'allowed/file'));
  const a = record('a', 'write', ['allowed']); await guard.normalize(a);
  assert.throws(() => guard.admit(a), /尚未结束/); release(); guard.admit(a);
  const bash = guard.acquire('parent', 'bash'); assert.throws(() => guard.admit(a), /尚未结束/); bash(); guard.admit(a);
}));

test('只读拒绝写入、bash、MCP、Skill、管理及嵌套；检索根目录受限', async () => world(async ({ root }) => {
  for (const tool of ['write', 'edit', 'bash', 'call_mcp_tool', 'skill_load', 'delegate_to_subagent', 'create_task']) {
    assert.equal((await judgeToolCall(tool, { path: '.' }, root, { create_task: 'manage' }, () => [], { mode: 'read', writeScope: [] })).type, 'block', tool);
  }
  for (const tool of ['read', 'grep', 'find', 'ls']) assert.equal((await judgeToolCall(tool, { path: '.' }, root, {}, () => [], { mode: 'read', writeScope: [] })).type, 'allow', tool);
}));

test('执行方式受控本地提交要求差异核对与运行检查，仅提交明确文件并保留无关暂存', { skip: process.platform !== 'darwin' }, async () => world(async ({ root, repository, guard, record }) => {
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const { writeFile } = await import('node:fs/promises');
  const { ControlledGitChannel } = await import('../src/application/controlled-git-channel.js');
  const { SubagentGitService } = await import('../src/application/subagent-git-service.js');
  const exec = promisify(execFile);
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], { env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })).stdout.trim();
  await git('init', '-b', 'test-delegation');
  await writeFile(join(root, 'code.txt'), 'before'); await writeFile(join(root, 'other.txt'), 'before');
  await git('add', 'code.txt', 'other.txt'); await git('commit', '-m', 'baseline');
  const a = record('execute', 'execute', ['code.txt']); await guard.normalize(a); guard.admit(a); repository.save(a);
  const channel = new ControlledGitChannel(); let verified = false;
  const service = new SubagentGitService(repository, channel, guard, [], () => 1024 * 1024, () => verified);
  try {
    await writeFile(join(root, 'code.txt'), 'after'); await writeFile(join(root, 'other.txt'), 'unrelated'); await git('add', 'other.txt');
    await assert.rejects(service.commit('execute', { paths: ['code.txt'], message: 'fix: 更新代码' }, new AbortController().signal), /核对/);
    await service.inspect('execute', { paths: ['code.txt'] }, new AbortController().signal);
    await assert.rejects(service.commit('execute', { paths: ['code.txt'], message: 'fix: 更新代码' }, new AbortController().signal), /运行检查/);
    verified = true;
    const output = await service.commit('execute', { paths: ['code.txt'], message: 'fix: 更新代码' }, new AbortController().signal);
    const hash = await git('rev-parse', 'HEAD'); assert.match(output, new RegExp(hash));
    assert.equal(await git('show', 'HEAD:other.txt'), 'before'); assert.equal(await git('diff', '--cached', '--name-only'), 'other.txt');
    assert.deepEqual(repository.bySession('execute')!.run.commitHashes, [hash]);
    assert.match(await service.commit('execute', { paths: ['code.txt'], message: 'fix: 无改动' }, new AbortController().signal), /空提交/);
    await assert.rejects(service.inspect('execute', { paths: ['other.txt'] }, new AbortController().signal), /writeScope/);
  } finally { await channel.dispose(); }
}));
