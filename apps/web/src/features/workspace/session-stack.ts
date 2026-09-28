import type { WorkspaceSession } from '@multivac/contracts';

/**
 * 栈式父子关系的呈现规则。sessions 取工作区的全部会话（含已归档）：
 * 父会话已归档时路径与层级仍显示它在注册表中的名称并标注“已归档”，但不能返回到它；
 * 父会话恢复后“返回父会话”重新可用。
 */

/** 从顶层会话到本会话的父会话链；父会话不在列表中（如已不在本工作区）时链到此为止。 */
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

/** 栈式路径中的一节：已归档的会话标注“已归档”。 */
export function stackNodeLabel(session: WorkspaceSession): string {
  return session.archivedAt === null ? session.title : `${session.title}（已归档）`;
}

/** 栈式路径：从顶层会话到本会话的名称。 */
export function stackPath(sessions: readonly WorkspaceSession[], sessionId: string): string[] {
  return stackChain(sessions, sessionId).map(stackNodeLabel);
}

/** 会话列表中子会话的层级说明；顶层会话为 null。 */
export function stackLevel(sessions: readonly WorkspaceSession[], sessionId: string): string | null {
  const chain = stackChain(sessions, sessionId);
  const session = chain.at(-1);
  if (!session?.parentSessionId) return null;
  const parent = chain.at(-2);
  return parent ? `第 ${chain.length} 层 · 来自「${stackNodeLabel(parent)}」` : '栈式子会话';
}

/** 可以返回的父会话：父会话仍在工作区中（未归档）时才有。 */
export function returnableParent(sessions: readonly WorkspaceSession[], sessionId: string): string | null {
  const parentId = sessions.find((session) => session.sessionId === sessionId)?.parentSessionId;
  const parent = parentId ? sessions.find((session) => session.sessionId === parentId) : undefined;
  return parent && parent.archivedAt === null ? parent.sessionId : null;
}
