import { Type } from 'typebox';

export const TASK_ATTACHMENT_LIMITS = { bytes: 10 * 1024 * 1024, count: 20, totalBytes: 50 * 1024 * 1024, retainedBytes: 200 * 1024 * 1024, storageBytes: 1024 * 1024 * 1024 } as const;
export const TaskAttachmentSchema = Type.Object({
  id: Type.String(), taskId: Type.Union([Type.String(), Type.Null()]),
  name: Type.String({ maxLength: 200 }), mimeType: Type.String(),
  capability: Type.Union([Type.Literal('text'), Type.Literal('image'), Type.Literal('download')]),
  bytes: Type.Integer({ minimum: 1 }), sha256: Type.String(), createdAt: Type.String(),
  removedAt: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });
export type TaskAttachment = Type.Static<typeof TaskAttachmentSchema>;

export const TaskInputSnapshotSchema = Type.Object({
  snapshotId: Type.String(), fixedAt: Type.String(),
  attachments: Type.Array(TaskAttachmentSchema, { maxItems: 200 }),
}, { additionalProperties: false });
export type TaskInputSnapshot = Type.Static<typeof TaskInputSnapshotSchema>;

/** 消息保留上传时的清单；清理原件后仍可显示名称和大小。 */
export const MessageAttachmentsSchema = Type.Object({
  draftId: Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' }),
  attachments: Type.Array(TaskAttachmentSchema, { maxItems: 20 }),
  taskId: Type.Optional(Type.String()),
  expired: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type MessageAttachments = Type.Static<typeof MessageAttachmentsSchema>;
