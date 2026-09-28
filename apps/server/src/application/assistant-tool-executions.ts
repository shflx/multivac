import type {
  AssistantToolExecutionDetail,
  AssistantToolExecutionView,
} from '@multivac/contracts';
import {
  assistantToolDisplayName,
  assistantToolInputSummary,
  assistantToolSummary,
  truncateAssistantToolInput,
} from '@multivac/contracts';
import type { ToolExecutionProjection } from '../modules/sessions/assistant-turn.js';

/**
 * 工具执行状态。越界调用在开始事件之后先等待授权，批准前不算执行中；
 * 授权未获批准（拒绝、取消、过期、失效）时工具没有执行，按失败结束——
 * 即使结束事件没有到达（例如等待中服务重启），也以授权离开待授权的时间为结束时间。
 */
function stateOf(projection: ToolExecutionProjection): Pick<
  AssistantToolExecutionView, 'status' | 'isError' | 'endedAt'
> {
  if (projection.endedAt !== null) {
    return {
      status: projection.isError ? 'failed' : 'succeeded',
      isError: projection.isError,
      endedAt: projection.endedAt,
    };
  }
  const authorization = projection.authorization;
  if (authorization?.status === 'pending') {
    return { status: 'awaiting_authorization', isError: false, endedAt: null };
  }
  if (authorization && authorization.status !== 'approved') {
    return { status: 'failed', isError: true, endedAt: authorization.decidedAt };
  }
  return { status: 'running', isError: false, endedAt: null };
}

export function toolExecutionView(projection: ToolExecutionProjection): AssistantToolExecutionView {
  const { status, isError, endedAt } = stateOf(projection);
  return {
    toolCallId: projection.toolCallId,
    toolName: projection.toolName,
    displayName: assistantToolDisplayName(projection.toolName),
    commandId: projection.commandId,
    cursor: projection.cursor,
    status,
    summary: assistantToolSummary(projection.toolName, status),
    // 摘要只取“动作 + 关键参数”一行，避免把完整命令或文件内容带进会话快照。
    detail: assistantToolInputSummary(projection.toolName, projection.inputText),
    isError,
    startedAt: projection.startedAt,
    endedAt,
    authorization: projection.authorization
      ? { requestId: projection.authorization.requestId, status: projection.authorization.status }
      : null,
  };
}

export function toolExecutionDetail(projection: ToolExecutionProjection): AssistantToolExecutionDetail {
  const input = truncateAssistantToolInput(projection.inputText ?? '');
  return {
    ...toolExecutionView(projection),
    inputText: input.text,
    inputTruncated: projection.inputTruncated || input.truncated,
  };
}
