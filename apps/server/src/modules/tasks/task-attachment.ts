import type { TaskAttachment } from '@multivac/contracts';
export interface TaskAttachmentRepository {
  isStorageKey(key: string): boolean;
  storageKey(id: string): string | undefined;
  get(id: string): TaskAttachment | undefined;
  list(taskId: string): TaskAttachment[];
  draft(id: string): TaskAttachment[];
  draftOwner(id: string): string | undefined;
  claim(draftId: string, taskId: string): void;
  insert(attachment: TaskAttachment, draftId: string | null, storageKey: string): void;
  remove(id: string, at: string): void;
  totalBytes(taskId?: string): number;
}
