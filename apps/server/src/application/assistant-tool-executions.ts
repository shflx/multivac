import type {
  AssistantToolExecutionDetail,
  AssistantToolExecutionStatus,
  AssistantToolExecutionView,
} from '@multivac/contracts';
import {
  assistantToolDisplayName,
  assistantToolInputSummary,
  assistantToolSummary,
  truncateAssistantToolInput,
} from '@multivac/contracts';
import type { ToolExecutionProjection } from '../modules/sessions/assistant-turn.js';

function statusOf(projection: ToolExecutionProjection): AssistantToolExecutionStatus {
  if (projection.endedAt === null) return 'running';
  return projection.isError ? 'failed' : 'succeeded';
}

export function toolExecutionView(projection: ToolExecutionProjection): AssistantToolExecutionView {
  const status = statusOf(projection);
  return {
    toolCallId: projection.toolCallId,
    toolName: projection.toolName,
    displayName: assistantToolDisplayName(projection.toolName),
    commandId: projection.commandId,
    cursor: projection.cursor,
    status,
    summary: assistantToolSummary(projection.toolName, status),
    // 摘要只取关键参数一行，避免把完整命令或文件内容带进会话快照。
    detail: assistantToolInputSummary(projection.inputText),
    isError: projection.isError,
    startedAt: projection.startedAt,
    endedAt: projection.endedAt,
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
