import { noteHeaders, noteGeneration, noteResponse } from './note-access.js';

/** 受保护图片使用请求头访问；Blob 只属于当前呈现实例，卸载时由调用者释放。 */
export async function loadNoteImageContent(path: string, signal: AbortSignal): Promise<string> {
  const generation = noteGeneration();
  const response = await fetch(path, { headers: noteHeaders(path), signal, cache: 'no-store' });
  noteResponse(path, response, generation);
  if (!response.ok) throw new Error('图片读取失败，请重新解锁或重试。');
  const blob = await response.blob();
  if (signal.aborted || noteGeneration() !== generation) throw new Error('图片访问资格已变化。');
  return URL.createObjectURL(blob);
}
