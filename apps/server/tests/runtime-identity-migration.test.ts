import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { GLOBAL_ASSISTANT_SESSION_ID, withRuntimeIdentityKeys } from '@multivac/contracts';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

/** 把刚建好的库退回到身份中性化之前：列名改回 Pi 命名、去掉 harness 列，并撤销这一版迁移记录。 */
function revertToLegacy(path: string): void {
  const database = new DatabaseSync(path);
  database.exec(`
    ALTER TABLE assistant_session_binding RENAME COLUMN runtime_session_id TO pi_session_id;
    ALTER TABLE assistant_session_binding RENAME COLUMN runtime_session_ref TO pi_session_path;
    ALTER TABLE assistant_session_binding DROP COLUMN harness;
    ALTER TABLE assistant_command_receipt RENAME COLUMN runtime_session_id TO pi_session_id;
    ALTER TABLE assistant_command_receipt RENAME COLUMN runtime_entry_id TO pi_entry_id;
    ALTER TABLE assistant_command_receipt RENAME COLUMN runtime_turn_ref TO pi_turn_ref;
    ALTER TABLE assistant_message_file_source RENAME COLUMN runtime_session_id TO pi_session_id;
    ALTER TABLE assistant_message_file_source RENAME COLUMN runtime_entry_id TO pi_entry_id;
    ALTER TABLE assistant_prompt_anchor RENAME COLUMN baseline_runtime_entry_id TO baseline_pi_entry_id;
    ALTER TABLE assistant_prompt_anchor RENAME COLUMN user_runtime_entry_id TO user_pi_entry_id;
    ALTER TABLE message_image_source RENAME COLUMN runtime_session_id TO pi_session_id;
    DELETE FROM schema_migrations WHERE version = (SELECT MAX(version) FROM schema_migrations);
  `);
  database.prepare('INSERT INTO assistant_session_binding (assistant_id, pi_session_id, pi_session_path, updated_at) VALUES (?, ?, ?, ?)')
    .run(GLOBAL_ASSISTANT_SESSION_ID, 'pi-session-1', '/data/sessions/pi-session-1.jsonl', '2026-10-18T00:00:00.000Z');
  // 引用正文里出现同名文本：它在 JSON 中是转义后的字符串，不能被当成键改写。
  const quote = { sourcePiSessionId: 'pi-session-1', sourcePiEntryId: 'entry-1', sourceRole: 'user', text: '"piSessionId": 原样保留' };
  database.prepare(`INSERT INTO assistant_page_state (assistant_id, draft, anchor_entry_id, anchor_offset_px, revision, updated_at, quote_json)
    VALUES (?, '', NULL, 0, 1, ?, ?)`).run(GLOBAL_ASSISTANT_SESSION_ID, '2026-10-18T00:00:00.000Z', JSON.stringify(quote));
  database.close();
}

function columns(database: DatabaseSync, table: string): string[] {
  return (database.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>).map((column) => column.name);
}

test('身份中性化迁移：列改为中性命名，存量绑定属于 Pi，JSON 中的旧字段名改写而正文不变，迁移前留有备份', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'multivac-identity-'));
  try {
    const path = join(directory, 'assistant.db');
    new SqliteAssistantStore(path).close();
    revertToLegacy(path);

    const store = new SqliteAssistantStore(path);
    try {
      const binding = store.bindings.get(GLOBAL_ASSISTANT_SESSION_ID)!;
      assert.equal(binding.harness, 'pi');
      assert.equal(binding.runtimeSessionId, 'pi-session-1');
      assert.equal(binding.runtimeSessionRef, '/data/sessions/pi-session-1.jsonl');
      const quote = store.pageStates.get(GLOBAL_ASSISTANT_SESSION_ID).quote as Record<string, unknown> | null;
      assert.equal(quote?.sourceRuntimeSessionId, 'pi-session-1');
      assert.equal(quote?.sourceRuntimeEntryId, 'entry-1');
      assert.equal(quote?.text, '"piSessionId": 原样保留');
    } finally {
      store.close();
    }
    const migrated = new DatabaseSync(path);
    assert.ok(!columns(migrated, 'assistant_prompt_anchor').some((column) => column.includes('pi_')));
    assert.ok(!columns(migrated, 'assistant_command_receipt').some((column) => column.startsWith('pi_')));
    migrated.close();

    // 备份是迁移前的库：仍是旧列名、没有 harness。
    const backups = (await readdir(directory)).filter((name) => name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(directory, backups[0]!));
    assert.ok(columns(backup, 'assistant_session_binding').includes('pi_session_id'));
    assert.ok(!columns(backup, 'assistant_session_binding').includes('harness'));
    backup.close();

    // 已是最新版本的库再次打开不再备份。
    new SqliteAssistantStore(path).close();
    assert.equal((await readdir(directory)).filter((name) => name.endsWith('.bak')).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('库外旧数据读时兼容：旧字段名换成现名，已有现名时以现名为准', () => {
  assert.deepEqual(withRuntimeIdentityKeys({ quote: { sourcePiEntryId: 'e', text: 'piEntryId' }, items: [{ piSessionId: 's' }] }),
    { quote: { sourceRuntimeEntryId: 'e', text: 'piEntryId' }, items: [{ runtimeSessionId: 's' }] });
  assert.deepEqual(withRuntimeIdentityKeys({ piSessionId: 'old', runtimeSessionId: 'new' }), { runtimeSessionId: 'new' });
});
