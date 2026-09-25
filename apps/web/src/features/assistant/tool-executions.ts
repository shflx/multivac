import type {
  AssistantCommandAnchor,
  AssistantPublicEvent,
  AssistantRunTraceView,
  AssistantSessionPageResponse,
  AssistantToolExecutionDetail,
  AssistantToolExecutionView,
} from '@multivac/contracts';
import {
  assistantToolDisplayName,
  assistantToolInputSummary,
  assistantToolSummary,
  truncateAssistantThinkingTrace,
} from '@multivac/contracts';
import { getAssistantToolExecution } from '../../data/assistant-api.js';
import type { VisibleAssistantMessage } from './streaming-messages';

/** 会话内的工具执行记录：摘要随快照/事件到达，明细按需补齐。 */
export interface ToolExecution {
  toolCallId: string;
  toolName: string;
  displayName: string;
  commandId: string | null;
  cursor: string;
  status: AssistantToolExecutionView['status'];
  summary: string;
  detail: string | null;
  isError: boolean;
  startedAt: string;
  endedAt: string | null;
  detailState: 'absent' | 'loading' | 'ready' | 'error';
  inputText?: string;
  inputTruncated?: boolean;
}

export type ToolExecutionRecords = readonly ToolExecution[];
export type RunTrace = AssistantRunTraceView;
export type RunTraceRecords = readonly RunTrace[];

function cursorValue(cursor: string): number {
  const value = Number(cursor);
  return Number.isSafeInteger(value) ? value : 0;
}

function byCursor(left: ToolExecution, right: ToolExecution): number {
  return cursorValue(left.cursor) - cursorValue(right.cursor);
}

function withRecord(
  records: ToolExecutionRecords,
  record: ToolExecution,
): ToolExecution[] {
  const index = records.findIndex((candidate) => candidate.toolCallId === record.toolCallId);
  if (index < 0) return [...records, record].sort(byCursor);
  return records.map((candidate, position) => {
    if (position !== index) return candidate;
    // 摘要更新保留已拉取的明细，避免结束事件覆盖展开内容。
    return {
      ...candidate,
      ...record,
      ...(candidate.detailState === 'ready'
        ? {
            detailState: candidate.detailState,
            inputText: candidate.inputText,
            inputTruncated: candidate.inputTruncated,
          }
        : {}),
    };
  });
}

/** 会话快照重建记录集；重复读取同一水位时保持已有明细。 */
export function hydrateToolExecutions(
  current: ToolExecutionRecords,
  page: AssistantSessionPageResponse,
): ToolExecution[] {
  const snapshot = page.toolExecutions ?? [];
  const previous = new Map(current.map((record) => [record.toolCallId, record]));
  return snapshot.map((view) => {
    const existing = previous.get(view.toolCallId);
    if (!existing) return { ...view, detailState: 'absent' as const };
    return {
      ...view,
      detailState: existing.detailState,
      ...(existing.detailState === 'ready'
        ? {
            inputText: existing.inputText,
            inputTruncated: existing.inputTruncated,
          }
        : {}),
    };
  }).sort(byCursor);
}

/** 终态记录忽略迟到的 updated 事件；未见过的 toolCallId 回退为进行中记录。 */
export function applyToolExecutionEvent(
  current: ToolExecutionRecords,
  event: AssistantPublicEvent,
): ToolExecution[] {
  switch (event.type) {
    case 'assistant.tool.started':
      return withRecord(current, {
        toolCallId: event.data.toolCallId,
        toolName: event.data.toolName,
        displayName: assistantToolDisplayName(event.data.toolName),
        commandId: event.commandId,
        cursor: event.cursor,
        status: 'running',
        summary: assistantToolSummary(event.data.toolName, 'running'),
        detail: assistantToolInputSummary(event.data.inputText),
        isError: false,
        startedAt: event.occurredAt,
        endedAt: null,
        detailState: 'absent',
      });
    case 'assistant.tool.updated':
      // 增量事件不携带展示所需正文；记录已由 started 建立，保持原状态即可。
      return [...current];
    case 'assistant.tool.ended':
      return current.map((record) => {
        if (record.toolCallId !== event.data.toolCallId || record.status !== 'running') return record;
        const status = event.data.isError ? 'failed' as const : 'succeeded' as const;
        return {
          ...record,
          status,
          summary: assistantToolSummary(record.toolName, status),
          isError: event.data.isError,
          endedAt: event.occurredAt,
          cursor: event.cursor,
        };
      });
    default:
      return [...current];
  }
}

