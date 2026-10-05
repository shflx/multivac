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
    windows.set(key, value);
    while (windows.size > 8) windows.delete(windows.keys().next().value!);
    return value;
  }).finally(() => pending.delete(key));
  pending.set(key, promise); return promise;
}
