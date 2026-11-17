import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { InternalToolService } from '../src/application/internal-tools/internal-tool-service.js';
import { SUBAGENT_GIT_TOOLS } from '../src/application/internal-tools/subagent-git-tools.js';
import { ControlledGitChannel } from '../src/application/controlled-git-channel.js';
import { SubagentGitService } from '../src/application/subagent-git-service.js';
import { SubagentWriteCoordinator } from '../src/application/subagent-write-coordinator.js';
import { internalToolCommandId, type InternalToolOutcome } from '../src/modules/internal-tools/internal-tool.js';
import { createPiInternalToolSet } from '../src/runtime/executors/pi-internal-tools.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { subagentRecord } from './fixtures/subagent-record.js';
import { unusedCapability } from './fixtures/unused-capability.js';

const exec = promisify(execFile);
const signal = () => new AbortController().signal;
const input = { paths: ['code.txt'], message: 'fix: 更新代码' };
const reason = (outcome: InternalToolOutcome) => outcome.ok ? outcome.content : outcome.reason;

async function fixture() {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(resolve('.tmp/subagent-git-tools-')), directory = join(root, 'repo');
  await mkdir(directory);
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', directory, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args],
    { env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })).stdout.trim();
  await git('init', '-b', 'test-subagent');
  for (const name of ['code.txt', 'other.txt']) await writeFile(join(directory, name), 'before');
  await git('add', 'code.txt', 'other.txt'); await git('commit', '-m', 'baseline');
  const baseline = await git('rev-parse', 'HEAD'), path = join(root, 'store.sqlite');
  let store = new SqliteAssistantStore(path);
  const child = subagentRecord('execute', directory, ['code.txt']);
  const guard = new SubagentWriteCoordinator(store.subagents, async () => true);
  await guard.normalize(child); guard.admit(child); store.subagents.save(child);
  const channel = new ControlledGitChannel();
  const state = { verified: false, exhausted: false, commits: 0, leases: [] as string[], afterCommit: null as (() => void) | null };
  const run = channel.run.bind(channel);
  channel.run = (id, abort, options, action) => run(id, abort, options, (git, boundary) => action(async (args, allowMissing) => {
    const text = await git(args, allowMissing);
    if (args[0] === 'commit') state.afterCommit?.();
    return text;
  }, boundary));
  const create = () => {
    const currentGuard = new SubagentWriteCoordinator(store.subagents, async () => true);
    const service = new SubagentGitService(store.subagents, channel, currentGuard, [], (_id, phase) => {
      state.leases.push(phase);
      if (state.exhausted && phase === 'starting') throw new Error('额度耗尽');
      return 1024 * 1024;
    }, () => state.verified);
    return new InternalToolService({ tools: SUBAGENT_GIT_TOOLS, calls: store.subagentToolCalls, currentTurn: () => null,
      services: { projects: unusedCapability('projects'), sessions: unusedCapability('sessions'),
        transcripts: unusedCapability('transcripts'), windows: unusedCapability('windows'),
        subagentGit: { inspect: (...args) => service.inspect(...args), commit: (...args) => {
        state.commits += 1;
        // 实际提交服务运行时，登记必须已落入真实 SQLite。
        const db = new DatabaseSync(path);
        try { assert.ok(db.prepare("SELECT 1 FROM subagent_tool_call WHERE session_id=? AND status='running'").get(child.run.sessionId)); }
        finally { db.close(); }
        return service.commit(...args);
      } } } });
  };
  return { directory, path, child, baseline, git, state, create,
    store: () => store,
    invoke: (tools: InternalToolService, toolCallId: string, args: unknown = input, toolName = 'commit_subagent_code', abort = signal()) =>
      tools.invoke({ assistantSessionId: child.run.sessionId, toolCallId, toolName, args }, abort),
    change: (text = 'after') => writeFile(join(directory, 'code.txt'), text),
    inspect: (tools: InternalToolService) => tools.invoke({ assistantSessionId: child.run.sessionId, toolCallId: 'inspect', toolName: 'inspect_subagent_git', args: { paths: input.paths } }, signal()),
    reopen() { store.close(); store = new SqliteAssistantStore(path); return create(); },
    sql(sql: string) { const db = new DatabaseSync(path); try { db.exec(sql); } finally { db.close(); } },
    async close() { await channel.dispose(); store.close(); await rm(root, { recursive: true, force: true }); },
  };
}

const mac = { skip: process.platform !== 'darwin' };

