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
      draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: 0,
    });

    const quote = {
      sourcePiSessionId: binding.piSessionId,
      sourcePiEntryId: 'entry-1',
      sourceRole: 'assistant' as const,
      text: '第一行\n\n  第二行保留缩进',
    };
    const saved = pageStates.save(binding.assistantSessionId, {
      draft: '草稿', anchorEntryId: 'entry-2', anchorOffsetPx: 18.5, quote, revision: 0,
    });
    assert.deepEqual(saved, {
      draft: '草稿', anchorEntryId: 'entry-2', anchorOffsetPx: 18.5, quote, revision: 1,
    });
    assert.deepEqual(pageStates.save(binding.assistantSessionId, saved), saved);
    // 仅引用变化也要推进 revision，避免未发送引用被判为“无改动”而丢失。
    const requoted = pageStates.save(binding.assistantSessionId, {
      ...saved, quote: { ...quote, text: '换一段引用' },
    });
    assert.equal(requoted.revision, 2);
    assert.equal(requoted.quote?.text, '换一段引用');
    assert.deepEqual(
      pageStates.save(binding.assistantSessionId, { ...requoted, quote: null }).quote,
      null,
    );
    assert.throws(
      () => pageStates.save(binding.assistantSessionId, {
        draft: '旧页面覆盖', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: 0,
      }),
      AssistantPageStateRevisionConflictError,
    );
    store.close();

    const reopened = new SqliteAssistantStore(databasePath);
    assert.deepEqual(new SqliteAssistantBindingRepository(reopened).get(binding.assistantSessionId), binding);
    assert.deepEqual(new SqliteAssistantPageStateRepository(reopened).get(binding.assistantSessionId), {
      draft: '草稿', anchorEntryId: 'entry-2', anchorOffsetPx: 18.5, quote: null, revision: 3,
    });
    reopened.close();

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    const schema = inspection.prepare(`
      SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name
    `).all() as Array<{ name: string; sql: string }>;
    inspection.close();
    assert.deepEqual(schema.map((row) => row.name), [
      'assistant_command_receipt',
      'assistant_event_projection',
      'assistant_model_command',
      'assistant_model_selection',
      'assistant_page_state',
      'assistant_session_binding',
      'assistant_session_registry',
      'schema_migrations',
      'sqlite_sequence',
      'workspace_scene',
    ]);
    assert.equal(schema.some((row) => /message_body|message_text|tool_payload/u.test(row.sql)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SQLite v2 含既有 binding 升级时保留历史绑定并补充模型列', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-assistant-store-v2-upgrade-'));
  const databasePath = join(root, 'data.sqlite');
  const setup = new DatabaseSync(databasePath);
  setup.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO schema_migrations (version, applied_at) VALUES
      (1, '2026-09-14T08:00:00.000Z'),
      (2, '2026-09-14T08:00:00.000Z');
    CREATE TABLE assistant_session_binding (
      assistant_id TEXT PRIMARY KEY,
      pi_session_id TEXT NOT NULL UNIQUE,
      pi_session_path TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO assistant_session_binding (
      assistant_id, pi_session_id, pi_session_path, updated_at
    ) VALUES (
      'global-coordinator', 'pi-v2', '/tmp/pi-v2.jsonl', '2026-09-14T08:00:00.000Z'
    );
    CREATE TABLE assistant_page_state (
      assistant_id TEXT PRIMARY KEY,
      draft TEXT NOT NULL,
      anchor_entry_id TEXT,
      anchor_offset_px REAL NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      updated_at TEXT NOT NULL,
      FOREIGN KEY (assistant_id) REFERENCES assistant_session_binding(assistant_id) ON DELETE CASCADE
    ) STRICT;
  `);
  setup.close();

  try {
    const upgraded = new SqliteAssistantStore(databasePath);
    assert.deepEqual(upgraded.getBinding('global-coordinator'), {
      assistantSessionId: 'global-coordinator',
      piSessionId: 'pi-v2',
      piSessionPath: '/tmp/pi-v2.jsonl',
      updatedAt: '2026-09-14T08:00:00.000Z',
    });
    upgraded.close();

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    const versions = inspection.prepare(
      'SELECT version FROM schema_migrations ORDER BY version',
    ).all() as Array<{ version: number }>;
    const row = inspection.prepare(`
      SELECT model_provider, model_id, model_protocol, model_endpoint, model_resolved_endpoint
      FROM assistant_session_binding WHERE assistant_id = 'global-coordinator'
    `).get() as Record<string, null>;
    inspection.close();
    assert.deepEqual(versions.map((item) => item.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual({ ...row }, {
      model_provider: null,
      model_id: null,
      model_protocol: null,
      model_endpoint: null,
      model_resolved_endpoint: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SQLite v3 固定模型升级显式 source 时不把非空基础 protocol 当作受控选择', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-binding-source-upgrade-'));
  const databasePath = join(root, 'data.sqlite');
  const initial = new SqliteAssistantStore(databasePath);
  initial.insertIfAbsent({
    assistantSessionId: 'base-assistant', piSessionId: 'base-pi', piSessionPath: '/sessions/base.jsonl',
    updatedAt: '2026-09-16T08:00:00.000Z', modelProvider: 'legacy', modelId: 'legacy-model',
    modelProtocol: 'openai-codex-responses', modelEndpoint: 'https://legacy.example/v1',
    modelResolvedEndpoint: 'https://legacy.example/v1',
  });
  initial.insertIfAbsent({
    assistantSessionId: 'controlled-assistant', piSessionId: 'controlled-pi',
    piSessionPath: '/sessions/controlled.jsonl', updatedAt: '2026-09-16T08:00:00.000Z',
    modelProvider: 'openai', modelId: 'managed', modelProtocol: 'openai-responses',
    modelEndpoint: null, modelResolvedEndpoint: 'https://official.example/v1', modelProfileId: 'profile',
  });
  initial.close();
  const fixture = new DatabaseSync(databasePath);
  fixture.exec(`
    DROP TABLE assistant_model_command;
    DROP TABLE assistant_model_selection;
    ALTER TABLE assistant_session_binding DROP COLUMN model_endpoint_mode;
    ALTER TABLE assistant_session_binding DROP COLUMN model_source;
    ALTER TABLE assistant_page_state DROP COLUMN quote_json;
    DELETE FROM schema_migrations WHERE version >= 4;
  `);
  fixture.close();
  let restored: SqliteAssistantStore | undefined;
  try {
    restored = new SqliteAssistantStore(databasePath);
    const base = restored.getBinding('base-assistant');
    assert.equal(base?.modelSource, 'base');
    assert.equal(base?.modelProtocol, 'openai-codex-responses');
    assert.equal(base?.modelProfileId, undefined);
    const controlled = restored.getBinding('controlled-assistant');
    assert.equal(controlled?.modelSource, 'controlled');
    assert.equal(controlled?.modelEndpoint, null);
    assert.equal(controlled?.modelProfileId, 'profile');
    restored.close();
    restored = new SqliteAssistantStore(databasePath);
    assert.deepEqual(restored.getBinding('base-assistant'), base);
    assert.deepEqual(restored.getBinding('controlled-assistant'), controlled);
  } finally {
    restored?.close();
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
    assert.deepEqual(versions.map((row) => row.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual(tables.map((row) => row.name), [
      'assistant_command_receipt',
      'assistant_event_projection',
      'assistant_model_command',
      'assistant_model_selection',
      'assistant_page_state',
      'assistant_session_binding',
      'assistant_session_registry',
      'schema_migrations',
      'sqlite_sequence',
      'workspace_scene',
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
