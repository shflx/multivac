import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { NOTE_IMAGE_LIMITS } from '@multivac/contracts';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { NotesService } from '../src/application/notes-service.js';
import { NoteImagesService } from '../src/application/note-images-service.js';
import { noteDiscussions } from './fixtures/note-discussions.js';

test('四种静态格式及尺寸/像素边界，总字节额度含未保存上传且拒绝后不登记', async () => {
  const store = new SqliteAssistantStore(':memory:');
  const notes = new NotesService(store.notes, noteDiscussions()), images = new NoteImagesService(store.noteImages, notes);
  notes.create({ id: 'a', commandId: 'a', title: '', body: '' });
  try {
    let first = '';
    for (const format of ['png', 'jpeg', 'webp', 'gif'] as const) {
      const data = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).toFormat(format).toBuffer();
      const image = await images.upload('a', data); first ||= image.id;
      assert.equal(image.mimeType, `image/${format}`);
      assert.deepEqual(images.read('a', image.id).data, data);
    }
    const animated = await sharp(Buffer.concat([Buffer.alloc(8 * 8 * 3), Buffer.alloc(8 * 8 * 3, 255)]), { raw: { width: 8, height: 16, channels: 3, pageHeight: 8 } }).gif().toBuffer();
    assert.equal((await sharp(animated).metadata()).pages, 2);
    await assert.rejects(images.upload('a', animated), /图片无效/u);
    const wide = await sharp({ create: { width: 8193, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
    await assert.rejects(images.upload('a', wide), /图片无效/u);
    const pixels = await sharp({ create: { width: 4001, height: 4000, channels: 3, background: 'red' } }).png().toBuffer();
    await assert.rejects(images.upload('a', pixels), /图片无效/u);
    const count = () => store.database.prepare('SELECT COUNT(*) AS n FROM app_note_image').get()!.n;
    assert.equal(count(), 4);
    // 用 SQLite 的零填充内容验证真实 length(content) 计量，不分配压缩炸弹。
    store.database.prepare('UPDATE app_note_image SET content=zeroblob(?) WHERE id=?').run(NOTE_IMAGE_LIMITS.totalBytes, first);
    const extra = await sharp({ create: { width: 9, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
    await assert.rejects(images.upload('a', extra), /100 MiB/u);
    assert.equal(count(), 4);
  } finally { images.dispose(); store.close(); }
});
