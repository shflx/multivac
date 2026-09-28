import type { WorkspaceSession } from '@multivac/contracts';

/**
 * 栈式父子关系的呈现规则。sessions 取全部工作区的会话（含已归档）：
 * - 父会话已归档时路径与层级仍显示它在注册表中的名称并标注“已归档”，但不能返回到它；
 *   父会话恢复后“返回父会话”重新可用。
 * - 归入项目只移动这一个会话，父子关系保持。父子分属不同工作区时，路径与层级照常沿父会话链取名称，
 *   不在当前工作区的会话注明所在的工作区；“返回父会话”是在本工作区内换栏位，只在父会话也在本工作区时提供。
 */

/** 路径所在的工作区：链上不在这个工作区的会话注明所在工作区的名称。 */
export interface StackPlace {
  workspaceId: string;
  nameOf: (workspaceId: string) => string;
}

/** 从顶层会话到本会话的父会话链；父会话不在列表中时链到此为止。 */
export function stackChain(sessions: readonly WorkspaceSession[], sessionId: string): WorkspaceSession[] {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const chain: WorkspaceSession[] = [];
  const seen = new Set<string>();
  for (let session = byId.get(sessionId); session && !seen.has(session.sessionId);
    session = session.parentSessionId ? byId.get(session.parentSessionId) : undefined) {
    seen.add(session.sessionId);
    chain.unshift(session);
  }
  return chain;
}

/** 栈式路径中的一节：已归档的标注“已归档”，不在当前工作区的注明所在工作区。 */
export function stackNodeLabel(session: WorkspaceSession, place?: StackPlace): string {
  const notes: string[] = [];
  if (session.archivedAt !== null) notes.push('已归档');
  if (place && session.workspaceId !== place.workspaceId) notes.push(`在「${place.nameOf(session.workspaceId)}」`);
  return notes.length ? `${session.title}（${notes.join('，')}）` : session.title;
}

/** 栈式路径：从顶层会话到本会话的名称。 */
export function stackPath(sessions: readonly WorkspaceSession[], sessionId: string, place?: StackPlace): string[] {
  return stackChain(sessions, sessionId).map((session) => stackNodeLabel(session, place));
}

/** 会话列表中子会话的层级说明；顶层会话为 null。 */
export function stackLevel(sessions: readonly WorkspaceSession[], sessionId: string, place?: StackPlace): string | null {
  const chain = stackChain(sessions, sessionId);
  const session = chain.at(-1);
  if (!session?.parentSessionId) return null;
  const parent = chain.at(-2);
  return parent ? `第 ${chain.length} 层 · 来自「${stackNodeLabel(parent, place)}」` : '栈式子会话';
}

/** 可以返回的父会话：父会话未归档，且（给出工作区时）与本会话在同一工作区。 */
export function returnableParent(
  sessions: readonly WorkspaceSession[],
  sessionId: string,
  workspaceId?: string,
): string | null {
  const parentId = sessions.find((session) => session.sessionId === sessionId)?.parentSessionId;
  const parent = parentId ? sessions.find((session) => session.sessionId === parentId) : undefined;
  if (!parent || parent.archivedAt !== null) return null;
  return workspaceId === undefined || parent.workspaceId === workspaceId ? parent.sessionId : null;
}
