import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { TASK_ATTACHMENT_LIMITS as LIMITS, type TaskAttachment, type TaskInputSnapshot } from '@multivac/contracts';
import type { TaskAttachmentRepository } from '../modules/tasks/task-attachment.js';
import type { TaskService } from './task-service.js';
import { TaskServiceError } from '../modules/tasks/task-error.js';
import { validateImage } from './validate-image.js';

const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const invalid = (message: string): never => { throw new TaskServiceError('INVALID_REQUEST', message); };
export type AttachmentOwner = { taskId: string } | { draftId: string };

/** 原件只存私有输入目录。移除保留原件及元数据，历史运行仍可按固定身份读取。 */
export class TaskAttachmentService {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, number>();
  constructor(readonly repository: TaskAttachmentRepository, private readonly directory: string, private readonly tasks: TaskService, private readonly runs: import('../modules/tasks/task.js').TaskRunRepository, private readonly changed?: (taskId: string) => void) {}

  private key(owner: AttachmentOwner): string { return 'taskId' in owner ? `task:${owner.taskId}` : `draft:${owner.draftId}`; }
  private check(owner: AttachmentOwner, editing = false): void {
    const id = 'taskId' in owner ? owner.taskId : owner.draftId;
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) invalid('附件归属身份无效。');
    if ('draftId' in owner) {
      if (this.repository.draftOwner(owner.draftId)) invalid('暂存材料已绑定任务，请在任务详情管理附件。');
      return;
    }
    const task = this.tasks.get(owner.taskId);
    if (editing) {
      const detail = this.tasks.detail(task.taskId);
      if (!['idle', 'paused', 'failed'].includes(task.status) || this.tasks.executionOwner(task.taskId) || detail.runs?.some(run => !run.stopConfirmed || run.pendingToolIds.length || run.nativePendingIds?.length)) invalid('执行中及终态不能修改输入，请先确认任务已安全停止。');
    }
  }
  list(owner: AttachmentOwner): TaskAttachment[] {
    this.check(owner);
    return ('taskId' in owner ? this.repository.list(owner.taskId) : this.repository.draft(owner.draftId)).filter(item => !item.removedAt);
  }
  private owned(owner: AttachmentOwner, id: string): TaskAttachment {
    this.check(owner);
    const item = this.list(owner).find(item => item.id === id);
    if (!item) throw new TaskServiceError('NOT_FOUND', '附件不存在、已移除或不属于当前任务。');
    return item;
  }
  /** 请求正文尚在接收时也占用输入，防止另一个窗口提前固定不完整清单。 */
  receive(owner: AttachmentOwner, id: string, name: string, read: () => Promise<Buffer>): Promise<TaskAttachment> {
    return this.pendingUpload(owner, async () => this.upload(owner, id, name, await read()));
  }
  upload(owner: AttachmentOwner, id: string, name: string, data: Buffer): Promise<TaskAttachment> {
    return this.pendingUpload(owner, () => {
      const result = this.tail.then(() => this.save(owner, id, name, data));
      this.tail = result.catch(() => {});
      return result;
    });
  }
  private async pendingUpload<T>(owner: AttachmentOwner, action: () => Promise<T>): Promise<T> {
    this.check(owner, true);
    const key = this.key(owner);
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    try { return await action(); }
    finally {
      const remaining = (this.pending.get(key) ?? 1) - 1;
      if (remaining) this.pending.set(key, remaining); else this.pending.delete(key);
    }
  }
  private async save(owner: AttachmentOwner, id: string, name: string, data: Buffer): Promise<TaskAttachment> {
    this.check(owner, true);
    if (!/^[a-f0-9-]{36}$/.test(id) || !name.trim() || name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) invalid('附件身份或文件名无效。');
    if (!data.length || data.length > LIMITS.bytes) invalid('附件不能为空，单文件上限 10 MiB。');
    const existing = this.repository.get(id);
    const items = this.list(owner);
    if (existing) {
      if (!items.some(item => item.id === id) || existing.sha256 !== digest(data) || existing.name !== name) invalid('上传身份已使用，请核对原上传结果。');
      return existing;
    }
    if (items.length >= LIMITS.count || items.reduce((sum, item) => sum + item.bytes, data.length) > LIMITS.totalBytes) invalid('每组最多 20 个附件，总大小不超过 50 MiB。');
    const retainedBytes = 'taskId' in owner ? this.repository.totalBytes(owner.taskId) : this.repository.draft(owner.draftId).reduce((sum, item) => sum + item.bytes, 0);
    if (this.repository.totalBytes() + data.length > LIMITS.storageBytes || retainedBytes + data.length > LIMITS.retainedBytes) invalid('附件历史存储预算已用完。');
    let capability: TaskAttachment['capability'] = 'download';
    let mimeType = 'application/octet-stream';
    // 只凭真实内容识别图片；不把客户端 MIME 或文件名用作存储路径。
    const image = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || data.subarray(0,3).equals(Buffer.from([255,216,255])) || /^GIF8/.test(data.subarray(0,6).toString('ascii')) || data.subarray(0,4).toString() === 'RIFF' && data.subarray(8,12).toString() === 'WEBP';
    if (image) {
      const metadata = await validateImage(data);
      capability = 'image'; mimeType = `image/${metadata.format}`;
    } else {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
        if (!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) && !/^%PDF-/.test(text)) { capability = 'text'; mimeType = 'text/plain; charset=utf-8'; }
      } catch { /* 其他格式仅保存与下载，不尝试通用解析。 */ }
    }
    this.check(owner, true);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.check(owner, true);
    const storageKey = randomUUID();
    const path = join(this.directory, storageKey);
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(data); } finally { await file.close(); }
    const item: TaskAttachment = { id, taskId: 'taskId' in owner ? owner.taskId : null, name, mimeType, capability, bytes: data.length, sha256: digest(data), createdAt: new Date().toISOString(), removedAt: null };
    try { this.check(owner, true); this.repository.insert(item, 'draftId' in owner ? owner.draftId : null, storageKey); }
    catch (error) { await unlink(path); throw error; }
    if ('taskId' in owner) this.changed?.(owner.taskId);
    return item;
  }
  /** 在创建任务的同一 SQLite 事务内调用；失败不消费暂存身份。 */
  claim(draftId: string, taskId: string): void {
    const owner = { draftId };
    this.check(owner);
    if (this.pending.has(this.key(owner))) invalid('附件仍在上传，请等待上传结束后创建任务。');
    this.repository.claim(draftId, taskId);
  }
  remove(owner: AttachmentOwner, id: string): void {
    this.check(owner, true);
    this.owned(owner, id);
    this.repository.remove(id, new Date().toISOString());
    if ('taskId' in owner) this.changed?.(owner.taskId);
  }
  async read(owner: AttachmentOwner, id: string): Promise<{ attachment: TaskAttachment; data: Buffer }> {
    const attachment = this.owned(owner, id);
    const data = await this.readFixed(attachment);
    this.owned(owner, id);
    return { attachment, data };
  }
  assertOutputReference(value: string): void {
    const text = value.trim();
    let decoded = text;
    try { decoded = decodeURIComponent(text); } catch { /* 非 URL 文本按字面核对。 */ }
    const leaf = basename(decoded);
    if (this.repository.get(decoded) || this.repository.isStorageKey(leaf) ||
        /^(?:task-attachment|attachment):/i.test(decoded) || /^(?:https?:\/\/[^/]+)?\/api\/(?:tasks|task-attachment-drafts)\/[^/]+\/(?:input-snapshots\/[^/]+\/)?attachments(?:\/[^\s]*)?$/.test(decoded) ||
        resolve(decoded) === this.directory || resolve(decoded).startsWith(`${this.directory}/`)) invalid('输入附件原件、身份或下载链接不能直接作为成果；请另行生成报告或修改版。');
  }
  async readHistory(taskId: string, runId: string, id: string): Promise<{ attachment: TaskAttachment; data: Buffer }> {
    this.tasks.get(taskId);
    const run = this.runs.get(runId);
    if (!run || run.taskId !== taskId && !run.treeTasks?.some(task => task.taskId === taskId)) throw new TaskServiceError('NOT_FOUND', '运行不属于当前任务。');
    const attachment = run.inputSnapshot?.attachments.find(item => item.id === id && (run.taskId === taskId || item.taskId === taskId));
    if (!attachment) throw new TaskServiceError('NOT_FOUND', '附件不属于此执行输入快照。');
    return { attachment, data: await this.readFixed(attachment) };
  }
  freeze(taskIds: string[]): TaskInputSnapshot {
    if (taskIds.some(taskId => this.pending.has(this.key({ taskId })))) invalid('任务范围内仍有附件上传，请等待上传结束后启动。');
    const attachments = taskIds.flatMap(taskId => this.list({ taskId }));
    if (attachments.length > 200 || attachments.reduce((sum, item) => sum + item.bytes, 0) > 200 * 1024 * 1024) invalid('本次固定输入超过 200 个或 200 MiB，请缩小任务树输入。');
    return { snapshotId: randomUUID(), fixedAt: new Date().toISOString(), attachments };
  }
  async verify(snapshot: TaskInputSnapshot, signal?: AbortSignal): Promise<void> {
    for (const item of snapshot.attachments) { signal?.throwIfAborted(); await this.readFixed(item); }
    signal?.throwIfAborted();
  }
  async readFixed(item: TaskAttachment): Promise<Buffer> {
    if (!/^[a-f0-9-]{36}$/.test(item.id)) invalid('附件身份无效。');
    const storageKey = this.repository.storageKey(item.id);
    if (!storageKey || !/^[a-f0-9-]{36}$/.test(storageKey)) throw new TaskServiceError('NOT_FOUND', '附件存储引用不存在。');
    const stored = this.repository.get(item.id);
    if (!stored || stored.taskId !== item.taskId || stored.sha256 !== item.sha256 || stored.bytes !== item.bytes || stored.capability !== item.capability) invalid('固定附件归属或版本与存储记录不符。');
    let file;
    try { file = await open(join(this.directory, storageKey), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch { throw new TaskServiceError('NOT_FOUND', '固定附件原件缺失或不可读取。'); }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== item.bytes || stat.size > LIMITS.bytes) invalid('固定附件大小不符或已损坏。');
      const buffer = Buffer.alloc(item.bytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const data = buffer.subarray(0, length);
      if (data.length !== item.bytes || digest(data) !== item.sha256) invalid('固定附件摘要不符或已损坏。');
      return data;
    } finally { await file.close(); }
  }
}
