import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { NOTE_IDLE_TIMEOUT_MS, NoteSecurityService } from '../src/application/note-security-service.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

// 旧笔记锁与笔记密码都使用第 58 版；失败启动还可能已经记录第 59 版保护结构迁移。
for (const version of [58, 59]) test(`旧笔记锁 v${version} 补齐密码结构，迁移前备份且保留正文、历史和回执`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-note-security-migration-'));
  const path = join(root, 'data.sqlite');
  try {
    const initial = new SqliteAssistantStore(path);
    const created = initial.notes.create({ commandId: 'create', id: 'one', title: '原笔记', body: '原正文' }).value;
    const updated = initial.notes.update('one', { commandId: 'update', expectedRevision: 1, body: '新版正文' }).value;
    initial.close();

    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`
        DROP TABLE app_note_password;
        DROP TABLE app_note_key;
        CREATE TABLE app_note_lock (
          note_id TEXT PRIMARY KEY REFERENCES app_note(id),
          locked INTEGER NOT NULL CHECK(locked IN (0,1)), revision INTEGER NOT NULL CHECK(revision>=0)
        ) STRICT;
        INSERT INTO app_note_lock VALUES ('one',1,3);
      `);
      if (version === 58) legacy.exec(`
        DROP TABLE app_note_protected_file;
        DROP TABLE app_note_protection;
        ALTER TABLE app_note_command DROP COLUMN note_id;
      `);
      legacy.prepare('DELETE FROM schema_migrations WHERE version > ?').run(version);
    } finally { legacy.close(); }

    const migrated = new SqliteAssistantStore(path);
    const security = new NoteSecurityService(migrated.noteSecurity);
    try {
      assert.deepEqual(security.status(), { configured: false, idleTimeoutMs: NOTE_IDLE_TIMEOUT_MS });
      assert.deepEqual(migrated.notes.get('one'), updated);
      assert.deepEqual(migrated.notes.get('one', 1), created);
      assert.deepEqual(migrated.notes.operation('create'), created);
      assert.deepEqual(migrated.notes.operation('update'), updated);
      const database = migrated.noteSecurity.database;
      assert.deepEqual(database.prepare('SELECT locked,revision FROM app_note_lock WHERE note_id=?').get('one'), { __proto__: null, locked: 1, revision: 3 });
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM app_note_protection').get()!.count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM app_note_protected_file').get()!.count, 0);
      await security.initialize('迁移后共用密码');
      const access = await security.unlock('one', '迁移后共用密码', 'a'.repeat(43));
      security.assertAccess('one', { ...access, window: 'a'.repeat(43) });
    } finally { security.close(); migrated.close(); }

    const backups = (await readdir(root)).filter(name => name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(root, backups[0]!), { readOnly: true });
    try {
      assert.equal(backup.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()!.version, version);
      assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name='app_note_password'").get()!.count, 0);
      assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM app_note_version').get()!.count, 2);
    } finally { backup.close(); }
    new SqliteAssistantStore(path).close();
    assert.equal((await readdir(root)).filter(name => name.endsWith('.bak')).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('补齐迁移保留已有密码、逐篇密钥和保护状态，旧凭证在重启后失效', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-note-security-preserve-'));
  const path = join(root, 'data.sqlite');
  try {
    const initial = new SqliteAssistantStore(path);
    const security = new NoteSecurityService(initial.noteSecurity);
    let password;
    let key;
    let access;
    try {
      initial.notes.create({ commandId: 'create', id: 'one', title: '笔记', body: '正文' });
      await security.initialize('已有共用密码');
      access = { ...(await security.unlock('one', '已有共用密码', 'a'.repeat(43))), window: 'a'.repeat(43) };
      security.createDataKey('one', access);
      password = initial.noteSecurity.password();
      key = initial.noteSecurity.key('one');
      initial.noteSecurity.database.exec("INSERT INTO app_note_protection VALUES ('one','encrypting'); DELETE FROM schema_migrations WHERE version > 59;");
    } finally { security.close(); initial.close(); }

    const migrated = new SqliteAssistantStore(path);
    const restarted = new NoteSecurityService(migrated.noteSecurity);
    try {
      assert.deepEqual(migrated.noteSecurity.password(), password);
      assert.deepEqual(migrated.noteSecurity.key('one'), key);
      assert.equal(migrated.noteCodec.state('one'), 'encrypting');
      assert.throws(() => restarted.assertAccess('one', access), /已锁定/u);
      await assert.rejects(() => restarted.unlock('one', '错误密码', 'b'.repeat(43)));
      const current = await restarted.unlock('one', '已有共用密码', 'b'.repeat(43));
      restarted.assertAccess('one', { ...current, window: 'b'.repeat(43) });
    } finally { restarted.close(); migrated.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

// 旧版主密钥记录无法转为密钥对：无加密笔记时清除旧记录以便重新设置；仍有加密笔记时保持原样。
for (const encrypted of [false, true]) test(`旧版笔记密码${encrypted ? '仍有加密笔记时保留' : '无加密笔记时清除'}，新版记录不受影响`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-note-keypair-migration-'));
  const path = join(root, 'data.sqlite');
  try {
    const initial = new SqliteAssistantStore(path);
    try {
      initial.notes.create({ commandId: 'create', id: 'one', title: '笔记', body: '正文' });
      const database = initial.noteSecurity.database;
      database.prepare('INSERT INTO app_note_password VALUES (1,1,?)').run(JSON.stringify({ format: 1, revision: 1, kdf: {}, master: {} }));
      database.prepare('INSERT INTO app_note_key VALUES (?,?)').run('one', JSON.stringify({ format: 1 }));
      if (encrypted) database.exec("INSERT INTO app_note_protection VALUES ('one','encrypted')");
      const latest = (database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version;
      database.prepare('DELETE FROM schema_migrations WHERE version=?').run(latest);
    } finally { initial.close(); }

    const migrated = new SqliteAssistantStore(path);
    try {
      assert.equal(!!migrated.noteSecurity.password(), encrypted);
      assert.equal(!!migrated.noteSecurity.key('one'), encrypted);
      if (!encrypted) {
        // 清除后可重新设置为新版密钥对。
        const security = new NoteSecurityService(migrated.noteSecurity);
        try { await security.initialize('新密码'); assert.equal(migrated.noteSecurity.password()!.format, 2); }
        finally { security.close(); }
      } else {
        const security = new NoteSecurityService(migrated.noteSecurity);
        try { assert.throws(() => security.beginEncryption('two', 'a'.repeat(43)), /旧版本/u); }
        finally { security.close(); }
      }
    } finally { migrated.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
