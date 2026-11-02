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
