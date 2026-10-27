import type { AssistantCommandReceipt, AssistantPublicEvent } from '@multivac/contracts';

/**
 * 一轮运行在状态条上的反馈：命令回执与公共事件各自对应哪一种说明。
 * 只做映射，不判断命令归属；归属（是否最近一次发送、是否运行中的那一轮）由会话控制器决定。
 */

export type RunPhase = 'idle' | 'reconciling' | 'accepted' | 'handed' |
  'processing' | 'tool' | 'authorization' | 'retry' | 'compaction' |
  'succeeded' | 'failed' | 'cancelled' | 'unknown';

export interface RunFeedback {
  phase: RunPhase;
  message: string;
  failureReason?: string;
}

type CommandError = { code?: string; message: string } | null | undefined;

export const IDLE_FEEDBACK: RunFeedback = { phase: 'idle', message: '' };

/** 存在待授权请求时，状态条只说明这一件事：本轮在等你决定，既不在思考也不在执行。 */
export const AWAITING_AUTHORIZATION_FEEDBACK: RunFeedback = { phase: 'authorization', message: '等待你的授权' };

export const SENDING_FEEDBACK: RunFeedback = { phase: 'reconciling', message: '正在发送消息' };
export const PROCESSING_FEEDBACK: RunFeedback = { phase: 'processing', message: 'Multivac 正在处理' };
export const SUCCEEDED_FEEDBACK: RunFeedback = { phase: 'succeeded', message: '处理完成' };
export const UNKNOWN_FEEDBACK: RunFeedback = { phase: 'unknown', message: '发送结果未知' };

/** 尚未终结的命令阶段。 */
export type CommandProgressStatus = 'unknown' | 'accepted' | 'handed_to_pi' | 'running';

export function commandStatusFeedback(status: CommandProgressStatus): RunFeedback {
  switch (status) {
    case 'unknown': return { phase: 'reconciling', message: '正在确认消息是否已接受' };
    case 'accepted': return { phase: 'accepted', message: '消息已接受' };
    case 'handed_to_pi': return { phase: 'handed', message: '消息已交给 Pi' };
    case 'running': return PROCESSING_FEEDBACK;
  }
}

export function failedFeedback(error?: CommandError, message = '处理失败'): RunFeedback {
  return { phase: 'failed', message, ...(error ? { failureReason: error.message } : {}) };
}

/** 授权等待超时同样以取消结束本轮：此时说明真实原因，而不是“用户停止”。 */
export function cancelledFeedback(authorizationExpired: boolean): RunFeedback {
  return authorizationExpired
    ? { phase: 'cancelled', message: '授权等待超时，本轮已结束' }
    : { phase: 'cancelled', message: '处理已取消' };
}

/** 终态回执的反馈；以“已接受”终结的命令（例如运行中追加）没有本轮结果可报。 */
export function terminalFeedback(
  outcome: NonNullable<AssistantCommandReceipt['terminalOutcome']>,
  error: CommandError,
  authorizationExpired: boolean,
): RunFeedback | null {
  if (outcome === 'succeeded') return SUCCEEDED_FEEDBACK;
  if (outcome === 'failed' || outcome === 'rejected') return failedFeedback(error);
  if (outcome === 'cancelled') return cancelledFeedback(authorizationExpired);
  return null;
}

/** 本次发送未成功结算时留给输入区的说明。 */
export function unsuccessfulSendError(
  outcome: NonNullable<AssistantCommandReceipt['terminalOutcome']>,
  error: CommandError,
  authorizationExpired: boolean,
): string {
  if (error) return error.message;
  if (outcome !== 'cancelled') return '消息处理失败，请重试。';
  return authorizationExpired ? '授权等待超时，本轮已结束。' : '消息处理已取消。';
}

/** 服务端对账出的终态（重启中断、等待授权时结束等）。 */
export function reconciledFeedback(
  event: Extract<AssistantPublicEvent, { type: 'assistant.command.reconciled' }>,
  authorizationExpired: boolean,
): RunFeedback {
  const { terminalOutcome, error } = event.data;
  if (terminalOutcome === 'cancelled') return cancelledFeedback(authorizationExpired);
  if (terminalOutcome === 'succeeded') return SUCCEEDED_FEEDBACK;
  return failedFeedback(error, error?.code === 'COMMAND_INTERRUPTED' ? '处理已中断' : '处理失败');
}

/** 运行终态事件的反馈。 */
export function runEndFeedback(
  event: Extract<AssistantPublicEvent, { type: 'assistant.run.succeeded' | 'assistant.run.failed' | 'assistant.run.cancelled' }>,
  authorizationExpired: boolean,
): RunFeedback {
  if (event.type === 'assistant.run.succeeded') return SUCCEEDED_FEEDBACK;
  if (event.type === 'assistant.run.failed') return failedFeedback(event.data.error);
  return cancelledFeedback(authorizationExpired);
}

/**
 * 运行中一轮的过程反馈：工具、授权结果、重试与上下文压缩。不属于这几类的事件返回 null。
 * notAuthorized：该工具调用的授权未获批准；它的结束事件不是执行失败，授权结果已给出状态说明。
 */
export function progressFeedback(event: AssistantPublicEvent, notAuthorized = false): RunFeedback | null {
  switch (event.type) {
    case 'assistant.tool.started':
    case 'assistant.tool.updated':
      return { phase: 'tool', message: `正在使用 ${event.data.toolName}` };
    case 'assistant.tool.ended':
      if (notAuthorized) return null;
      return event.data.isError
        ? { phase: 'tool', message: `${event.data.toolName} 执行失败` }
        : { phase: 'processing', message: '工具执行完成，继续处理' };
    case 'assistant.authorization.resolved': {
      const request = event.data.request;
      if (request.status === 'approved') return { phase: 'tool', message: `正在使用 ${request.toolName}` };
      if (request.status === 'denied') return { phase: 'processing', message: '已拒绝授权，Multivac 继续处理' };
      if (request.status === 'expired') return { phase: 'processing', message: '授权等待超时，本轮即将结束' };
      return null;
    }
    case 'assistant.retry.started':
      return { phase: 'retry', message: `正在重试 ${event.data.attempt}/${event.data.maxAttempts}` };
    case 'assistant.retry.ended':
      return { phase: 'processing', message: '重试结束，继续处理' };
    case 'assistant.compaction.started':
      return { phase: 'compaction', message: '正在压缩会话上下文' };
    case 'assistant.compaction.ended':
      if (event.data.status === 'cancelled') {
        return { phase: 'processing', message: '会话上下文压缩已取消，继续等待运行结果' };
      }
      return {
        phase: 'processing',
        message: event.data.status === 'failed' ? '会话上下文压缩失败，继续等待运行结果' : '上下文压缩完成',
      };
    default:
      return null;
  }
}
