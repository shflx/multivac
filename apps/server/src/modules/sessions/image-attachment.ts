import type { ImageAttachment, MessageImageReference } from '@multivac/contracts';

/** 会话图片附件与消息图片来源的仓储端口；已进入历史的附件保留，不随草稿回收。 */
export interface ImageRepository {
  get(id: string): ImageAttachment | undefined;
  insert(image: ImageAttachment): void;
  /** 标记附件已进入消息历史，之后不再作为草稿回收。 */
  retain(ids: readonly string[]): void;
  drafts(sessionId: string): ImageAttachment[];
  expired(before: number): string[];
  removeDraft(id: string): boolean;
  sources(sessionId: string, piSessionId: string, entryId: string): MessageImageReference[] | undefined;
  saveSources(sessionId: string, piSessionId: string, entryId: string, sources: MessageImageReference[]): void;
}
