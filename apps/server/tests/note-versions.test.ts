import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { NotesService } from '../src/application/notes-service.js';
import { createNotesRequestHandler } from '../src/adapters/http/notes-routes.js';
import { noteDiscussions } from './fixtures/note-discussions.js';

async function fixture() {
  const base = join(process.cwd(), '.tmp'); await mkdir(base, { recursive: true });
  return mkdtemp(join(base, 'notes-version-test-'));
}

test('版本摘要倒序分页，新增保存不扰动旧页；恢复生成新版本并保留幂等及重启保护', async () => {
  const dir = await fixture(), path = join(dir, 'db.sqlite');
  let store = new SqliteAssistantStore(path);
  try {
    let service = new NotesService(store.notes, noteDiscussions());
    service.create({ commandId: 'create', id: 'a', title: '起点', body: '初始正文' });
    for (let revision = 2; revision <= 5; revision++) service.update('a', { commandId: `save-${revision}`, expectedRevision: revision - 1, title: `标题 ${revision}`, body: `正文 ${revision}\n保留空白。  \n🙂` });
    const first = service.versions('a', undefined, 2);
    assert.deepEqual(first.versions.map(note => note.revision), [5, 4]);
    assert.equal(first.latestRevision, 5); assert.equal(first.nextBefore, 4);
    assert.ok(first.versions.every(note => !('body' in note)));
    const historical = service.get('a', 2);
    service.update('a', { commandId: 'newer', expectedRevision: 5, title: '最新标题', body: '新内容' });
    const older = service.versions('a', first.nextBefore!, 2);
    assert.deepEqual(older.versions.map(note => note.revision), [3, 2]);
    assert.equal(older.latestRevision, 6);
    assert.deepEqual(service.versions('a', older.nextBefore!, 2).versions.map(note => note.revision), [1]);
    assert.equal(service.versions('a', 1).nextBefore, null);
    assert.throws(() => service.update('a', { commandId: 'stale-restore', expectedRevision: 5, title: historical.title, body: historical.body }), /另一窗口/u);
    const restore = { commandId: 'restore', expectedRevision: 6, title: historical.title, body: historical.body };
    const restored = service.update('a', restore);
    assert.equal(restored.revision, 7); assert.equal(restored.body, historical.body); assert.equal(restored.title, historical.title);
    assert.deepEqual(service.get('a', 2), historical);
    assert.equal(service.get('a', 6).body, '新内容');
    assert.deepEqual(service.update('a', restore), restored);
    assert.throws(() => service.update('a', { ...restore, body: '换参数' }), /参数发生变化/u);
    service.update('a', { commandId: 'after-restore', expectedRevision: 7, title: '继续写', body: '恢复后再次修改' });
    store.close(); store = new SqliteAssistantStore(path); service = new NotesService(store.notes, noteDiscussions());
    assert.deepEqual(service.update('a', restore), restored);
    assert.equal(service.get('a').revision, 8); assert.deepEqual(service.get('a', 2), historical);
    for (const limit of [0, -1, 51, 1.5, NaN]) assert.throws(() => service.versions('a', undefined, limit), /分页参数/u);
    for (const before of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => service.versions('a', before), /分页参数/u);
    assert.throws(() => service.versions('missing'), /不存在/u);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('HTTP 版本接口只读，校验游标与版本号，不越过当前笔记读取', async () => {
  const dir = await fixture(), store = new SqliteAssistantStore(join(dir, 'db.sqlite'));
  const service = new NotesService(store.notes, noteDiscussions()), handler = createNotesRequestHandler(service);
  const server = createServer((request, response) => { void handler(request, response).then(handled => { if (!handled) { response.writeHead(404); response.end(); } }); });
  try {
    service.create({ commandId: 'a', id: 'a', title: 'A', body: '独立正文' });
    service.update('a', { commandId: 'a2', expectedRevision: 1, title: 'A2', body: '后来内容' });
    service.create({ commandId: 'b', id: 'b', title: 'B', body: '另一笔记' });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const page = await fetch(`${base}/api/notes/a/versions?limit=1`);
    assert.equal(page.status, 200); assert.equal(page.headers.get('cache-control'), 'no-store');
    const value = await page.json() as { versions: { revision: number }[]; nextBefore: number };
    assert.equal(value.versions[0]!.revision, 2); assert.equal(value.nextBefore, 2);
    assert.equal((await (await fetch(`${base}/api/notes/a/versions/1`)).json() as { body: string }).body, '独立正文');
    for (const path of ['?limit=0', '?limit=51', '?before=-1', '?before=1.5', '?limit=1&limit=2', '?extra=1', '/0', '/-1', '/1e1', '/9007199254740992', '/1?extra=1']) assert.equal((await fetch(`${base}/api/notes/a/versions${path}`)).status, 400, path);
    assert.equal((await fetch(`${base}/api/notes/a/versions/3`)).status, 404);
    assert.equal((await fetch(`${base}/api/notes/missing/versions`)).status, 404);
    assert.equal((await fetch(`${base}/api/notes/a/versions`, { method: 'POST' })).status, 405);
    assert.equal(service.get('a').revision, 2); assert.equal(service.get('b').body, '另一笔记');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(dir, { recursive: true, force: true }); }
});
