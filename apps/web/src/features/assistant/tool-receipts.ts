import {
  MANAGEMENT_PAGE_LABELS,
  type AssistantToolReceipt,
  type AssistantToolReceiptAction,
  type ManagementPageIdValue,
  type Workspace,
  type WorkspaceSession,
} from '@multivac/contracts';
import type { ToolExecution } from './tool-executions.js';

/**
 * 管理类内部工具的回执（与界面无关，便于单独测试）：哪些工具调用有回执，以及回执上此刻可用的操作。
 *
 * 回执的文字由服务端按执行结果写成、原样显示；按钮按会话在共享列表中的当前状态决定：
 * - 在工作区打开：会话存在时给出（已归档的由打开路径先说明需要恢复）；
 * - 恢复：会话此刻仍已归档时给出；已在别处或经这张回执恢复的，改为“已恢复”并给出“在工作区打开”。
 * - 切到工作区：工作区在共享列表中时给出（与对话中的工作区链接同一路径）；
 * - 打开管理页：总是给出（只限已实现的页面，由契约保证）。
 * 会话或工作区不在列表中（列表还没读到、已不存在）时不给入口。
 */

export type ReceiptOperation =
  | { kind: 'open'; session: WorkspaceSession }
  | { kind: 'restore'; session: WorkspaceSession }
  | { kind: 'restored'; session: WorkspaceSession }
  | { kind: 'open-workspace'; workspace: Workspace }
  | { kind: 'open-page'; page: ManagementPageIdValue; label: string };

/** 本轮成功的工具调用中带回执的，按调用顺序。 */
export function toolReceipts(records: readonly ToolExecution[]): Array<{ toolCallId: string; receipt: AssistantToolReceipt }> {
  return records.flatMap((record) => record.status === 'succeeded' && record.result?.receipt
    ? [{ toolCallId: record.toolCallId, receipt: record.result.receipt }]
    : []);
}

export function receiptOperations(
  actions: readonly AssistantToolReceiptAction[],
  sessions: readonly WorkspaceSession[] | null,
  workspaces: readonly Workspace[] | null = null,
): ReceiptOperation[] {
  const operations: ReceiptOperation[] = [];
  const opened = new Set<string>();
  const open = (session: WorkspaceSession) => {
    if (opened.has(session.sessionId)) return;
    opened.add(session.sessionId);
    operations.push({ kind: 'open', session });
  };
  for (const action of actions) {
    if (action.kind === 'open-workspace') {
      const workspace = workspaces?.find((candidate) => candidate.workspaceId === action.workspaceId);
      if (workspace) operations.push({ kind: 'open-workspace', workspace });
      continue;
    }
    if (action.kind === 'open-management-page') {
      operations.push({ kind: 'open-page', page: action.page, label: MANAGEMENT_PAGE_LABELS[action.page] });
      continue;
    }
    // 打开项目设置的入口随回执卡片一起接入；在那之前不给入口。
    if (action.kind === 'open-project') continue;
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
