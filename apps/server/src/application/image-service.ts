import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import { IMAGE_LIMITS, type ImageAttachment, type AssistantMessageView, type MessageImageReference } from '@multivac/contracts';
import type { SqliteImageRepository } from '../storage/sqlite-image-repository.js';
import type { SessionFilesService } from './session-files-service.js';
import type { CoordinatorImage } from '../runtime/executors/coordinator-adapter.js';

export class ImageError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class ImageService {
  private readonly projections = new Map<string, Promise<AssistantMessageView>>();
  private disposed = false;
  files?: SessionFilesService;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly repository: SqliteImageRepository, private readonly directory: string, private readonly requireSession: (id: string) => void) {}

  private checkSession(sessionId: string): void {
    try { this.requireSession(sessionId); } catch { throw new ImageError(404, '会话不存在或已归档。'); }
  }

  get(sessionId: string, id: string): ImageAttachment {
    this.checkSession(sessionId);
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
  upload(sessionId: string, data: Buffer, retained = false): Promise<ImageAttachment> {
    // 串行核对草稿预算与落盘，避免并发上传绕过限额。
    const operation = this.tail.then(() => this.save(sessionId, data, retained));
    this.tail = operation.catch(() => {});
    return operation;
  }
  private async save(sessionId: string, data: Buffer, retained: boolean): Promise<ImageAttachment> {
    if (this.disposed) throw new ImageError(503, '图片服务已关闭。');
    this.checkSession(sessionId);
    await this.cleanup();
    if (!data.length || data.length > IMAGE_LIMITS.bytes) throw new ImageError(413, '单图上限为 10 MiB。');
    let metadata: Metadata;
    try {
      const decoder = sharp(data, { limitInputPixels: IMAGE_LIMITS.pixels, failOn: 'warning' });
      metadata = await decoder.metadata();
      if (!['png', 'jpeg', 'webp', 'gif'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) throw new Error();
      if (!metadata.width || !metadata.height || metadata.width > IMAGE_LIMITS.dimension || metadata.height > IMAGE_LIMITS.dimension) throw new Error();
      await decoder.raw().toBuffer();
    } catch { throw new ImageError(415, '图片无效；支持静态 PNG、JPEG、WebP、GIF，最多 1600 万像素、单边 8192 像素。'); }
    if (this.disposed) throw new ImageError(503, '图片服务已关闭。');
    const id = createHash('sha256').update(sessionId).update('\0').update(data).digest('hex');
    const existing = this.repository.get(id);
    if (existing) { if (retained) this.repository.retain([id]); return existing; }
    const drafts = this.repository.drafts(sessionId);
    if (!retained && (drafts.length >= IMAGE_LIMITS.count || drafts.reduce((sum, image) => sum + image.bytes, data.length) > IMAGE_LIMITS.totalBytes)) throw new ImageError(413, '草稿最多 4 张图片，总大小不超过 20 MiB。');
    const image: ImageAttachment = { id, sessionId, mimeType: `image/${metadata.format === 'jpeg' ? 'jpeg' : metadata.format}`, width: metadata.width!, height: metadata.height!, bytes: data.length };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(join(this.directory, id), data, { mode: 0o600 });
    if (this.disposed) throw new ImageError(503, '图片服务已关闭。');
    this.checkSession(sessionId);
    this.repository.insert(image);
    if (retained) this.repository.retain([id]);
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
      if (this.disposed) return;
      if (this.repository.removeDraft(id)) await unlink(join(this.directory, id)).catch(() => {});
    }
  }

  projectMessage(sessionId: string, message: AssistantMessageView, nativeImages: () => readonly CoordinatorImage[]): Promise<AssistantMessageView> {
    if (!message.imageIds?.length && !message.fileReferences?.some(reference => reference.kind === 'image')) return Promise.resolve(message);
    const key = JSON.stringify([sessionId, message.piSessionId, message.piEntryId]);
    const pending = this.projections.get(key);
    if (pending) return pending.then(projected => ({ ...message, ...(projected.imageReferences ? { imageReferences: projected.imageReferences } : {}) }));
    const operation = this.materialize(sessionId, message, nativeImages);
    this.projections.set(key, operation);
    void operation.finally(() => this.projections.delete(key)).catch(() => {});
    return operation;
  }
  private async materialize(sessionId: string, message: AssistantMessageView, nativeImages: () => readonly CoordinatorImage[]): Promise<AssistantMessageView> {
    if (this.disposed) return message;
    const recorded = this.repository.sources(sessionId, message.piSessionId, message.piEntryId);
    if (recorded) return { ...message, imageReferences: recorded };
    const sources: MessageImageReference[] = [];
    let budget = 0;
    for (const image of nativeImages().slice(0, IMAGE_LIMITS.count)) {
      try {
        if (image.data.length > Math.ceil(IMAGE_LIMITS.bytes / 3) * 4) throw new ImageError(413, '图片超过 10 MiB。');
        const data = Buffer.from(image.data, 'base64'); budget += data.length;
        if (budget > IMAGE_LIMITS.totalBytes) throw new ImageError(413, '消息图片总大小超过 20 MiB。');
        await this.upload(sessionId, data, true);
      } catch { sources.push({ href: image.id, error: '工具或回复图片无效或超过限额。' }); }
    }
    for (const reference of (message.fileReferences ?? []).filter(value => value.kind === 'image').slice(0, IMAGE_LIMITS.count)) {
      try {
        if (!this.files) throw new Error();
        const data = await this.files.readImage(sessionId, reference.path, reference.root); budget += data.length;
        if (budget > IMAGE_LIMITS.totalBytes) throw new ImageError(413, '消息图片总大小超过 20 MiB。');
        const image = await this.upload(sessionId, data, true);
        sources.push({ href: reference.href, imageId: image.id });
      } catch { sources.push({ href: reference.href, error: '图片来源不可用、目录已变化或超过限额。' }); }
    }
    if (!this.disposed) this.repository.saveSources(sessionId, message.piSessionId, message.piEntryId, sources);
    return { ...message, imageReferences: sources };
  }

  dispose(): void { this.disposed = true; }
}
