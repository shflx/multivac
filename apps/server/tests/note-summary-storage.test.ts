import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { NOTES_MIGRATION, SqliteNotesRepository } from '../src/storage/sqlite-notes-repository.js';
import { NOTE_SUMMARY_MIGRATION, NOTE_SUMMARIES_SELECT } from '../src/storage/sqlite-note-summaries.js';

const original = { id: 'a', title: '原标题', body: '原文🙂'.repeat(1000), revision: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

test('旧库回填当前与历史摘要、排除墓碑，查询计划只依赖摘要排序索引', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys=ON'); database.exec(NOTES_MIGRATION);
    database.prepare('INSERT INTO app_note VALUES (?,?)').run(original.id, JSON.stringify(original));
    database.prepare('INSERT INTO app_note_version VALUES (?,?,?)').run(original.id, 1, JSON.stringify(original));
    database.prepare('INSERT INTO app_note VALUES (?,?)').run('deleted', JSON.stringify({ id: 'deleted', deleted: true }));
    database.exec('BEGIN'); database.exec(NOTE_SUMMARY_MIGRATION); database.exec('COMMIT');
    const repository = new SqliteNotesRepository(database);
    const { body: _body, ...summary } = original;
    assert.deepEqual(repository.list(), [summary]);
    assert.deepEqual(repository.summary('a'), summary);
    assert.equal(repository.count(), 1);
    assert.deepEqual(repository.versions('a').versions, [summary]);
    assert.throws(() => repository.summary('deleted'), /不存在/u);
    assert.deepEqual(repository.get('a', 1), original);
    const details = database.prepare(`EXPLAIN QUERY PLAN ${NOTE_SUMMARIES_SELECT}`).all().map(row => String(row.detail)).join('\n');
    assert.match(details, /app_note_summary_order/u);
    assert.doesNotMatch(details, /TEMP B-TREE/u);
    database.exec('BEGIN'); database.exec(NOTE_SUMMARY_MIGRATION); database.exec('COMMIT');
    assert.deepEqual(repository.list(), [summary]);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { database.close(); }
});

test('保存/恢复/命令重试不回退摘要，失败回滚摘要和版本，删除保留身份保护', () => {
  const store = new SqliteAssistantStore(':memory:');
  const repository = store.notes;
  try {
    const create = { id: 'a', commandId: 'create-a', title: '原标题', body: '原正文' };
    const first = repository.create(create).value;
    const save = { commandId: 'save-a', expectedRevision: 1, title: '新标题', body: '新正文' };
    const second = repository.update('a', save).value;
    const restored = repository.update('a', { commandId: 'restore-a', expectedRevision: 2, title: first.title, body: first.body }).value;
    assert.equal(restored.revision, 3);
    assert.deepEqual(repository.update('a', save).value, second);
    assert.equal(repository.summary('a').revision, 3);
    assert.equal(repository.summary('a').title, first.title);
    assert.throws(() => repository.update('a', { commandId: 'stale', expectedRevision: 1, body: '误覆盖' }), /另一窗口/u);
    assert.equal(repository.summary('a').revision, 3);
    repository.database.exec("CREATE TRIGGER reject_summary BEFORE INSERT ON app_note_summary BEGIN SELECT RAISE(ABORT,'injected'); END;");
    assert.throws(() => repository.update('a', { commandId: 'failed', expectedRevision: 3, body: '失败正文' }), /injected/u);
    assert.equal(repository.summary('a').revision, 3);
    assert.equal(repository.get('a').revision, 3);
    assert.equal(repository.versions('a').versions.length, 3);
    assert.equal(repository.operation('failed'), undefined);
    repository.database.exec('DROP TRIGGER reject_summary');
    assert.equal(repository.get('a', 1).body, first.body);
    repository.remove('a', { commandId: 'delete-a', expectedRevision: 3 });
    assert.equal(repository.count(), 0);
    assert.deepEqual(repository.list(), []);
    assert.equal(repository.database.prepare('SELECT COUNT(*) AS n FROM app_note_version_summary').get()!.n, 0);
    assert.throws(() => repository.create(create), /已删除/u);
    assert.deepEqual(repository.database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { store.close(); }
});
