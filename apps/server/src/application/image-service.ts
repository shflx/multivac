import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { IMAGE_LIMITS, type ImageAttachment } from '@multivac/contracts';
import type { SqliteImageRepository } from '../storage/sqlite-image-repository.js';

export class ImageError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class ImageService {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly repository: SqliteImageRepository, private readonly directory: string, private readonly requireSession: (id: string) => void) {}

  get(sessionId: string, id: string): ImageAttachment {
    this.requireSession(sessionId);
    const image = this.repository.get(id);
    if (!image || image.sessionId !== sessionId) throw new ImageError(404, '图片不存在或不属于此会话。');
    return image;
  }
  async read(sessionId: string, id: string): Promise<{ image: ImageAttachment; data: Buffer }> {
    const image = this.get(sessionId, id);
    const data = await readFile(join(this.directory, image.id));
    this.get(sessionId, id);
    return { image, data };
  }
  upload(sessionId: string, data: Buffer): Promise<ImageAttachment> {
    // 串行核对草稿预算与落盘，避免并发上传绕过限额。
    const operation = this.tail.then(() => this.save(sessionId, data));
    this.tail = operation.catch(() => {});
    return operation;
  }
  private async save(sessionId: string, data: Buffer): Promise<ImageAttachment> {
    this.requireSession(sessionId);
    await this.cleanup();
    if (!data.length || data.length > IMAGE_LIMITS.bytes) throw new ImageError(413, '单图上限为 10 MiB。');
    let metadata: sharp.Metadata;
    try {
      const decoder = sharp(data, { limitInputPixels: IMAGE_LIMITS.pixels, failOn: 'warning' });
      metadata = await decoder.metadata();
      if (!['png', 'jpeg', 'webp', 'gif'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) throw new Error();
      if (!metadata.width || !metadata.height || metadata.width > IMAGE_LIMITS.dimension || metadata.height > IMAGE_LIMITS.dimension) throw new Error();
      await decoder.raw().toBuffer();
    } catch { throw new ImageError(415, '图片无效；支持静态 PNG、JPEG、WebP、GIF，最多 1600 万像素、单边 8192 像素。'); }
    const id = createHash('sha256').update(sessionId).update('\0').update(data).digest('hex');
    const existing = this.repository.get(id);
    if (existing) return existing;
    const drafts = this.repository.drafts(sessionId);
    if (drafts.length >= IMAGE_LIMITS.count || drafts.reduce((sum, image) => sum + image.bytes, data.length) > IMAGE_LIMITS.totalBytes) throw new ImageError(413, '草稿最多 4 张图片，总大小不超过 20 MiB。');
    const image: ImageAttachment = { id, sessionId, mimeType: `image/${metadata.format === 'jpeg' ? 'jpeg' : metadata.format}`, width: metadata.width!, height: metadata.height!, bytes: data.length };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(join(this.directory, id), data, { mode: 0o600 });
    this.requireSession(sessionId);
    this.repository.insert(image);
    return image;
  }
  retain(sessionId: string, ids: readonly string[]): void {
    for (const id of ids) this.get(sessionId, id);
    this.repository.retain(ids);
  }
  async remove(sessionId: string, id: string): Promise<void> {
    this.get(sessionId, id);
    if (this.repository.removeDraft(id)) await unlink(join(this.directory, id)).catch(() => {});
  }
  async cleanup(): Promise<void> {
    for (const id of this.repository.expired(Date.now() - IMAGE_LIMITS.draftHours * 3600_000)) {
      if (this.repository.removeDraft(id)) await unlink(join(this.directory, id)).catch(() => {});
    }
  }
}
