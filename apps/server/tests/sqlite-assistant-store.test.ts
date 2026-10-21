import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AssistantPageStateRevisionConflictError } from '../src/modules/sessions/assistant-session.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

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

test('会话活动来自持久化运行事件，改名不改活动，数据库重开后仍可读取', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-activity-'));
  const path = join(root, 'data.sqlite');
  const createdAt = '2026-09-25T08:00:00.000Z';
  const activity = '2026-10-01T08:00:00.000Z';
  let store = new SqliteAssistantStore(path);
  try {
    const registry = store.sessions;
    registry.insertIfAbsent({ sessionId: 'activity', title: '工作', kind: 'work', workspaceId: 'default', createdAt, workingDirectory: { kind: 'session-temp', path: '/work/activity' } });
    store.bindings.insertIfAbsent({ assistantSessionId: 'activity', harness: 'pi', runtimeSessionId: 'pi-activity', runtimeSessionRef: '/work/pi.jsonl', updatedAt: createdAt });
    assert.equal(registry.get('activity')?.lastActivityAt, createdAt);
    store.events.append({ sourceKey: 'real-turn', assistantSessionId: 'activity', commandId: null, type: 'assistant.turn.started', data: { turnRef: 'real' }, occurredAt: activity });
    registry.rename('activity', '改名');
    assert.equal(registry.get('activity')?.lastActivityAt, activity);
    store.close();
    store = new SqliteAssistantStore(path);
    assert.equal(store.sessions.get('activity')?.lastActivityAt, activity);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

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
    assistantSessionId: 'global-coordinator', harness: 'pi',
    runtimeSessionId: 'pi-1',
    runtimeSessionRef: '/tmp/pi-1.jsonl',
    updatedAt: '2026-09-14T08:00:00.000Z',
  };

  try {
    const store = new SqliteAssistantStore(databasePath, {
      now: () => '2026-09-14T08:00:00.000Z',
    });
    const bindings = store.bindings;
    const pageStates = store.pageStates;

    assert.deepEqual(bindings.insertIfAbsent(binding), { binding, inserted: true });
    assert.deepEqual(bindings.insertIfAbsent({ ...binding, runtimeSessionId: 'pi-loser' }), {
      binding,
      inserted: false,
    });
    assert.deepEqual(pageStates.get(binding.assistantSessionId), {
      draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: 0,
    });

    const quote = {
      sourceRuntimeSessionId: binding.runtimeSessionId,
      sourceRuntimeEntryId: 'entry-1',
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
    assert.deepEqual(reopened.bindings.get(binding.assistantSessionId), binding);
    assert.deepEqual(reopened.pageStates.get(binding.assistantSessionId), {
      draft: '草稿', anchorEntryId: 'entry-2', anchorOffsetPx: 18.5, quote: null, revision: 3,
    });
    reopened.close();

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    const schema = inspection.prepare(`
      SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name
    `).all() as Array<{ name: string; sql: string }>;
    inspection.close();
    assert.deepEqual(schema.map((row) => row.name), [
      ...['mcp_command', 'mcp_event', 'mcp_fact', 'mcp_service_version'],
      'agent',
      'agent_command',
      'app_note',
      'app_note_command',
      'app_note_context',
      'app_note_discussion',
      'app_note_image',
      'app_note_suggestion',
      'app_note_suggestion_source',
      'app_note_summary',
      'app_note_version',
      'app_note_version_summary',
      'app_preference',
      'assistant_command_receipt',
      'assistant_event_projection',
      'assistant_message_file_source',
      'assistant_model_command',
      'assistant_model_selection',
      'assistant_page_state',
      'assistant_prompt_anchor',
      'assistant_session_binding',
      'assistant_session_registry',
      'image_attachment',
      'inbox_command',
      'inbox_external',
      'inbox_notification',
      'inbox_state',
      'internal_tool_call',
      'internal_tool_proposal',
      'managed_process',
      'managed_process_command',
      'message_image_source',
      'project',
      'project_directory',
      'reading_annotation',
      'reading_annotation_command',
      'reading_book',
      'reading_book_block',
      'reading_book_index',
      'reading_collection_command',
      'reading_collection_item',
      'reading_collection_target',
      'reading_command',
      'reading_discussion',
      'reading_discussion_command',
      'reading_notes_command',
      'reading_notes_state',
      'reading_scope',
      'reading_scope_command',
      'reminder',
      'reminder_command',
      'reminder_timer',
      'schema_migrations',
      'skill',
      'skill_command',
      'skill_effect',
      'skill_preference',
      'skill_preference_command',
      'skill_preview',
      'skill_use',
      'skill_version',
      'sqlite_sequence',
      'task',
      'task_artifact_version',
      'task_command',
      'task_dependency',
      'task_event',
      'task_group',
      'task_human_request',
      'task_run',
      'task_runtime_owner',
      'temp_directory_cleanup',
      'token_usage_collection',
      'token_usage_request',
      'tool_authorization_grant',
      'tool_authorization_request',
      'workspace',
      'workspace_scene',
    ].sort());
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
      runtime_session_id TEXT NOT NULL UNIQUE,
      runtime_session_ref TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO assistant_session_binding (
      assistant_id, runtime_session_id, runtime_session_ref, updated_at
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
    CREATE TABLE assistant_command_receipt (
      command_id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('send', 'cancel')),
      payload_fingerprint TEXT NOT NULL,
      dispatch_mode TEXT CHECK (dispatch_mode IN ('prompt', 'steer', 'followUp', 'abort')),
      phase TEXT NOT NULL CHECK (phase IN ('accepted', 'handed_to_pi', 'running', 'terminal')),
      terminal_outcome TEXT CHECK (terminal_outcome IN ('accepted', 'succeeded', 'failed', 'cancelled', 'rejected')),
      error_code TEXT,
      error_message TEXT,
      runtime_session_id TEXT,
      runtime_entry_id TEXT,
      runtime_turn_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (assistant_id) REFERENCES assistant_session_binding(assistant_id) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE assistant_event_projection (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      source_key TEXT NOT NULL UNIQUE,
      assistant_id TEXT NOT NULL,
      command_id TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      FOREIGN KEY (assistant_id) REFERENCES assistant_session_binding(assistant_id) ON DELETE CASCADE,
      FOREIGN KEY (command_id) REFERENCES assistant_command_receipt(command_id) ON DELETE SET NULL
    ) STRICT;
  `);
  setup.close();

  try {
    const upgraded = new SqliteAssistantStore(databasePath);
    assert.deepEqual(upgraded.bindings.get('global-coordinator'), {
      assistantSessionId: 'global-coordinator',
      // 身份中性化之前的绑定都属于 Pi。
      harness: 'pi',
      runtimeSessionId: 'pi-v2',
      runtimeSessionRef: '/tmp/pi-v2.jsonl',
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
    const runIndexes = inspection.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name IN ('managed_process_counts_state', 'task_run_unconfirmed_task')").all();
    inspection.close();
    assert.equal(runIndexes.length, 2);
    assert.deepEqual(versions.map((item) => item.version), Array.from({ length: versions.length }, (_, i) => i + 1));
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
  initial.bindings.insertIfAbsent({
    assistantSessionId: 'base-assistant', harness: 'pi', runtimeSessionId: 'base-pi', runtimeSessionRef: '/sessions/base.jsonl',
    updatedAt: '2026-09-16T08:00:00.000Z', modelProvider: 'legacy', modelId: 'legacy-model',
    modelProtocol: 'openai-codex-responses', modelEndpoint: 'https://legacy.example/v1',
    modelResolvedEndpoint: 'https://legacy.example/v1',
  });
  initial.bindings.insertIfAbsent({
    assistantSessionId: 'controlled-assistant', harness: 'pi', runtimeSessionId: 'controlled-pi',
    runtimeSessionRef: '/sessions/controlled.jsonl', updatedAt: '2026-09-16T08:00:00.000Z',
    modelProvider: 'openai', modelId: 'managed', modelProtocol: 'openai-responses',
    modelEndpoint: null, modelResolvedEndpoint: 'https://official.example/v1', modelProfileId: 'profile',
  });
  initial.close();
  const fixture = new DatabaseSync(databasePath);
  fixture.exec(`
    DROP TABLE task_artifact_version;
    DROP TABLE task_run;
    DROP TABLE task_runtime_owner;
    DROP TABLE task_human_request;
    DROP TABLE task_event;
    DROP TABLE task_command;
    DROP TABLE task_dependency;
    DROP TABLE task;
    DROP TABLE task_group;
    DROP TABLE assistant_model_command;
    DROP TABLE assistant_model_selection;
    ALTER TABLE assistant_session_binding DROP COLUMN model_endpoint_mode;
    ALTER TABLE assistant_session_binding DROP COLUMN model_source;
    ALTER TABLE assistant_page_state DROP COLUMN quote_json;
    DROP TABLE IF EXISTS reading_book_block; DROP TABLE IF EXISTS reading_book_index; DELETE FROM schema_migrations WHERE version >= 4;
  `);
  fixture.close();
  let restored: SqliteAssistantStore | undefined;
  try {
    restored = new SqliteAssistantStore(databasePath);
    const base = restored.bindings.get('base-assistant');
    assert.equal(base?.modelSource, 'base');
    assert.equal(base?.modelProtocol, 'openai-codex-responses');
    assert.equal(base?.modelProfileId, undefined);
    const controlled = restored.bindings.get('controlled-assistant');
    assert.equal(controlled?.modelSource, 'controlled');
    assert.equal(controlled?.modelEndpoint, null);
    assert.equal(controlled?.modelProfileId, 'profile');
    restored.close();
    restored = new SqliteAssistantStore(databasePath);
    assert.deepEqual(restored.bindings.get('base-assistant'), base);
    assert.deepEqual(restored.bindings.get('controlled-assistant'), controlled);
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
    const runIndexes = inspection.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name IN ('managed_process_counts_state', 'task_run_unconfirmed_task')").all();
    inspection.close();
    assert.equal(runIndexes.length, 2);
    assert.deepEqual(versions.map((row) => row.version), Array.from({ length: versions.length }, (_, i) => i + 1));
    assert.deepEqual(tables.map((row) => row.name), [
      ...['mcp_command', 'mcp_event', 'mcp_fact', 'mcp_service_version'],
      'agent',
      'agent_command',
      'app_note',
      'app_note_command',
      'app_note_context',
      'app_note_discussion',
      'app_note_image',
      'app_note_suggestion',
      'app_note_suggestion_source',
      'app_note_summary',
      'app_note_version',
      'app_note_version_summary',
      'app_preference',
      'assistant_command_receipt',
      'assistant_event_projection',
      'assistant_message_file_source',
      'assistant_model_command',
      'assistant_model_selection',
      'assistant_page_state',
      'assistant_prompt_anchor',
      'assistant_session_binding',
      'assistant_session_registry',
      'image_attachment',
      'inbox_command',
      'inbox_external',
      'inbox_notification',
      'inbox_state',
      'internal_tool_call',
      'internal_tool_proposal',
      'managed_process',
      'managed_process_command',
      'message_image_source',
      'project',
      'project_directory',
      'reading_annotation',
      'reading_annotation_command',
      'reading_book',
      'reading_book_block',
      'reading_book_index',
      'reading_collection_command',
      'reading_collection_item',
      'reading_collection_target',
      'reading_command',
      'reading_discussion',
      'reading_discussion_command',
      'reading_notes_command',
      'reading_notes_state',
      'reading_scope',
      'reading_scope_command',
      'reminder',
      'reminder_command',
      'reminder_timer',
      'schema_migrations',
      'skill',
      'skill_command',
      'skill_effect',
      'skill_preference',
      'skill_preference_command',
      'skill_preview',
      'skill_use',
      'skill_version',
      'sqlite_sequence',
      'task',
      'task_artifact_version',
      'task_command',
      'task_dependency',
      'task_event',
      'task_group',
      'task_human_request',
      'task_run',
      'task_runtime_owner',
      'temp_directory_cleanup',
      'token_usage_collection',
      'token_usage_request',
      'tool_authorization_grant',
      'tool_authorization_request',
      'workspace',
      'workspace_scene',
    ].sort());
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

test('会话注册表恢复只清除归档时间，工作区、工作目录、父会话与来源原样保留；列表按需包含已归档', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-sqlite-registry-restore-'));
  const store = new SqliteAssistantStore(join(root, 'multivac.sqlite'));
  try {
    const registry = store.sessions;
    const origin = {
      sourceRuntimeEntryId: 'entry-1', sourceRole: 'assistant' as const, text: '选中内容',
      parentTitle: '父会话', parentExcerpt: '用户：问题',
    };
    registry.insertIfAbsent({
      sessionId: 'parent', title: '父会话', kind: 'work', workspaceId: 'default',
      createdAt: '2026-09-25T08:00:00.000Z', workingDirectory: { kind: 'session-temp', path: '/work/sessions/parent' },
    });
    registry.insertIfAbsent({
      sessionId: 'child', title: '子会话', kind: 'work', workspaceId: 'default',
      createdAt: '2026-09-25T08:00:01.000Z', workingDirectory: { kind: 'session-temp', path: '/work/sessions/child' },
      parentSessionId: 'parent', origin,
    });
    const before = registry.get('child');

    // 重复归档保留第一次的归档时间。
    registry.archive('parent', '2026-09-26T08:00:00.000Z');
    registry.archive('child', '2026-09-26T09:00:00.000Z');
    assert.equal(registry.archive('child', '2026-09-27T09:00:00.000Z')?.archivedAt, '2026-09-26T09:00:00.000Z');
    assert.deepEqual(registry.list('default', 'work').map((record) => record.sessionId), []);
    assert.deepEqual(
      registry.list('default', 'work', { includeArchived: true }).map((record) => [record.sessionId, record.archivedAt]),
      [['parent', '2026-09-26T08:00:00.000Z'], ['child', '2026-09-26T09:00:00.000Z']],
    );

    // 恢复子会话不连带父会话；除归档时间外字段不变，重复恢复结果相同。
    const restored = registry.restore('child');
    assert.deepEqual(restored, before);
    assert.deepEqual(registry.restore('child'), before);
    assert.equal(registry.get('parent')?.archivedAt, '2026-09-26T08:00:00.000Z');
    assert.deepEqual(registry.list('default', 'work').map((record) => record.sessionId), ['child']);
    assert.equal(registry.restore('missing'), undefined);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
