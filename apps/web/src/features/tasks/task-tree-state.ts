import type { Task } from '@multivac/contracts';

/** 只把实际加载并能归入可见展开路径的子任务缩进；稳定身份全局去重。 */
export function taskTreeRows(visible: readonly string[], cache: ReadonlyMap<string, Task>, expanded: ReadonlySet<string>, children: ReadonlyMap<string, readonly string[]>) {
  const matching = new Set(visible);
  const members = new Set(visible);
  const queue = [...visible];
  const nested = new Map<string, string[]>();
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    if (!expanded.has(id)) continue;
    const ids = (children.get(id) ?? []).filter((child) => cache.get(child)?.parentTaskId === id);
    nested.set(id, ids);
    for (const child of ids) if (!members.has(child)) { members.add(child); queue.push(child); }
  }
  const isNested = (id: string) => {
    const parent = cache.get(id)?.parentTaskId;
    return !!parent && members.has(parent) && !!nested.get(parent)?.includes(id);
  };
  const roots = [...members].filter((id) => !isNested(id));
  // 损坏或在途交错的关系也不能造成递归溢出或让整个集合消失。
  const stack = [...roots, ...members].reverse().map((id) => ({ id, depth: 0 }));
  const seen = new Set<string>();
  const rows: { id: string; depth: number; context: boolean }[] = [];
  while (stack.length) {
    const row = stack.pop()!;
    if (seen.has(row.id) || !cache.has(row.id)) continue;
    seen.add(row.id);
    rows.push({ ...row, context: !matching.has(row.id) });
    const ids = nested.get(row.id) ?? [];
    for (let index = ids.length - 1; index >= 0; index--) stack.push({ id: ids[index]!, depth: row.depth + 1 });
  }
  return rows;
}
