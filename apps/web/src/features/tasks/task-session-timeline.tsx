import { useState } from 'react';
import { ChevronRight, Info, Workflow } from 'lucide-react';
import type { HumanRequest } from '@multivac/contracts';
import type { AssistantGroupedTimelineItem } from '../assistant/tool-executions.js';
import type { VisibleAssistantMessage } from '../assistant/streaming-messages.js';
import './task-session-timeline.css';

/**
 * 任务会话的三方呈现：任务系统命令、Agent 回复与用户回应。
 *
 * 服务端只受理本次运行自身的命令（taskSessionPolicy），用户不能直接发送，
 * 因此任务会话中的 user 消息都是任务系统发出的执行说明或恢复命令。
 * 用户回应存放在人工请求上，不在 Pi 历史里，按决定时间插回对话。
 */

/** 对话里展示的请求种类：与会话中的请求卡一致，成果验收与授权在别处处理。 */
export const SESSION_REQUEST_KINDS: readonly HumanRequest['kind'][] = ['clarification', 'recovery'];

const DECISION_LABELS: Partial<Record<NonNullable<HumanRequest['decision']>, string>> = {
  use_scope: '允许本次引用',
  deny: '不采用',
  continue: '继续执行',
  restart: '从安全起点重做',
  stop: '保持停止',
};

/** 任务系统命令：折叠成一行，按需展开原文。 */
export function TaskSystemCommand({ message, first }: { message: VisibleAssistantMessage; first: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="task-system-command" data-entry-id={message.streamCursor === undefined ? message.runtimeEntryId : undefined}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Workflow aria-hidden="true" />
        <span>任务系统 · {first ? '开始执行' : '继续执行'}</span>
        <ChevronRight className="task-system-chevron" aria-hidden="true" />
      </button>
      {open && <p>{message.text}</p>}
    </div>
  );
}

/** 已处理的请求：回应显示为带标签的用户气泡，失效请求只留一行原因。 */
export function TaskRequestReply({ request }: { request: HumanRequest }) {
  if (request.status === 'invalidated') {
    return <p className="task-request-void" data-request-id={request.requestId}>请求已失效{request.reason ? ` · ${request.reason}` : ''}</p>;
  }
  const decision = request.decision ? DECISION_LABELS[request.decision] : undefined;
  const text = request.answer.trim() || decision || '已回应';
  return (
    <article className="chat-row user task-request-reply" data-request-id={request.requestId}>
      <span className="avatar" aria-hidden="true">你</span>
      <div className="chat-content">
        {/* Agent 经请求提问，问题不一定出现在正文里；标签带上问题，回应才有上下文。 */}
        <span className="task-request-reply-label" title={request.question}>
          回应「{request.question}」{decision && text !== decision ? ` · ${decision}` : ''}
        </span>
        <p>{text}</p>
      </div>
    </article>
  );
}

/**
 * 把已处理的请求按决定时间放到第一条更晚的消息之前，没有更晚消息的排在末尾。
 * 早于当前已加载窗口的请求属于更早历史，加载到那里之前不显示。
 */
export function placeRequestReplies(
  timeline: readonly AssistantGroupedTimelineItem[],
  requests: readonly HumanRequest[],
  hasMore: boolean,
): { before: ReadonlyMap<number, HumanRequest[]>; tail: HumanRequest[] } {
  const times = timeline.map((item) => item.kind === 'message' && item.message.streamCursor === undefined ? Date.parse(item.message.createdAt) : NaN);
  const first = times.find((time) => !Number.isNaN(time));
  const settled = requests.filter((request) => request.status !== 'pending')
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.requestId.localeCompare(right.requestId));
  const before = new Map<number, HumanRequest[]>();
  const tail: HumanRequest[] = [];
  for (const request of settled) {
    const at = Date.parse(request.updatedAt);
    if (hasMore && first !== undefined && at < first) continue;
    const index = times.findIndex((time) => time > at);
    if (index < 0) tail.push(request);
    else before.set(index, [...(before.get(index) ?? []), request]);
  }
  return { before, tail };
}

/** 任务会话没有输入框：说明由任务系统推进，回应走请求卡或 Inbox。 */
export function TaskSessionNotice() {
  return (
    <p className="task-session-notice">
      <Info aria-hidden="true" />
      任务会话由任务系统执行，不能直接发送；需要你回应时，请在请求卡或 Inbox 中处理。
    </p>
  );
}