/** 移除指定命令的工具记录；发送未成功或被新命令替换时调用。 */
export function withoutCommand(
  records: ToolExecutionRecords,
  commandId: string,
): ToolExecution[] {
  return records.filter((record) => record.commandId !== commandId);
}

export async function loadToolExecutionDetail(
  toolCallId: string,
): Promise<AssistantToolExecutionDetail> {
  return getAssistantToolExecution(toolCallId);
}

export function applyToolExecutionDetail(
  records: ToolExecutionRecords,
  detail: AssistantToolExecutionDetail,
): ToolExecution[] {
  return records.map((record) => record.toolCallId === detail.toolCallId
    ? {
        ...record,
        ...detail,
        detailState: 'ready' as const,
      }
    : record);
}

export function markToolExecutionDetailState(
  records: ToolExecutionRecords,
  toolCallId: string,
  detailState: 'loading' | 'error',
): ToolExecution[] {
  return records.map((record) => record.toolCallId === toolCallId
    ? { ...record, detailState }
    : record);
}

export function hydrateRunTraces(page: AssistantSessionPageResponse): RunTrace[] {
  return [...(page.runTraces ?? [])].sort((left, right) => cursorValue(left.cursor) - cursorValue(right.cursor));
}

function runStatus(event: AssistantPublicEvent): RunTrace['status'] | null {
  if (event.type === 'assistant.run.succeeded') return 'succeeded';
  if (event.type === 'assistant.run.failed') return 'failed';
  if (event.type === 'assistant.run.cancelled') return 'cancelled';
  return event.type === 'assistant.run.processing' || event.type === 'assistant.thinking.delta' ||
    event.type === 'assistant.tool.started'
    ? 'running'
    : null;
}

export function applyRunTraceEvent(
  current: RunTraceRecords,
  event: AssistantPublicEvent,
): RunTrace[] {
  const status = runStatus(event);
  if (!status || !event.commandId) return [...current];
  const existing = current.find((trace) => trace.commandId === event.commandId);
  const trace: RunTrace = existing ?? {
    commandId: event.commandId,
    cursor: event.cursor,
    status: 'running',
    entries: [],
    thinkingTruncated: false,
    startedAt: event.occurredAt,
    endedAt: null,
  };
  const entries = trace.entries.map((entry) => ({ ...entry }));
  let thinkingText = entries.flatMap((entry) => entry.kind === 'thinking' ? [entry.text] : []).join('');
  let thinkingTruncated = trace.thinkingTruncated;
  if (event.type === 'assistant.thinking.delta') {
    const thinking = truncateAssistantThinkingTrace(thinkingText + event.data.delta);
    const appended = thinking.text.slice(thinkingText.length);
    const truncated = event.data.deltaTruncated || thinking.truncated;
    const previous = entries.at(-1);
    if (appended) {
      if (previous?.kind === 'thinking') {
        previous.cursor = event.cursor;
        previous.text += appended;
        previous.truncated = previous.truncated || truncated;
      } else {
        entries.push({ kind: 'thinking', cursor: event.cursor, text: appended, truncated });
      }
    } else if (truncated && previous?.kind === 'thinking') {
      previous.truncated = true;
    }
    thinkingTruncated = thinkingTruncated || truncated;
  } else if (event.type === 'assistant.tool.started' && !entries.some((entry) =>
    entry.kind === 'tool' && entry.toolCallId === event.data.toolCallId)) {
    entries.push({ kind: 'tool', cursor: event.cursor, toolCallId: event.data.toolCallId });
  }
  const next: RunTrace = {
    ...trace,
    cursor: event.cursor,
    status,
    entries,
    thinkingTruncated,
    endedAt: status === 'running' ? null : event.occurredAt,
  };
  return [...current.filter((candidate) => candidate.commandId !== event.commandId), next]
    .sort((left, right) => cursorValue(left.cursor) - cursorValue(right.cursor));
}

