import type { NoteSummary } from '@multivac/contracts';

/** 连接重读常返回新对象；未变化的摘要保留身份，避免列表和隐藏编辑器跟随刷新。 */
export function reuseNoteSummaries(previous: NoteSummary[] | null, incoming: NoteSummary[]): NoteSummary[] {
  if (!previous) return incoming;
  const known = new Map(previous.map(note => [note.id, note]));
  const result = incoming.map(note => {
    const old = known.get(note.id);
    return old && old.protection === note.protection && old.title === note.title && old.revision === note.revision && old.createdAt === note.createdAt && old.updatedAt === note.updatedAt ? old : note;
  });
  return result.length === previous.length && result.every((note, index) => note === previous[index]) ? previous : result;
}
