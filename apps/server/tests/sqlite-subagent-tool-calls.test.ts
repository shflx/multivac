import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { GLOBAL_ASSISTANT_SESSION_ID } from '@multivac/contracts';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { internalToolCommandId, type InternalToolCallRecord, type InternalToolOutcome } from '../src/modules/internal-tools/internal-tool.js';
import { subagentRecord } from './fixtures/subagent-record.js';

const success: InternalToolOutcome = { ok: true, content: '本地提交：abc', result: { summary: '已提交', refs: [] } };
function call(sessionId: string, toolCallId = 'commit'): Omit<InternalToolCallRecord, 'status' | 'outcome' | 'updatedAt'> {
  return { commandId: internalToolCommandId(sessionId, toolCallId), sessionId, toolCallId,
    toolName: 'commit_subagent_code', effect: 'manage', argumentsFingerprint: 'fingerprint', createdAt: 'created' };
}

async function fixture(run: (path: string, root: string) => Promise<void>) {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(resolve('.tmp/subagent-ledger-'));
  try { await run(join(root, 'store.sqlite'), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('子级账本绑定真实运行身份，无需普通会话注册；幂等登记与终态回执不可覆盖', async () => fixture(async (path, root) => {
  const store = new SqliteAssistantStore(path);
  try {
    const a = subagentRecord('a', root), b = subagentRecord('b', root);
    store.subagents.save(a); store.subagents.save(b);
    assert.equal(store.sessions.get(a.run.sessionId), undefined);
    assert.deepEqual(store.sessions.list(null, 'work'), []);
    assert.throws(() => store.internalToolCalls.begin(call(a.run.sessionId)), /FOREIGN KEY/);
    assert.throws(() => store.subagentToolCalls.begin(call('missing')), /FOREIGN KEY/);
    // 运行 ID 和父级会话均不能代替子会话身份。
    assert.throws(() => store.subagentToolCalls.begin(call(a.run.id)), /FOREIGN KEY/);
    assert.throws(() => store.subagentToolCalls.begin(call(a.run.parentSessionId)), /FOREIGN KEY/);

    const original = call(a.run.sessionId);
    const begun = store.subagentToolCalls.begin(original);
    assert.equal(begun.inserted, true);
    assert.equal(begun.record.status, 'running');
    assert.equal(begun.record.outcome, null);
    assert.deepEqual(store.subagentToolCalls.begin({ ...original, argumentsFingerprint: 'different' }), { record: begun.record, inserted: false });
    store.subagentToolCalls.finish(original.commandId, success, 'finished');
    const completed = store.subagentToolCalls.get(original.commandId)!;
    assert.deepEqual(completed.outcome, success);
    store.subagentToolCalls.finish(original.commandId, { ok: false, reason: '覆盖' }, 'later');
    assert.deepEqual(store.subagentToolCalls.get(original.commandId), completed);
    assert.deepEqual(store.subagentToolCalls.begin({ ...original, argumentsFingerprint: 'different' }), { record: completed, inserted: false });

    const other = call(b.run.sessionId);
    assert.notEqual(original.commandId, other.commandId);
    store.subagentToolCalls.begin(other);
    store.subagentToolCalls.finish(other.commandId, { ok: false, reason: '另一个子级' }, 'finished');
    assert.deepEqual(store.subagentToolCalls.get(other.commandId)!.outcome, { ok: false, reason: '另一个子级' });
    assert.equal(store.internalToolCalls.get(original.commandId), undefined);
    const db = new DatabaseSync(path);
    try { assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); }
    finally { db.close(); }
  } finally { store.close(); }
}));

test('旧库升级先备份；普通历史、已有子级及新增账本在重复打开后保持有效', async () => fixture(async (path, root) => {
  let store = new SqliteAssistantStore(path);
  const child = subagentRecord('existing', root), normal = call(GLOBAL_ASSISTANT_SESSION_ID);
  store.subagents.save(child);
  store.internalToolCalls.begin(normal);
  store.internalToolCalls.finish(normal.commandId, success, 'finished');
  store.close();
  // 回到本次迁移前的结构，保留旧账本和子级记录。
  const previous = new DatabaseSync(path);
  const version = (previous.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version;
  previous.exec('DROP TABLE subagent_tool_call');
  previous.prepare('DELETE FROM schema_migrations WHERE version = ?').run(version);
  previous.close();

  store = new SqliteAssistantStore(path);
  const childCall = call(child.run.sessionId);
  try {
    assert.deepEqual(store.internalToolCalls.get(normal.commandId)!.outcome, success);
    assert.deepEqual(store.subagents.get(child.run.id), child);
    store.subagentToolCalls.begin(childCall);
    store.subagentToolCalls.finish(childCall.commandId, success, 'finished');
    store.subagentToolCalls.begin(call(child.run.sessionId, 'unknown'));
    assert.equal(store.sessions.get(child.run.sessionId), undefined);
  } finally { store.close(); }
  const backups = (await readdir(root)).filter(name => name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(join(root, backups[0]!));
  try {
    assert.equal(backup.prepare("SELECT 1 FROM sqlite_schema WHERE name='subagent_tool_call'").get(), undefined);
    assert.ok(backup.prepare('SELECT 1 FROM internal_tool_call WHERE command_id=?').get(normal.commandId));
    assert.ok(backup.prepare('SELECT 1 FROM subagent_run WHERE id=?').get(child.run.id));
  } finally { backup.close(); }
  for (let i = 0; i < 2; i += 1) {
    store = new SqliteAssistantStore(path);
    try {
      assert.deepEqual(store.internalToolCalls.get(normal.commandId)!.outcome, success);
      assert.deepEqual(store.subagentToolCalls.get(childCall.commandId)!.outcome, success);
      assert.equal(store.subagentToolCalls.get(call(child.run.sessionId, 'unknown').commandId)!.status, 'running');
      assert.deepEqual(store.subagents.get(child.run.id), child);
      assert.deepEqual(store.sessions.list(null, 'work'), []);
    } finally { store.close(); }
  }
  assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.bak')), backups);
  const db = new DatabaseSync(path);
  try { assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); }
  finally { db.close(); }
}));
