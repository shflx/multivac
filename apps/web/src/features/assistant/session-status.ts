import type { AssistantSession } from './assistant-session.js';

export type SessionStatusInput = Pick<AssistantSession, 'status' | 'runFeedback' | 'runFeedbackCommandId' | 'runFeedbackAfterCursor' | 'runBusy' | 'submitting' | 'cancelling' | 'runTraces'>;
export interface SessionStatus {
  kind: 'processing' | 'unread' | 'viewed';
  label: string;
  detail: string;
  /** 最近一轮结束的水位；进行中或尚无回复时为空。 */
  endedCursor: number | null;
}

/** 会话只区分处理与阅读状态，不沿用任务的“完成”状态。 */
export function sessionStatus(session: SessionStatusInput | undefined, readCursor = 0): SessionStatus | null {
  // 数据尚未读到时不推断为已查看，也不伪装成模型正在处理。
  if (!session || session.status !== 'ready') return null;
  const latest = session.runTraces.at(-1);
  const owner = session.runFeedbackCommandId;
  const ownsLatest = owner !== null && (!latest || latest.commandId === owner || Number(latest.cursor) <= session.runFeedbackAfterCursor);
  const processing = (detail: string): SessionStatus => ({ kind: 'processing', label: '处理中', detail, endedCursor: null });
  if (session.cancelling) return processing('正在等待本轮停止');
  if (session.runFeedback.phase === 'authorization') return processing('本轮尚未结束，等待你的授权');

  let endedCursor = latest && latest.status !== 'running' ? Number(latest.cursor) : null;
  if (ownsLatest && session.runFeedback.phase !== 'idle' && latest?.commandId !== owner) {
    if (['succeeded', 'failed', 'cancelled'].includes(session.runFeedback.phase)) {
      // 发送被拒绝时可能没有运行轨迹；半步水位表示这次本地结果，后续服务端事件仍会超过它。
      endedCursor = session.runFeedbackAfterCursor + 0.5;
    } else return processing(session.runFeedback.message || '本轮尚未结束');
  } else if (latest?.status === 'running' || (!latest && (session.submitting || session.runBusy))) {
    return processing('正在处理本轮消息');
  }

  if (endedCursor !== null && endedCursor > readCursor) {
    return { kind: 'unread', label: '未查看', detail: '本轮处理已结束，有尚未查看的回复或结果', endedCursor };
  }
  return { kind: 'viewed', label: '已查看', detail: endedCursor === null ? '暂无未查看的回复' : '本轮结果已查看，可以继续对话', endedCursor };
}
