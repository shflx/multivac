import type { ProtectedManagedFiles } from '../modules/notes/protected-transcript.js';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { validateImage, ImageError } from './validate-image.js';
export { ImageError } from './validate-image.js';
import { IMAGE_LIMITS, type ImageAttachment, type AssistantMessageView, type MessageImageReference } from '@multivac/contracts';
import type { ImageRepository } from '../modules/sessions/image-attachment.js';
import type { SessionFilesService } from './session-files-service.js';
import type { CoordinatorImage } from '../modules/sessions/coordinator-adapter.js';

export class ImageService {
  private readonly projections = new Map<string, Promise<AssistantMessageView>>();
  private disposed = false;
  files?: SessionFilesService;
  private readonly pendingUploads = new Map<string, number>();
  hasPendingUploads(sessionId: string): boolean { return (this.pendingUploads.get(sessionId) ?? 0) > 0; }
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly repository: ImageRepository, private readonly directory: string, private readonly requireSession: (id: string) => void, private readonly protectedFiles?: ProtectedManagedFiles) {}

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
    const path = join(this.directory, image.id);
    const data = this.protectedFiles?.has(path) ? this.protectedFiles.readBytes(path) : await readFile(path);
    this.get(sessionId, id);
    return { image, data };
  }
  upload(sessionId: string, data: Buffer, retained = false): Promise<ImageAttachment> {
    // 串行核对草稿预算与落盘，避免并发上传绕过限额。
    this.pendingUploads.set(sessionId, (this.pendingUploads.get(sessionId) ?? 0) + 1);
    const operation = this.tail.then(() => this.save(sessionId, data, retained)).finally(() => {
      const remaining = (this.pendingUploads.get(sessionId) ?? 1) - 1;
      if (remaining) this.pendingUploads.set(sessionId, remaining); else this.pendingUploads.delete(sessionId);
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  private async save(sessionId: string, data: Buffer, retained: boolean): Promise<ImageAttachment> {
    if (this.disposed) throw new ImageError(503, '图片服务已关闭。');
    this.checkSession(sessionId);
    await this.cleanup();
    if (!data.length || data.length > IMAGE_LIMITS.bytes) throw new ImageError(413, '单图上限为 10 MiB。');
    const metadata = await validateImage(data);
    if (this.disposed) throw new ImageError(503, '图片服务已关闭。');
    const id = createHash('sha256').update(sessionId).update('\0').update(data).digest('hex');
    const existing = this.repository.get(id);
    if (existing) { if (retained) this.repository.retain([id]); return existing; }
    const drafts = this.repository.drafts(sessionId);
    if (!retained && (drafts.length >= IMAGE_LIMITS.count || drafts.reduce((sum, image) => sum + image.bytes, data.length) > IMAGE_LIMITS.totalBytes)) throw new ImageError(413, '草稿最多 4 张图片，总大小不超过 20 MiB。');
    const image: ImageAttachment = { id, sessionId, mimeType: `image/${metadata.format === 'jpeg' ? 'jpeg' : metadata.format}`, width: metadata.width!, height: metadata.height!, bytes: data.length };
    this.checkSession(sessionId);
    if (this.protectedFiles?.forSession(sessionId)) this.protectedFiles.createBytes(sessionId, join(this.directory, id), data);
    else {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      // 异步准备之后再次检查，避免转换后的迟到上传创建明文副本。
      this.checkSession(sessionId);
      if (this.protectedFiles?.forSession(sessionId)) this.protectedFiles.createBytes(sessionId, join(this.directory, id), data);
      else await writeFile(join(this.directory, id), data, { mode: 0o600 });
    }
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
    if (this.repository.removeDraft(id)) {
      const path = join(this.directory, id);
      if (this.protectedFiles?.has(path)) this.protectedFiles.remove(path);
      else await unlink(path).catch(() => {});
    }
  }
  async cleanup(): Promise<void> {
    for (const id of this.repository.expired(Date.now() - IMAGE_LIMITS.draftHours * 3600_000)) {
      if (this.disposed) return;
      if (this.repository.removeDraft(id)) await unlink(join(this.directory, id)).catch(() => {});
    }
  }

  projectMessage(sessionId: string, message: AssistantMessageView, nativeImages: () => readonly CoordinatorImage[]): Promise<AssistantMessageView> {
    if (!message.imageIds?.length && !message.fileReferences?.some(reference => reference.kind === 'image')) return Promise.resolve(message);
    const key = JSON.stringify([sessionId, message.runtimeSessionId, message.runtimeEntryId]);
    const pending = this.projections.get(key);
    if (pending) return pending.then(projected => ({ ...message, ...(projected.imageReferences ? { imageReferences: projected.imageReferences } : {}) }));
    const operation = this.materialize(sessionId, message, nativeImages);
    this.projections.set(key, operation);
    void operation.finally(() => this.projections.delete(key)).catch(() => {});
    return operation;
  }
  private async materialize(sessionId: string, message: AssistantMessageView, nativeImages: () => readonly CoordinatorImage[]): Promise<AssistantMessageView> {
    if (this.disposed) return message;
    const recorded = this.repository.sources(sessionId, message.runtimeSessionId, message.runtimeEntryId);
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
    if (!this.disposed) this.repository.saveSources(sessionId, message.runtimeSessionId, message.runtimeEntryId, sources);
    return { ...message, imageReferences: sources };
  }

  dispose(): void { this.disposed = true; }
}
