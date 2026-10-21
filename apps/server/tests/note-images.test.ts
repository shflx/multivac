import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { NoteImagesService } from '../src/application/note-images-service.js';
import { NotesService } from '../src/application/notes-service.js';
import { noteDiscussions } from './fixtures/note-discussions.js';

const png = (width = 12) => sharp({ create: { width, height: 8, channels: 3, background: 'red' } }).png().toBuffer();

test('笔记附件完整解码、内容幂等、归属、原子落盘、重启与会话清理隔离', async () => {
  await mkdir('.tmp', { recursive: true });
  const dir = await mkdtemp(join(process.cwd(), '.tmp/note-images-'));
  const path = join(dir, 'store.sqlite');
  let store = new SqliteAssistantStore(path);
  try {
    let notes = new NotesService(store.notes, noteDiscussions());
    let images = new NoteImagesService(store.noteImages, notes);
    for (const id of ['a', 'b']) notes.create({ id, commandId: id, title: '', body: '' });
    const data = await png();
    const [first, retry] = await Promise.all([images.upload('a', data), images.upload('a', data)]);
    assert.deepEqual(first, retry);
    assert.equal(first.retained, false);
    assert.notEqual((await images.upload('b', data)).id, first.id);
    assert.throws(() => images.read('b', first.id), /不属于/u);
    await assert.rejects(images.upload('a', Buffer.from('<svg/>')), /图片无效/u);
    await assert.rejects(images.upload('a', data.subarray(0, 50)), /图片无效/u);
    await assert.rejects(images.upload('a', Buffer.alloc(10 * 1024 * 1024 + 1)), /10 MiB/u);
    const body = `说明\n\n![截图](note-image:${first.id})\n\n后文`;
    notes.update('a', { commandId: 'save', expectedRevision: 1, body });
    assert.equal(images.get('a', first.id).retained, true);
    assert.throws(() => notes.update('b', { commandId: 'cross', expectedRevision: 1, body }), /不属于/u);
    assert.equal(notes.get('b').revision, 1);
    assert.throws(() => notes.update('a', { commandId: 'invalid', expectedRevision: 2, body: '![x](note-image:bad)' }), /引用无效/u);
    assert.throws(() => notes.create({ id: 'c', commandId: 'c', title: '', body }), /不属于/u);
    assert.throws(() => notes.repository.writeVersion({ ...notes.get('b'), revision: 2, body }), /不属于/u);
    assert.equal(store.images.expired(Date.now() + 1e9).includes(first.id), false);
    store.database.exec("CREATE TRIGGER fail_note_image BEFORE INSERT ON app_note_image BEGIN SELECT RAISE(ABORT,'storage failed'); END");
    await assert.rejects(images.upload('a', await png(18)), /storage failed/u);
    store.database.exec('DROP TRIGGER fail_note_image');
    store.close(); store = new SqliteAssistantStore(path);
    notes = new NotesService(store.notes, noteDiscussions()); images = new NoteImagesService(store.noteImages, notes);
    assert.equal(notes.get('a').body, body);
    assert.deepEqual(images.read('a', first.id).data, data);
    assert.equal((await images.upload('a', data)).id, first.id);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('并发上传不沿用四张限制；额度事务、删除墓碑和服务停止拒绝迟到上传', async () => {
  const store = new SqliteAssistantStore(':memory:');
  const notes = new NotesService(store.notes, noteDiscussions());
  const images = new NoteImagesService(store.noteImages, notes);
  try {
    notes.create({ id: 'a', commandId: 'a', title: '', body: '' });
    const values = await Promise.all(Array.from({ length: 5 }, async (_, i) => images.upload('a', await png(i + 1))));
    assert.equal(new Set(values.map(image => image.id)).size, 5);
    // 增加计数而不分配大图片，直接验证事务内的总量检查。
    const seed = values[0]!;
    for (let i = 0; i < 195; i++) store.database.prepare('INSERT INTO app_note_image(id,note_id,metadata,content,created_at) VALUES (?,?,?,?,?)').run(`seed-${i}`, 'a', JSON.stringify(seed), Buffer.alloc(1), 0);
    await assert.rejects(images.upload('a', await png(60)), /200 张/u);
    assert.equal((await images.upload('a', await png(1))).id, seed.id);
    notes.create({ id: 'gone', commandId: 'gone', title: '', body: '' });
    const pending = images.upload('gone', await png());
    notes.remove('gone', { commandId: 'delete', expectedRevision: 1 });
    await assert.rejects(pending, /已删除/u);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM app_note_image WHERE note_id='gone'").get()!.n, 0);
    const stopped = images.upload('a', await png(61)); images.dispose();
    await assert.rejects(stopped, /已关闭/u);
  } finally { store.close(); }
});
