import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { ImageService } from '../src/application/image-service.js';
import { SessionFilesService } from '../src/application/session-files-service.js';
import { messageFileReferences } from '../src/application/message-file-sources.js';
import { createReadTool, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { imageIdentity, mapPiActiveBranch } from '../src/runtime/executors/pi-message-history.js';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';

test('图片内容校验、会话隔离、预算、幂等、重启与引用生命周期', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-images-'));
  let store = new SqliteAssistantStore(join(root, 'store.sqlite'));
  try {
    let service = new ImageService(store.images, join(root, 'images'), () => {});
    const png = await sharp({ create: { width: 32, height: 24, channels: 3, background: 'red' } }).png().toBuffer();
    const image = await service.upload('a', png);
    assert.equal(image.mimeType, 'image/png'); assert.equal(image.width, 32);
    assert.equal((await service.upload('a', png)).id, image.id);
    assert.deepEqual((await service.read('a', image.id)).data, png);
    assert.throws(() => service.get('b', image.id), /不属于/);
    await assert.rejects(service.upload('a', Buffer.from('<svg></svg>')), /图片无效/);
    await assert.rejects(service.upload('a', png.subarray(0, 60)), /图片无效/);
    await assert.rejects(service.upload('a', Buffer.alloc(10 * 1024 * 1024 + 1)), /10 MiB/);
    service.retain('a', [image.id]);
    await service.remove('a', image.id);
    assert.deepEqual((await service.read('a', image.id)).data, png);
    store.close(); store = new SqliteAssistantStore(join(root, 'store.sqlite'));
    service = new ImageService(store.images, join(root, 'images'), () => {});
    assert.equal(service.get('a', image.id).height, 24);
    const drafts = await Promise.all(['blue', 'green', 'white', 'black'].map(async background => service.upload('a', await sharp({ create: { width: 10, height: 10, channels: 3, background } }).png().toBuffer())));
    await assert.rejects(service.upload('a', await sharp({ create: { width: 11, height: 10, channels: 3, background: 'red' } }).png().toBuffer()), /最多 4/);
    await service.remove('a', drafts[0]!.id);
    assert.throws(() => service.get('a', drafts[0]!.id));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('真实 HTTP 图片二进制通道与全局助手目录图片快照', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-image-http-'));
  const adapter = new FakeCoordinatorAdapter();
  const app = createMultivacApplication({ MULTIVAC_DATA_DIR: join(root, 'data'), MULTIVAC_WORK_ROOT: join(root, 'work'), MULTIVAC_FAKE_ASSISTANT: '1' }, { coordinatorAdapter: adapter });
  await app.ready;
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const png = await sharp({ create: { width: 50, height: 30, channels: 3, background: 'green' } }).png().toBuffer();
    const uploaded = await fetch(`${base}/api/sessions/global-coordinator/images`, { method: 'POST', body: png }); assert.equal(uploaded.status, 200);
    const image = await uploaded.json() as { id: string; mimeType: string };
    assert.equal(image.mimeType, 'image/png');
    const content = await fetch(`${base}/api/sessions/global-coordinator/images/${image.id}/content`);
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), png);
    const wrong = await fetch(`${base}/api/sessions/unknown/images/${image.id}/content`); assert.equal(wrong.status, 404);
    await writeFile(join(root, 'work', 'multivac', 'result.png'), png);
    adapter.appendAssistantHistoryForTest('global-coordinator', '![结果](result.png)', 'global-image-result');
    const page = await (await fetch(`${base}/api/assistant/session`)).json() as { messages: { piEntryId: string; imageReferences?: { imageId?: string }[] }[] };
    const snapshot = page.messages.find(message => message.piEntryId === 'global-image-result')?.imageReferences?.[0]?.imageId;
    assert.ok(snapshot);
    await writeFile(join(root, 'work', 'multivac', 'result.png'), 'changed');
    const frozen = await fetch(`${base}/api/sessions/global-coordinator/images/${snapshot}/content`);
    assert.deepEqual(Buffer.from(await frozen.arrayBuffer()), png);
  } finally { await new Promise<void>(resolve => app.server.close(() => resolve())); app.close(); await rm(root, { recursive: true, force: true }); }
});

test('真实 Pi read 图片结果资源化，目录快照不受修改影响并拒绝链接与旧目录', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multivac-image-sources-'));
  const work = join(base, 'work'); await mkdir(work);
  const store = new SqliteAssistantStore(join(base, 'store.sqlite'));
  try {
    const png = await sharp({ create: { width: 16, height: 10, channels: 3, background: 'blue' } }).png().toBuffer();
    await writeFile(join(work, 'result.png'), png);
    const native = await createReadTool(work).execute('read-image', { path: 'result.png' });
    const entry = { type: 'message', id: 'tool-image', timestamp: new Date().toISOString(), message: { role: 'toolResult', toolName: 'read', toolCallId: 'read-image', timestamp: Date.now(), isError: false, content: native.content } } as SessionEntry;
    const [message] = mapPiActiveBranch('pi', [entry], 'work-session');
    assert.equal(message?.toolName, 'read'); assert.equal(message?.imageIds?.length, 1);
    const images = new ImageService(store.images, join(base, 'images'), () => {});
    const blocks = native.content.filter(block => block.type === 'image');
    assert.equal(blocks.length, 1, '实际 Pi read 必须返回图片内容');
    await images.projectMessage('work-session', message!, () => blocks.map(block => ({ id: imageIdentity('work-session', block.data), mimeType: block.mimeType, data: block.data })));
    assert.ok((await images.read('work-session', message!.imageIds![0]!)).data.length);
    images.files = new SessionFilesService({ get: () => ({ archivedAt: null, workingDirectory: { kind: 'session-temp', path: work } }) }, join(base, 'internal'));
    const reply = { ...message!, toolName: undefined, imageIds: [], piEntryId: 'reply', text: '![结果](result.png)', fileReferences: messageFileReferences('![结果](result.png)', work, true) };
    const snapshot = await images.projectMessage('work-session', reply, () => []);
    const id = snapshot.imageReferences?.[0]?.imageId; assert.ok(id);
    await writeFile(join(work, 'result.png'), 'changed');
    const restored = await images.projectMessage('work-session', reply, () => []);
    assert.equal(restored.imageReferences?.[0]?.imageId, id);
    assert.deepEqual((await images.read('work-session', id)).data, png);
    await symlink(join(work, 'result.png'), join(work, 'link.png'));
    await assert.rejects(images.files.readImage('work-session', 'link.png', work), /符号链接/);
    await assert.rejects(images.files.readImage('work-session', 'result.png', '/old-root'), /目录已变化/);
    const invalid = await images.projectMessage('work-session', { ...reply, piEntryId: 'bad', fileReferences: messageFileReferences('![图片](../secret.png)', work, true) }, () => []);
    assert.equal(invalid.imageReferences?.length ?? 0, 0);
    assert.equal(JSON.stringify(snapshot).includes(png.toString('base64')), false);
  } finally { store.close(); await rm(base, { recursive: true, force: true }); }
});
