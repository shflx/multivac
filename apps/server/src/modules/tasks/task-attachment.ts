import type { TaskAttachment } from '@multivac/contracts';
export interface SessionAttachmentDraft {
  id: string; sessionId: string; createdAt: string; commandId: string | null;
}
export interface TaskAttachmentRepository {
  expiredSessionDrafts(before: string): SessionAttachmentDraft[];
  sessionDraftExpired(id: string): boolean;
  purgeSessionDraft(id: string): void;
  sessionDraft(id: string): SessionAttachmentDraft | undefined;
  createSessionDraft(draft: SessionAttachmentDraft): void;
  sendSessionDraft(id: string, commandId: string): void;
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
