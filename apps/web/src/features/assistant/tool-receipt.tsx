import { ArrowRight, CircleAlert, CircleCheck, LoaderCircle, RotateCcw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { AssistantToolReceipt, AssistantToolReceiptAction } from '@multivac/contracts';
import { restoreNoticeText } from '../workspace/temp-retention.js';
import { useWorkspaces, useWorkspaceSessions } from '../workspace/workspace-sessions-provider.js';
import { useObjectOpener, usePageOpener } from './object-links.js';
import { receiptOperations, toolReceipts } from './tool-receipts.js';
import type { ToolExecution } from './tool-executions.js';

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * 回执上可以接着做的操作（管理动作的回执与确认卡执行后的回执共用）：按钮，以及“恢复”之后写在回执里的说明与失败原因。
 *
 * 按钮是用户操作，走界面已有的做法：“在工作区打开”“切到工作区”“项目设置”与对象链接同一路径
 * （已归档的会话先在确认卡上说明需要恢复），“打开设置 · 模型”等与面板跳转同一路径；
 * “恢复”直接恢复（归档回执上的撤回，不再确认），临时目录已被移到废纸篓时在回执里写明。
 */
export function useReceiptActions(actions: readonly AssistantToolReceiptAction[]): {
  buttons: ReactNode;
  notice: string | null;
  error: string;
} {
  const { sessions, ensureLoaded, restore } = useWorkspaceSessions();
  const { workspaces, ensureLoaded: ensureWorkspacesLoaded } = useWorkspaces();
  const open = useObjectOpener();
  const openPage = usePageOpener();
  const [restoring, setRestoring] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void ensureLoaded().catch(() => undefined);
    void ensureWorkspacesLoaded().catch(() => undefined);
  }, [ensureLoaded, ensureWorkspacesLoaded]);

  async function restoreNow(sessionId: string, title: string): Promise<void> {
    setRestoring(true);
    setError('');
    try {
      setNotice(restoreNoticeText(title, await restore(sessionId)));
    } catch (failure) {
      setError(`没有恢复：${errorText(failure, '请稍后重试。')}`);
    } finally {
      setRestoring(false);
    }
  }

  const operations = receiptOperations(actions, sessions, workspaces).filter((operation) =>
    operation.kind === 'open' || operation.kind === 'open-workspace' || operation.kind === 'open-project' ? open !== null
      : operation.kind === 'open-page' ? openPage !== null : true);
  const buttons = operations.length > 0 && (
    <div className="tool-receipt-actions">
      {operations.map((operation) => {
        if (operation.kind === 'open-workspace') {
          const { workspace } = operation;
          return (
            <button
              key={`workspace:${workspace.workspaceId}`}
              type="button"
              className="inline-link"
              aria-label={`切到工作区「${workspace.name}」`}
              onClick={() => void open?.({ kind: 'workspace', id: workspace.workspaceId })}
            >
              切到工作区
              <ArrowRight aria-hidden="true" />
            </button>
          );
        }
        if (operation.kind === 'open-project') {
          const { project } = operation;
          return (
            <button
              key={`project:${project.projectId}`}
              type="button"
              className="inline-link"
              aria-label={`打开「${project.name}」的项目设置`}
              onClick={() => void open?.({ kind: 'project', id: project.projectId })}
            >
              项目设置
              <ArrowRight aria-hidden="true" />
            </button>
          );
        }
        if (operation.kind === 'open-page') {
          return (
            <button
              key={`page:${operation.page}`}
              type="button"
              className="inline-link"
              aria-label={`打开${operation.label}`}
              onClick={() => openPage?.(operation.page)}
            >
              打开{operation.label}
              <ArrowRight aria-hidden="true" />
            </button>
          );
        }
        const { session } = operation;
        if (operation.kind === 'restored') {
          return <small key={`restored:${session.sessionId}`} className="tool-receipt-state">已恢复</small>;
        }
        if (operation.kind === 'restore') {
          return (
            <button
              key={`restore:${session.sessionId}`}
              type="button"
              className="inline-link"
              disabled={restoring}
              aria-label={`恢复「${session.title}」`}
              onClick={() => void restoreNow(session.sessionId, session.title)}
            >
              {restoring ? <LoaderCircle className="spin" aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}
              恢复
            </button>
          );
        }
        return (
          <button
            key={`open:${session.sessionId}`}
            type="button"
            className="inline-link"
            aria-label={`在工作区打开「${session.title}」`}
            onClick={() => void open?.({ kind: 'session', id: session.sessionId })}
          >
            在工作区打开
            <ArrowRight aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
  return { buttons, notice, error };
}

/** “恢复”之后的说明与失败原因：写在回执的文字列里。 */
export function ReceiptActionNotes({ notice, error }: { notice: string | null; error: string }) {
  return (
    <>
      {notice && <span role="status">{notice}</span>}
      {error && (
        <p className="proposal-error" role="alert">
          <CircleAlert aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </>
  );
}

/**
 * 一行回执（原型 ConfirmedReceipt）：Multivac 在对话中直接执行的管理动作（会话的新建、改名、归档、恢复，
 * 项目的改名与默认约束，工作区的切换、打开会话、调整并排与视图、打开管理页）之后，
 * 排在这一轮的运行轨迹之后，写明做了什么与一句补充，并带上可以接着做的操作（见 useReceiptActions）。
 * 回执本身不跳转（切换界面的是工作区工具，只在用户明确要求时）。
 */
export function ToolReceiptCard({ toolCallId, receipt }: { toolCallId: string; receipt: AssistantToolReceipt }) {
  const { buttons, notice, error } = useReceiptActions(receipt.actions);
  return (
    <section
      className="task-receipt confirmed tool-receipt"
      role="region"
      aria-label={receipt.headline}
      data-tool-call-id={toolCallId}
    >
      <CircleCheck aria-hidden="true" />
      <div>
        <strong>{receipt.headline}</strong>
        {receipt.detail && <span>{receipt.detail}</span>}
        <ReceiptActionNotes notice={notice} error={error} />
      </div>
      {buttons}
    </section>
  );
}

/** 一轮中各管理动作的回执，按调用顺序排在这一轮的运行轨迹之后（确认卡之后）。 */
export function ToolReceipts({ records }: { records: readonly ToolExecution[] }) {
  const receipts = toolReceipts(records);
  if (receipts.length === 0) return null;
  return receipts.map(({ toolCallId, receipt }) => (
    <ToolReceiptCard key={`receipt:${toolCallId}`} toolCallId={toolCallId} receipt={receipt} />
  ));
}
