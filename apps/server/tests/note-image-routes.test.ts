import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import sharp from 'sharp';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { NotesService } from '../src/application/notes-service.js';
import { NoteImagesService } from '../src/application/note-images-service.js';
import { createNoteImagesRequestHandler } from '../src/adapters/http/note-images-routes.js';
import { createNotesRequestHandler } from '../src/adapters/http/notes-routes.js';
import { noteDiscussions } from './fixtures/note-discussions.js';

/** 在进程内驱动真实路由与字节流，不监听端口或派生服务器。 */
test('笔记图片路由二进制、类型校验、响应头、归属和正文统一拒绝', async () => {
  const store = new SqliteAssistantStore(':memory:');
  const notes = new NotesService(store.notes, noteDiscussions()), images = new NoteImagesService(store.noteImages, notes);
  const routes = [createNoteImagesRequestHandler(images), createNotesRequestHandler(notes)];
  async function request(method: string, url: string, body = Buffer.alloc(0), headers: Record<string, string> = {}) {
    const input = Object.assign(Readable.from([body]), { method, url, headers }) as unknown as IncomingMessage;
    let status = 0, responseHeaders: Record<string, unknown> = {}, data = Buffer.alloc(0);
    const output = { writeHead(code: number, fields: Record<string, unknown>) { status = code; responseHeaders = fields; }, end(value: string | Buffer) { data = Buffer.from(value); } } as unknown as ServerResponse;
    let handled = false;
    for (const route of routes) if (await route(input, output)) { handled = true; break; }
    return { status, headers: responseHeaders, data, handled };
  }
  try {
    for (const id of ['a', 'b']) notes.create({ id, commandId: id, title: '', body: '' });
    const png = await sharp({ create: { width: 20, height: 12, channels: 3, background: 'red' } }).png().toBuffer();
    const uploaded = await request('POST', '/api/notes/a/images', png, { 'content-type': 'text/forged' });
    assert.equal(uploaded.status, 200);
    const image = JSON.parse(uploaded.data.toString()) as { id: string; mimeType: string };
    assert.equal(image.mimeType, 'image/png');
    const content = await request('GET', `/api/notes/a/images/${image.id}/content`);
    assert.equal(content.status, 200); assert.deepEqual(content.data, png);
    assert.equal(content.headers['content-type'], 'image/png'); assert.equal(content.headers['cache-control'], 'no-store'); assert.equal(content.headers['x-content-type-options'], 'nosniff');
    assert.equal((await request('GET', `/api/notes/b/images/${image.id}/content`)).status, 404);
    assert.equal((await request('GET', `/api/notes/a/images/${'0'.repeat(64)}/content`)).status, 404);
    assert.equal((await request('POST', '/api/notes/a/images', Buffer.from('not a png'), { 'content-type': 'image/png' })).status, 415);
    assert.equal((await request('POST', '/api/notes/a/images', Buffer.alloc(0), { 'content-length': String(10 * 1024 * 1024 + 1) })).status, 413);
    const input = { commandId: 'cross-http', expectedRevision: 1, body: `![x](note-image&#58;${image.id})`, title: '' };
    const rejected = await request('PUT', '/api/notes/b', Buffer.from(JSON.stringify(input)), { 'content-type': 'application/json' });
    assert.equal(rejected.status, 400); assert.equal(notes.get('b').revision, 1);
    assert.equal((await request('DELETE', `/api/notes/a/images/${image.id}`)).status, 405);
    notes.remove('a', { commandId: 'delete', expectedRevision: 1 });
    assert.equal((await request('GET', `/api/notes/a/images/${image.id}/content`)).status, 404);
    assert.equal((await request('POST', '/api/notes/a/images', png)).status, 404);
  } finally { images.dispose(); store.close(); }
});
