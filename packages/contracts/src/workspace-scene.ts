import type { WorkspaceSceneState, WorkspaceViewMode } from './workspace-session.js';

/**
 * 工作区现场的栏位规则：界面上的操作与 Multivac 的工作区工具共用这一套，保证两边的效果一致。
 *
 * members 是工作区中未归档的会话，按会话列表的顺序（新建的在前）；空出的栏按这个顺序补位。
 * “界面呈现的现场”（resolvedScene）既是界面渲染的结果，也是保存到服务端的内容。
 */

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
 * 当前会话不在保留的栏位中时优先放进空栏；没有空栏则替换最后一栏，保证它始终可见。
 */
export function resizeSlots(slots: readonly string[], count: number, currentId: string | null): string[] {
  const kept = slots.slice(0, count);
  if (currentId && !kept.includes(currentId)) kept[Math.min(kept.length, count - 1)] = currentId;
  return kept;
}

/** 栈式深入与返回在原栏位替换；目标已在另一栏则交换两栏，from 不在栏位时原样返回。 */
export function replaceInSlots(slots: readonly string[], from: string, to: string): string[] {
  const slot = slots.indexOf(from);
  return slot < 0 ? [...slots] : placeInSlot(slots, to, slot);
}

/**
 * 界面实际呈现的现场：栏位按会话列表补位（见 resolveSlots），当前会话不在工作区中时取第一栏。
 * 工作区视图渲染与保存都用它，应用别处推送来的现场时也用它算出将呈现的结果（据此判断无需写回）。
 */
export function resolvedScene(scene: WorkspaceSceneState, members: readonly string[]): WorkspaceSceneState {
  const slots = resolveSlots(scene.slots, members, scene.parallelCount);
  const focusedSessionId = scene.focusedSessionId && members.includes(scene.focusedSessionId)
    ? scene.focusedSessionId
    : slots[0] ?? null;
  return {
    parallelCount: scene.parallelCount,
    slots,
    focusedSessionId,
    viewMode: scene.viewMode,
    widths: scene.widths,
    barVisible: scene.barVisible,
  };
}

/*
 * 以下是对现场的操作：输入是界面呈现的现场（resolvedScene 的结果），输出是操作后的现场，
 * 由调用方再按会话列表补位（界面渲染时、服务端保存前）。
 */

/** 聚焦查看一个会话（在会话列表里点它、在工作区打开）：它成为当前会话，只显示它，栏位不变。 */
export function focusSessionInScene(scene: WorkspaceSceneState, sessionId: string): WorkspaceSceneState {
  return { ...scene, focusedSessionId: sessionId, viewMode: 'focus' };
}

/**
 * 把会话放进第 slot + 1 栏（从 0 起）：原来在这一栏的会话换下来；已在另一栏则两栏互换。
 * 聚焦时会切回并排，放好后该会话成为当前会话。
 */
export function assignSlotInScene(scene: WorkspaceSceneState, sessionId: string, slot: number): WorkspaceSceneState {
  return { ...scene, slots: placeInSlot(scene.slots, sessionId, slot), focusedSessionId: sessionId, viewMode: 'parallel' };
}

/** 调整并排数并切回并排：多出的会话退出显示但不关闭，当前会话始终保留在显示中。 */
export function resizeParallelInScene(scene: WorkspaceSceneState, count: number): WorkspaceSceneState {
  return {
    ...scene,
    slots: resizeSlots(scene.slots, count, scene.focusedSessionId),
    parallelCount: count,
    viewMode: 'parallel',
  };
}

/** 切换并排 / 聚焦：回到并排时，当前会话若不在并排的栏位中，改为第一栏的会话。 */
export function switchViewModeInScene(scene: WorkspaceSceneState, mode: WorkspaceViewMode): WorkspaceSceneState {
  const keepsCurrent = mode === 'focus' || !scene.focusedSessionId || scene.slots.includes(scene.focusedSessionId);
  return { ...scene, focusedSessionId: keepsCurrent ? scene.focusedSessionId : scene.slots[0] ?? null, viewMode: mode };
}
