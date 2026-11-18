import { Clock3, CornerDownLeft, FileText, ImageIcon, Pencil, Quote, X, Zap } from 'lucide-react';
import type { FailedSubmission } from './submission-recovery.js';
import './queued-messages.css';

/**
 * 输入框上方的排队消息（参考成熟 ADE 的做法）：运行中发送的消息先排在这里，本轮正常完成后依次自动发送。
 * 每条可以立即发送（运行中插入当前轮，空闲时作为新一轮）、放回输入框编辑或删除；本轮被停止或失败后暂停自动发送。
 */
export function QueuedMessages({
  items, held, running, sendDisabled, editDisabled, onSend, onEdit, onRemove,
}: {
  items: readonly FailedSubmission[];
  held: boolean;
  running: boolean;
  sendDisabled: boolean;
  /** 输入框已有内容时不能放回编辑，避免覆盖。 */
  editDisabled: boolean;
  onSend(id: string): void;
  onEdit(id: string): void;
  onRemove(id: string): void;
}) {
  // 每条一行：状态写在行内，不另占标题行。
  const status = held ? '已暂停' : running ? '完成后发送' : '即将发送';
  const statusTitle = held ? '本轮已停止或未正常完成，已暂停自动发送；可逐条发送、编辑或删除' : running ? '本轮完成后依次发送' : undefined;
  return (
    <section className="queued-messages" aria-label={`排队的消息，${items.length} 条`}>
      <ol>
        {items.map((item) => {
          const preview = item.text.trim() || (item.imageIds?.length ? '（仅图片）' : '（仅附件）');
          return (
            <li key={item.commandId}>
              <Clock3 className="queued-message-icon" aria-hidden="true" />
              <span className="queued-message-text" title={item.text}>{preview}</span>
              <span className="queued-message-meta">
                {item.quote && <Quote aria-label="带引用" />}
                {item.imageIds?.length ? <span title={`${item.imageIds.length} 张图片`}><ImageIcon aria-hidden="true" />{item.imageIds.length}</span> : null}
                {item.attachmentDraftId && <FileText aria-label="带附件" />}
              </span>
              <span className={`queued-message-status${held ? ' held' : ''}`} title={statusTitle}>{status}</span>
              <span className="queued-message-actions">
                <button type="button" disabled={sendDisabled} onClick={() => onSend(item.commandId)}
                  title={running ? '插入当前这一轮，正在运行的智能体会立即看到' : '现在发送'}>
                  {running ? <Zap aria-hidden="true" /> : <CornerDownLeft aria-hidden="true" />}
                  {running ? '立即发送' : '发送'}
                </button>
                <button type="button" className="icon" disabled={editDisabled} onClick={() => onEdit(item.commandId)}
                  aria-label="放回输入框编辑" title={editDisabled ? '输入框有内容时不能放回编辑' : '放回输入框编辑'}>
                  <Pencil aria-hidden="true" />
                </button>
                <button type="button" className="icon" onClick={() => onRemove(item.commandId)} aria-label="删除排队消息" title="删除">
                  <X aria-hidden="true" />
                </button>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
