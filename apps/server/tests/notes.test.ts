import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteNotesRepository, NOTES_MIGRATION } from '../src/storage/sqlite-notes-repository.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { NotesService } from '../src/application/notes-service.js';

test('独立笔记创建/更新幂等，旧版本不能覆盖，服务重启恢复正文和版本，与阅读笔记隔离', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multivac-app-notes-'));
  const path = join(dir, 'db.sqlite'); let store = new SqliteAssistantStore(path);
  try {
    let service = new NotesService(store.notes);
    const create = { commandId: 'create', id: 'note-a', title: '标题', body: '  原文\n\n' };
    const original = service.create(create);
    assert.deepEqual(service.create(create), original);
    assert.equal(service.list().length, 1);
    assert.throws(() => service.create({ ...create, body: '不同参数' }), /参数发生变化/u);
    assert.throws(() => service.create({ ...create, commandId: 'other' }), /身份已存在/u);
    const command = { commandId: 'save', expectedRevision: 1, title: '修改标题', body: '# 内容\n  保留空白\n' };
    const saved = service.update(original.id, command);
    assert.equal(saved.revision, 2); assert.equal(saved.body, command.body);
    assert.deepEqual(service.update(original.id, command), saved);
    assert.throws(() => service.update(original.id, { ...command, commandId: 'stale', body: '误覆盖' }), /另一窗口/u);
    assert.deepEqual(store.notes.get(original.id, 1), original);
    assert.equal(store.readingNotes.get('unrelated-book').notes.length, 0);
    store.close(); store = new SqliteAssistantStore(path); service = new NotesService(store.notes);
    assert.deepEqual(service.get(original.id), saved);
    assert.deepEqual(service.update(original.id, command), saved);
    assert.deepEqual(store.notes.get(original.id, 1), original);
    service.create({ ...create, id: 'note-b', commandId: 'create-b' });
    assert.equal(service.get('note-a').body, command.body);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});


test('长文摘要保留排序和最新版本，库满时拒绝新建但允许原命令核对', () => {
  const database = new DatabaseSync(':memory:'); database.exec(NOTES_MIGRATION);
  const repository = new SqliteNotesRepository(database);
  try {
    const body = '正文与🙂\n'.repeat(12000);
    for (const id of ['z', 'a']) repository.writeVersion({ id, title: `标题「${id}」\"`, body, revision: 1, createdAt: '2026-01-01', updatedAt: '2026-01-02' });
    assert.deepEqual(repository.list().map(note => note.id), ['a', 'z']);
    assert.ok(repository.list().every(note => !('body' in note)));
    const { body: _body, ...expected } = repository.get('a');
    assert.deepEqual(repository.summary('a'), expected);
    assert.equal(repository.get('a').body, body);
    repository.update('z', { commandId: 'rename', expectedRevision: 1, title: '新版标题' });
    assert.equal(repository.list()[0]!.title, '新版标题');
    assert.equal(repository.summary('z').revision, 2);
    assert.equal(repository.versions('z').latestRevision, 2);
    assert.equal(repository.get('z', 1).body, body);
    assert.throws(() => repository.summary('missing'), /不存在/u);
    database.exec('BEGIN');
    for (let i = 0; i < 997; i++) repository.writeVersion({ id: `seed-${i}`, title: '', body: '', revision: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01' });
    database.exec('COMMIT');
    assert.equal(repository.count(), 999);
    const command = { id: 'last', commandId: 'last', title: '最后一篇', body: '' };
    const saved = repository.create(command);
    assert.equal(repository.count(), 1000);
    assert.throws(() => repository.create({ ...command, id: 'overflow', commandId: 'overflow' }), /最多保存 1000/u);
    assert.deepEqual(repository.create(command), { value: saved.value, changed: false });
    assert.equal(repository.count(), 1000);
  } finally { database.close(); }
});