/**
 * 轨迹面板实际可渲染的条目：轨迹条目在前，未被轨迹收录的工具记录补在其后。
 * 轨迹与工具记录由服务端分别截取最近窗口，缺少对应记录的工具条目无法渲染，直接剔除。
 */
export function renderableRunTraceEntries(
  trace: RunTrace | undefined,
  records: ToolExecutionRecords,
): RunTrace['entries'] {
  const recordIds = new Set(records.map((record) => record.toolCallId));
  const traceEntries = (trace?.entries ?? []).filter((entry) =>
    entry.kind === 'thinking' || recordIds.has(entry.toolCallId));
  const representedTools = new Set(
    traceEntries.flatMap((entry) => entry.kind === 'tool' ? [entry.toolCallId] : []),
  );
  return [
    ...traceEntries,
    ...records.filter((record) => !representedTools.has(record.toolCallId)).map((record) => ({
      kind: 'tool' as const,
      cursor: record.cursor,
      toolCallId: record.toolCallId,
    })),
  ];
}

/** 时间线条目：历史正文、在途正文或工具执行记录。 */
export type AssistantTimelineItem =
  | { kind: 'message'; key: string; message: VisibleAssistantMessage }
  | { kind: 'tool'; key: string; tool: ToolExecution };

export type AssistantGroupedTimelineItem =
  | Extract<AssistantTimelineItem, { kind: 'message' }>
  | {
      kind: 'trace';
      key: string;
      commandId: string | null;
      tools: ToolExecution[];
      trace?: RunTrace;
    };

/** 将同一命令的相邻工具调用折叠为一组；正文会自然切断分组。 */
export function groupAssistantTimeline(
  items: readonly AssistantTimelineItem[],
  traces: RunTraceRecords = [],
  commandAnchors: readonly AssistantCommandAnchor[] = [],
): AssistantGroupedTimelineItem[] {
  const grouped: AssistantGroupedTimelineItem[] = [];
  for (const item of items) {
    if (item.kind === 'message') {
      grouped.push(item);
      continue;
    }

    const previous = grouped.at(-1);
    if (previous?.kind === 'trace' && previous.commandId === item.tool.commandId) {
      previous.tools.push(item.tool);
      continue;
    }
    grouped.push({
      kind: 'trace',
      key: `tools:${item.tool.commandId ?? 'unowned'}:${item.tool.toolCallId}`,
      commandId: item.tool.commandId,
      tools: [item.tool],
    });
  }

  const tracesByCommand = new Map(traces.map((trace) => [trace.commandId, trace]));
  const represented = new Set<string>();
  for (const item of grouped) {
    if (item.kind !== 'trace' || !item.commandId) continue;
    const trace = tracesByCommand.get(item.commandId);
    if (!trace || represented.has(item.commandId)) continue;
    item.trace = trace;
    represented.add(item.commandId);
  }

  const anchorByCommand = new Map(commandAnchors.map((anchor) => [anchor.commandId, anchor.piEntryId]));
  for (const trace of traces) {
    if (represented.has(trace.commandId)) continue;
    const anchor = anchorByCommand.get(trace.commandId);
    const entry = {
      kind: 'trace' as const,
      key: `trace:${trace.commandId}`,
      commandId: trace.commandId,
      tools: [],
      trace,
    };
    const streamingReplyIndex = grouped.findIndex((item) =>
      item.kind === 'message' && item.message.commandId === trace.commandId);
    if (streamingReplyIndex >= 0) {
      grouped.splice(streamingReplyIndex, 0, entry);
      continue;
    }
    if (!anchor) {
      if (trace.status === 'running') grouped.push(entry);
      continue;
    }
    const index = grouped.findIndex((item) =>
      item.kind === 'message' && item.message.piEntryId === anchor);
    if (index >= 0) grouped.splice(index, 0, entry);
  }

  // 工具组可能先按时间插入到流式回复之后；命令身份可用时将其移回回复之前。
  for (let index = 0; index < grouped.length; index += 1) {
    const item = grouped[index];
    if (item?.kind !== 'trace' || !item.commandId) continue;
    const replyIndex = grouped.findIndex((candidate) =>
      candidate.kind === 'message' && candidate.message.commandId === item.commandId);
    if (replyIndex < 0 || index < replyIndex) continue;
    grouped.splice(index, 1);
    grouped.splice(replyIndex, 0, item);
  }
  return grouped;
}

