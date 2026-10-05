import type { BookWindow } from '@multivac/contracts';
import { getBookWindow } from '../../data/reading-api.js';

// 正文快照不可变；只保留少量最近使用的正文，分页索引不依赖正文常驻内存。
const windows = new Map<string, BookWindow>();
const pending = new Map<string, Promise<BookWindow>>();
export function getCachedBookWindow(bookId: string, block: number): Promise<BookWindow> {
  const key = `${bookId}/${block}`;
  const cached = windows.get(key);
  if (cached) { windows.delete(key); windows.set(key, cached); return Promise.resolve(cached); }
  const existing = pending.get(key); if (existing) return existing;
  const promise = getBookWindow(bookId, block).then(value => {
    if (pending.get(key) === promise) {
      windows.set(key, value);
      while (windows.size > 8) windows.delete(windows.keys().next().value!);
    }
    return value;
  }).finally(() => { if (pending.get(key) === promise) pending.delete(key); });
  pending.set(key, promise); return promise;
}

export function clearBookWindows(bookId: string): void {
  for (const key of windows.keys()) if (key.startsWith(`${bookId}/`)) windows.delete(key);
  // 已发出的请求仍会结束，但不能再把已删除书籍的正文放回缓存。
  for (const key of pending.keys()) if (key.startsWith(`${bookId}/`)) pending.delete(key);
}
