import type {
  AssistantToolExecutionDetail,
  AssistantToolExecutionStatus,
  AssistantToolExecutionView,
} from '@multivac/contracts';
import {
  assistantToolDisplayName,
  assistantToolSummary,
  truncateAssistantToolInput,
} from '@multivac/contracts';
import type { ToolExecutionProjection } from '../modules/sessions/assistant-turn.js';

const SUMMARY_DETAIL_MAX_CHARS = 120;

function statusOf(projection: ToolExecutionProjection): AssistantToolExecutionStatus {
  if (projection.endedAt === null) return 'running';
  return projection.isError ? 'failed' : 'succeeded';
}

/** 摘要只取入参首行，避免把完整命令或文件内容带进会话快照。 */
function firstInputLine(inputText: string | null): string | null {
  const line = inputText
    ?.split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  if (!line) return null;
  return line.length > SUMMARY_DETAIL_MAX_CHARS
    ? `${line.slice(0, SUMMARY_DETAIL_MAX_CHARS)}…`
    : line;
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
    detail: firstInputLine(projection.inputText),
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