/**
 * 会话按服务端时间线合并为一条时间线。
 *
 * 正文顺序以 Pi 历史顺序为准（不比较跨进程时钟）。工具记录只展示属于当前已加载
 * Turn 的部分：有命令锚点时插到该 Turn 的回复之前；锚点尚未落库（在途 Turn）时
 * 按开始时间插入。所属 Turn 不在窗口内的历史记录直接跳过，避免堆在会话顶部或末尾。
 */
export function mergeAssistantTimeline(
  messages: readonly VisibleAssistantMessage[],
  tools: ToolExecutionRecords,
  commandAnchors: readonly AssistantCommandAnchor[] = [],
): AssistantTimelineItem[] {
  const items: AssistantTimelineItem[] = messages.map((message) => ({
    kind: 'message' as const,
    key: message.createdAt,
    message,
  }));
  const ownerIndexByCommand = new Map<string, number>();
  for (const anchor of commandAnchors) {
    const index = messages.findIndex((message) => message.piEntryId === anchor.piEntryId);
    if (index >= 0) ownerIndexByCommand.set(anchor.commandId, index);
  }
  const anchoredCommands = new Set(commandAnchors.map((anchor) => anchor.commandId));

  // 先算出每条记录的插入位置，再从后往前统一插入；否则前面的插入会移动后面锚点的下标。
  const placements: { position: number; sequence: number; tool: ToolExecution }[] = [];
  for (const [sequence, tool] of tools.entries()) {
    // 命令已有锚点但所属 Turn 不在窗口内：该记录属于更早的 Turn，等分页加载后再显示。
    if (tool.commandId !== null && anchoredCommands.has(tool.commandId) &&
        !ownerIndexByCommand.has(tool.commandId)) continue;
    const owner = tool.commandId === null ? undefined : ownerIndexByCommand.get(tool.commandId);
    placements.push({ position: owner ?? insertionIndex(messages, tool.startedAt), sequence, tool });
  }
  // 同一位置按 sequence 降序插入，先插入的记录最终排在组内靠后，保持原有顺序。
  placements.sort((left, right) =>
    right.position - left.position || right.sequence - left.sequence);
  for (const placement of placements) {
    items.splice(placement.position, 0, { kind: 'tool', key: placement.tool.startedAt, tool: placement.tool });
  }
  return items;
}

/** 找到工具记录应插入的正文位置：第一条开始时间晚于该工具的正文之前。 */
function insertionIndex(messages: readonly VisibleAssistantMessage[], startedAt: string): number {
  let low = 0;
  let high = messages.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (messages[middle]!.createdAt <= startedAt) low = middle + 1;
    else high = middle;
  }
  return low;
}
