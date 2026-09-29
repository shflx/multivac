import type { AssistantToolReceipt, AssistantToolReceiptAction, WorkspaceSession } from '@multivac/contracts';
import type { ToolExecution } from './tool-executions.js';

/**
 * 管理类内部工具的回执（与界面无关，便于单独测试）：哪些工具调用有回执，以及回执上此刻可用的操作。
 *
 * 回执的文字由服务端按执行结果写成、原样显示；按钮按会话在共享列表中的当前状态决定：
 * - 在工作区打开：会话存在时给出（已归档的由打开路径先说明需要恢复）；
 * - 恢复：会话此刻仍已归档时给出；已在别处或经这张回执恢复的，改为“已恢复”并给出“在工作区打开”。
 * 会话不在列表中（列表还没读到、会话已不存在）时不给入口。
 */

export type ReceiptOperation =
  | { kind: 'open'; session: WorkspaceSession }
  | { kind: 'restore'; session: WorkspaceSession }
  | { kind: 'restored'; session: WorkspaceSession };

/** 本轮成功的工具调用中带回执的，按调用顺序。 */
export function toolReceipts(records: readonly ToolExecution[]): Array<{ toolCallId: string; receipt: AssistantToolReceipt }> {
  return records.flatMap((record) => record.status === 'succeeded' && record.result?.receipt
    ? [{ toolCallId: record.toolCallId, receipt: record.result.receipt }]
    : []);
}

export function receiptOperations(
  actions: readonly AssistantToolReceiptAction[],
  sessions: readonly WorkspaceSession[] | null,
): ReceiptOperation[] {
  const operations: ReceiptOperation[] = [];
  const opened = new Set<string>();
  const open = (session: WorkspaceSession) => {
    if (opened.has(session.sessionId)) return;
    opened.add(session.sessionId);
    operations.push({ kind: 'open', session });
  };
  for (const action of actions) {
    const session = sessions?.find((candidate) => candidate.sessionId === action.sessionId);
    if (!session) continue;
    if (action.kind === 'open-session') {
      open(session);
    } else if (session.archivedAt !== null) {
      operations.push({ kind: 'restore', session });
    } else {
      operations.push({ kind: 'restored', session });
      open(session);
    }
  }
  return operations;
}
