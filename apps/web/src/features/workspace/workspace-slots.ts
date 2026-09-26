/**
 * 并排栏位：slots[k] 是第 k + 1 栏的会话 id，不超过并排数。
 *
 * 先校验已保存的栏位（去掉已不在工作区的会话与重复项），
 * 再把空出的栏按会话列表顺序补上尚未展示的会话；会话不够时栏数随之减少。
 */
export function resolveSlots(stored: readonly string[], members: readonly string[], count: number): string[] {
  const slots = [...new Set(stored)].filter((id) => members.includes(id)).slice(0, count);
  const spare = members.filter((id) => !slots.includes(id));
  while (slots.length < count && spare.length > 0) slots.push(spare.shift()!);
  return slots;
}

/** 把会话放进第 slot + 1 栏：已在另一栏则两栏互换，否则替换这一栏原来的会话。 */
export function placeInSlot(slots: readonly string[], id: string, slot: number): string[] {
  const next = [...slots];
  const from = next.indexOf(id);
  if (from === slot) return next;
  if (from >= 0) next[from] = next[slot]!;
  next[slot] = id;
  return next.filter(Boolean);
}

/**
 * 调整并排数时的栏位：多出的栏退出显示（会话本身不关闭，仍在会话列表里）；
 * 当前会话若落在被去掉的栏，就放进保留下来的最后一栏，保证它始终在显示中。
 */
export function resizeSlots(slots: readonly string[], count: number, currentId: string | null): string[] {
  const kept = slots.slice(0, count);
  if (currentId && slots.includes(currentId) && !kept.includes(currentId)) kept[count - 1] = currentId;
  return kept;
}

/** 把栏位里的一个会话换成另一个，位置不变（栈式深入与返回）；from 不在栏位时原样返回。 */
export function replaceInSlots(slots: readonly string[], from: string, to: string): string[] {
  if (!slots.includes(from)) return [...slots];
  return slots.map((id) => id === from ? to : id).filter((id, index, all) => all.indexOf(id) === index);
}
