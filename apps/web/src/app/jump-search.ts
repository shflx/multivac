export interface SearchJumpItem { label: string; hint: string; keywords?: readonly string[] }

/** 全词项匹配，首词的标题前缀优先；同等级保持输入顺序。 */
export function searchJumpItems<T extends SearchJumpItem>(items: readonly T[], query: string): readonly T[] {
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) return items;
  return items.filter((item) => {
    const text = [item.label, item.hint, ...(item.keywords ?? [])].join(' ').toLowerCase();
    return terms.every((term) => text.includes(term));
  }).map((item, index) => {
    const title = item.label.toLowerCase();
    return { item, index, rank: title.startsWith(terms[0]!) ? 0 : title.includes(terms[0]!) ? 1 : 2 };
  }).sort((a, b) => a.rank - b.rank || a.index - b.index).map(({ item }) => item);
}