test('Pi 工具入口→SQLite→受控 Git 只提交一次，保留无关暂存；并发参数冲突且重启重放回执', mac, async () => {
  const f = await fixture();
  try {
    const tools = f.create(); f.state.verified = true;
    await f.change(); await writeFile(join(f.directory, 'other.txt'), 'unrelated'); await f.git('add', 'other.txt');
    assert.equal((await f.inspect(tools)).ok, true);
    const pi = createPiInternalToolSet(f.child.run.sessionId, tools).definitions.find(tool => tool.name === 'commit_subagent_code')!;
    const first = pi.execute('commit', input, signal(), undefined, {} as never);
    const concurrent = f.invoke(tools, 'commit');
    const conflict = await f.invoke(tools, 'commit', { ...input, message: 'fix: 不同参数' });
    assert.equal(conflict.ok, false); assert.match(reason(conflict), /内容不同/);
    const result = await first, shared = await concurrent;
    assert.equal(shared.ok, true);
    assert.deepEqual(result.content, [{ type: 'text', text: reason(shared) }]);
    const hash = await f.git('rev-parse', 'HEAD');
    assert.notEqual(hash, f.baseline); assert.match(reason(shared), new RegExp(hash));
    assert.equal(f.state.commits, 1);
    assert.equal(await f.git('rev-list', '--count', 'HEAD'), '2');
    assert.equal(await f.git('diff', '--cached', '--name-only'), 'other.txt');
    assert.equal(await f.git('show', 'HEAD:other.txt'), 'before');
    assert.equal(await f.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'code.txt');
    const commandId = internalToolCommandId(f.child.run.sessionId, 'commit');
    assert.deepEqual(f.store().subagentToolCalls.get(commandId)!.outcome, shared);
    assert.equal(f.store().subagentToolCalls.get(commandId)!.sessionId, f.child.run.sessionId);
    assert.equal(f.store().internalToolCalls.get(commandId), undefined);
    assert.deepEqual(f.store().subagents.get(f.child.run.id)!.run.commitHashes, [hash]);
    assert.equal(f.store().sessions.get(f.child.run.sessionId), undefined);
    assert.deepEqual(f.store().sessions.list(null, 'work'), []);
    assert.deepEqual(await f.invoke(tools, 'commit'), shared);
    assert.deepEqual(await f.invoke(f.reopen(), 'commit'), shared);
    assert.equal(f.state.commits, 1);
    assert.deepEqual(f.state.leases, ['starting', 'settled', 'starting', 'settled']);
  } finally { await f.close(); }
});

test('真实 SQLite 登记失败时不进入提交服务，不执行 Git', mac, async () => {
  const f = await fixture();
  try {
    await f.change();
    f.sql("CREATE TRIGGER reject_begin BEFORE INSERT ON subagent_tool_call BEGIN SELECT RAISE(ABORT, 'ledger unavailable'); END");
    const result = await f.invoke(f.create(), 'commit');
    assert.equal(result.ok, false); assert.match(reason(result), /调用记录无法保存/);
    assert.equal(f.state.commits, 0); assert.deepEqual(f.state.leases, []);
    assert.equal(await f.git('rev-parse', 'HEAD'), f.baseline);
    assert.equal(f.store().subagentToolCalls.get(internalToolCommandId(f.child.run.sessionId, 'commit')), undefined);
  } finally { await f.close(); }
});

test('提交已发生但回执写入失败，当前进程与重启后均只读待核对状态，不重复提交', mac, async () => {
  const f = await fixture();
  try {
    const tools = f.create(); f.state.verified = true; await f.change();
    assert.equal((await f.inspect(tools)).ok, true);
    f.sql("CREATE TRIGGER reject_finish BEFORE UPDATE ON subagent_tool_call BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END");
    const first = await f.invoke(tools, 'commit');
    const hash = await f.git('rev-parse', 'HEAD');
    assert.equal(first.ok, true); assert.match(reason(first), new RegExp(hash));
    assert.equal(f.store().subagentToolCalls.get(internalToolCommandId(f.child.run.sessionId, 'commit'))!.status, 'running');
    assert.deepEqual(f.store().subagents.get(f.child.run.id)!.run.commitHashes, [hash]);
    // 即使可写性恢复，旧意图仍不得重放。
    f.sql('DROP TRIGGER reject_finish');
    await f.change('new pending work');
    const repeat = await f.invoke(tools, 'commit');
    assert.equal(repeat.ok, false); assert.match(reason(repeat), /结果未知/);
    assert.deepEqual(await f.invoke(f.reopen(), 'commit'), repeat);
    assert.equal(f.state.commits, 1);
    assert.equal(await f.git('rev-parse', 'HEAD'), hash);
    assert.equal(await f.git('rev-list', '--count', 'HEAD'), '2');
  } finally { await f.close(); }
});

