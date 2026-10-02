import { Type } from 'typebox';

export const IMAGE_LIMITS = { bytes: 10 * 1024 * 1024, totalBytes: 20 * 1024 * 1024, count: 4, pixels: 16_000_000, dimension: 8192, draftHours: 24 } as const;
export const ImageAttachmentSchema = Type.Object({
  id: Type.String(), sessionId: Type.String(), mimeType: Type.String(),
  width: Type.Integer(), height: Type.Integer(), bytes: Type.Integer(),
}, { additionalProperties: false });
export type ImageAttachment = Type.Static<typeof ImageAttachmentSchema>;
export function imageContentUrl(sessionId: string, id: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(id)}/content`;
}
