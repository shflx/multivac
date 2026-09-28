/** 条目名的简短列表：最多列出 max 个，其余只说数量，如“a、b、c 等 12 项”。 */
export function entryList(names: readonly string[], total: number, max = 5): string {
  const shown = names.slice(0, max).join('、');
  return total > Math.min(names.length, max) ? `${shown} 等 ${total} 项` : shown;
}
