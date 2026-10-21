/** 笔记附件独立计量；保守留存期间未引用的上传也计入额度。 */
export const NOTE_IMAGE_LIMITS = { bytes: 10 * 1024 * 1024, pixels: 16_000_000, dimension: 8192, count: 200, totalBytes: 100 * 1024 * 1024 } as const;
export interface NoteImage {
  id: string; noteId: string; mimeType: string; width: number; height: number; bytes: number;
  retained: boolean;
}
export function noteImageId(source: string): string | null {
  return /^note-image:([a-f0-9]{64})$/u.exec(source)?.[1] ?? null;
}
export function noteImageContentUrl(noteId: string, source: string): string | null {
  const id = noteImageId(source);
  return id ? `/api/notes/${encodeURIComponent(noteId)}/images/${id}/content` : null;
}
/** 保留协议在所有正文写入口统一检查，含原文块和引用定义，避免绕过归属检查。 */
export function noteImageReferences(body: string): string[] {
  const ids = new Set<string>();
  for (const match of body.matchAll(/note-image:([^\s<>()"'\\\[\]]*)/giu)) {
    const id = noteImageId(match[0]);
    if (!id) throw new Error('笔记图片引用无效，请使用上传后返回的稳定引用。');
    ids.add(id);
  }
  return [...ids];
}
