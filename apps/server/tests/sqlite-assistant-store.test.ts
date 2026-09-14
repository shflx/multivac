import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AssistantPageStateRevisionConflictError } from '../src/modules/sessions/assistant-session.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
} from '../src/storage/sqlite-assistant-store.js';

function waitForOutput(child: ChildProcessWithoutNullStreams, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.includes(text)) {
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!output.includes(text)) {
        reject(new Error(`子进程提前退出，code=${code ?? 'null'}，output=${output}`));
      }
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`SQLite 子进程失败，code=${code ?? 'null'}：${stderr}`));
    });
  });
}

test('SQLite 完成迁移、binding/page state revision 并支持关闭后恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-assistant-store-'));
  const databasePath = join(root, 'data.sqlite');
  const binding = {
    assistantSessionId: 'global-coordinator',
    piSessionId: 'pi-1',
    piSessionPath: '/tmp/pi-1.jsonl',
    updatedAt: '2026-09-14T08:00:00.000Z',
  };

  try {
    const store = new SqliteAssistantStore(databasePath, {
      now: () => '2026-09-14T08:00:00.000Z',
    });
    const bindings = new SqliteAssistantBindingRepository(store);
    const pageStates = new SqliteAssistantPageStateRepository(store);

    assert.deepEqual(bindings.insertIfAbsent(binding), { binding, inserted: true });
    assert.deepEqual(bindings.insertIfAbsent({ ...binding, piSessionId: 'pi-loser' }), {
      binding,
      inserted: false,
    });
    assert.deepEqual(pageStates.get(binding.assistantSessionId), {
      draft: '', anchorEntryId: null, anchorOffsetPx: 0, revision: 0,
    });

    const saved = pageStates.save(binding.assistantSessionId, {
      draft: '草稿', anchorEntryId: 'entry-2', anchorOffsetPx: 18.5, revision: 0,
    });
    assert.deepEqual(saved, {
      draft: '草稿', anchorEntryId: 'entry-2', anchorOffsetPx: 18.5, revision: 1,
    });
    assert.deepEqual(pageStates.save(binding.assistantSessionId, saved), saved);
    assert.throws(
      () => pageStates.save(binding.assistantSessionId, {
        draft: '旧页面覆盖', anchorEntryId: null, anchorOffsetPx: 0, revision: 0,
      }),
      AssistantPageStateRevisionConflictError,
    );
    store.close();

    const reopened = new SqliteAssistantStore(databasePath);
    assert.deepEqual(new SqliteAssistantBindingRepository(reopened).get(binding.assistantSessionId), binding);
    assert.deepEqual(new SqliteAssistantPageStateRepository(reopened).get(binding.assistantSessionId), saved);
    reopened.close();

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    const schema = inspection.prepare(`
      SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name
    `).all() as Array<{ name: string; sql: string }>;
    inspection.close();
    assert.deepEqual(schema.map((row) => row.name), [
      'assistant_page_state',
      'assistant_session_binding',
      'schema_migrations',
    ]);
    assert.equal(schema.some((row) => /message_body|message_text|tool_payload/u.test(row.sql)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('两个独立进程并发启动时只执行一次完整 migration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-assistant-store-concurrent-'));
  const databasePath = join(root, 'data.sqlite');
  const fixture = fileURLToPath(new URL('./fixtures/sqlite-store-child.mjs', import.meta.url));
  const setup = new DatabaseSync(databasePath);
  setup.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  setup.close();

  const lock = new DatabaseSync(databasePath);
  lock.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;');
  const createChild = () => spawn(process.execPath, ['--import', 'tsx', fixture, databasePath], {
    cwd: fileURLToPath(new URL('../../..', import.meta.url)),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const first = createChild();
  const second = createChild();
  const exits = [waitForExit(first), waitForExit(second)];

  try {
    await Promise.all([waitForOutput(first, 'ready'), waitForOutput(second, 'ready')]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    lock.exec('COMMIT');
    lock.close();
    await Promise.all(exits);

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    const versions = inspection.prepare(
      'SELECT version FROM schema_migrations ORDER BY version',
    ).all() as Array<{ version: number }>;
    const tables = inspection.prepare(`
      SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name
    `).all() as Array<{ name: string }>;
    inspection.close();
    assert.deepEqual(versions.map((row) => row.version), [1]);
    assert.deepEqual(tables.map((row) => row.name), [
      'assistant_page_state',
      'assistant_session_binding',
      'schema_migrations',
    ]);
  } finally {
    if (lock.isOpen) {
      try {
        lock.exec('ROLLBACK');
      } catch {
        // 测试清理只释放仍持有的锁。
      }
      lock.close();
    }
    first.kill();
    second.kill();
    await rm(root, { recursive: true, force: true });
  }
});