test('Git 已提交但子级元数据保存失败，保留未知且重启后不重放', mac, async () => {
  const f = await fixture();
  try {
    const tools = f.create(); f.state.verified = true; await f.change();
    assert.equal((await f.inspect(tools)).ok, true);
    f.sql(`CREATE TRIGGER reject_commit_metadata BEFORE UPDATE ON subagent_run
      WHEN json_array_length(json_extract(NEW.record_json, '$.run.commitHashes')) > json_array_length(json_extract(OLD.record_json, '$.run.commitHashes'))
      BEGIN SELECT RAISE(ABORT, 'commit metadata unavailable'); END`);
    const first = await f.invoke(tools, 'metadata-failed');
    const hash = await f.git('rev-parse', 'HEAD');
    assert.notEqual(hash, f.baseline);
    assert.equal(first.ok, false); assert.match(reason(first), /结果未知/);
    assert.doesNotMatch(reason(first), /没有完成|稍后重试/);
    const commandId = internalToolCommandId(f.child.run.sessionId, 'metadata-failed');
    assert.equal(f.store().subagentToolCalls.get(commandId)!.status, 'running');
    assert.deepEqual(f.store().subagents.get(f.child.run.id)!.run.commitHashes, []);
    f.sql('DROP TRIGGER reject_commit_metadata');
    await f.change('new pending work');
    const repeated = await f.invoke(tools, 'metadata-failed');
    assert.equal(repeated.ok, false); assert.match(reason(repeated), /结果未知/);
    assert.deepEqual(await f.invoke(f.reopen(), 'metadata-failed'), repeated);
    assert.equal(f.state.commits, 1);
    assert.equal(await f.git('rev-parse', 'HEAD'), hash);
    assert.equal(await f.git('rev-list', '--count', 'HEAD'), '2');
    assert.equal(await f.git('diff', '--name-only'), 'code.txt');
  } finally { await f.close(); }
});

test('真实 Git 已提交、读取 SHA 前取消，回执保留未知且不重复提交', mac, async () => {
  const f = await fixture();
  try {
    const tools = f.create(); f.state.verified = true; await f.change();
    assert.equal((await f.inspect(tools)).ok, true);
    const controller = new AbortController();
    f.state.afterCommit = () => controller.abort();
    const first = await f.invoke(tools, 'cancel-after-commit', input, 'commit_subagent_code', controller.signal);
    const hash = await f.git('rev-parse', 'HEAD');
    assert.notEqual(hash, f.baseline);
    assert.equal(first.ok, false); assert.match(reason(first), /结果未知/);
    assert.doesNotMatch(reason(first), /没有完成|稍后重试/);
    assert.equal(f.store().subagentToolCalls.get(internalToolCommandId(f.child.run.sessionId, 'cancel-after-commit'))!.status, 'running');
    assert.deepEqual(f.store().subagents.get(f.child.run.id)!.run.commitHashes, []);
    f.state.afterCommit = null;
    const repeated = await f.invoke(tools, 'cancel-after-commit');
    assert.equal(repeated.ok, false); assert.match(reason(repeated), /结果未知/);
    assert.deepEqual(await f.invoke(f.reopen(), 'cancel-after-commit'), repeated);
    assert.equal(f.state.commits, 1);
    assert.equal(await f.git('rev-parse', 'HEAD'), hash);
    assert.equal(await f.git('rev-list', '--count', 'HEAD'), '2');
    assert.equal(await f.git('diff', '--name-only'), '');
  } finally { await f.close(); }
});

test('真实工具入口保留核对、运行检查、writeScope、额度和停止门禁；失败回执不重放', mac, async () => {
  const f = await fixture();
  try {
    const tools = f.create(); await f.change();
    const missingInspection = await f.invoke(tools, 'missing-inspection');
    assert.equal(missingInspection.ok, false);
    assert.equal((await f.inspect(tools)).ok, true);
    const missingCheck = await f.invoke(tools, 'missing-check'); assert.equal(missingCheck.ok, false);
    f.state.verified = true;
    assert.deepEqual(await f.invoke(tools, 'missing-check'), missingCheck);
    assert.equal(f.state.commits, 2);
    await f.change('changed after inspection');
    assert.equal((await f.invoke(tools, 'stale-inspection')).ok, false);
    assert.equal((await f.inspect(tools)).ok, true);
    assert.equal((await f.invoke(tools, 'outside-scope', { paths: ['other.txt'], message: input.message })).ok, false);
    f.state.exhausted = true;
    assert.equal((await f.invoke(tools, 'exhausted')).ok, false);
    f.state.exhausted = false;
    const stopped = f.store().subagents.get(f.child.run.id)!;
    stopped.run.status = 'cancelled'; stopped.run.stopConfirmed = true; f.store().subagents.save(stopped);
    assert.equal((await f.invoke(tools, 'stopped')).ok, false);
    assert.equal(await f.git('rev-parse', 'HEAD'), f.baseline);
    for (const id of ['missing-inspection', 'missing-check', 'stale-inspection', 'outside-scope', 'exhausted', 'stopped']) {
      assert.equal(f.store().subagentToolCalls.get(internalToolCommandId(f.child.run.sessionId, id))!.status, 'failed');
    }
    const before = f.state.commits;
    assert.deepEqual(await f.invoke(f.reopen(), 'missing-check'), missingCheck);
    assert.equal(f.state.commits, before);
  } finally { await f.close(); }
});

test('无改动通过工具入口保存回执，不创建空提交', mac, async () => {
  const f = await fixture();
  try {
    const tools = f.create(), result = await f.invoke(tools, 'empty');
    assert.equal(result.ok, true); assert.match(reason(result), /未创建空提交/);
    assert.deepEqual(await f.invoke(tools, 'empty'), result);
    assert.equal(f.state.commits, 1);
    assert.equal(await f.git('rev-parse', 'HEAD'), f.baseline);
    assert.equal(await f.git('rev-list', '--count', 'HEAD'), '1');
  } finally { await f.close(); }
});
