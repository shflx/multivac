import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { ImageService } from '../src/application/image-service.js';

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
