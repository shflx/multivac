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
import { AUTHORIZATION_OUTCOMES } from './tool-authorizations.js';
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
  /** 目录外访问的授权（该调用最近一次请求）；没有请求授权时为 null。 */
  authorization: AssistantToolExecutionView['authorization'];
  /** 内部工具成功时公开的结果摘要与涉及的对象；其余调用没有。 */
  result?: AssistantToolExecutionView['result'];
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

/**
 * 事件增量更新工具记录；终态记录忽略迟到的 updated 事件，未见过的 toolCallId 回退为进行中记录。
 *
 * 越界的文件工具在开始事件之后才请求授权：请求创建时记录转为“待授权”，批准后才转为执行中；
 * 未获批准（拒绝、取消、过期、失效）时工具没有执行，记录以失败结束，结束事件可能晚到或不再到达
 * （等待中服务重启），因此以离开待授权的时间收尾。与服务端工具记录的口径一致。
 */
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
        detail: assistantToolInputSummary(event.data.toolName, event.data.inputText),
        isError: false,
        startedAt: event.occurredAt,
        endedAt: null,
        detailState: 'absent',
        authorization: null,
      });
    case 'assistant.tool.updated':
      // 增量事件不携带展示所需正文；记录已由 started 建立，保持原状态即可。
      return [...current];
    case 'assistant.tool.ended':
      return current.map((record) => {
        if (record.toolCallId !== event.data.toolCallId) return record;
        const authorization = record.authorization;
        if (authorization && authorization.status !== 'pending' && authorization.status !== 'approved') {
          // 未获批准的调用已按失败收尾；结束事件只补上真实的结束位置。
          return { ...record, endedAt: event.occurredAt, cursor: event.cursor };
        }
        if (record.status !== 'running' && record.status !== 'awaiting_authorization') return record;
        const status = event.data.isError ? 'failed' as const : 'succeeded' as const;
        return {
          ...record,
          status,
          summary: assistantToolSummary(record.toolName, status),
          isError: event.data.isError,
          endedAt: event.occurredAt,
          cursor: event.cursor,
          ...(event.data.result ? { result: event.data.result } : {}),
        };
      });
    case 'assistant.authorization.requested':
    case 'assistant.authorization.resolved': {
      const request = event.data.request;
      return current.map((record) => {
        if (record.toolCallId !== request.toolCallId) return record;
        const authorization = { requestId: request.requestId, status: request.status, approval: request.approval };
        // 已结束的记录只更新授权信息（例如结束事件先到）。
        if (record.status === 'succeeded' || (record.status === 'failed' && request.status === 'pending')) {
          return { ...record, authorization };
        }
        const status = request.status === 'pending'
          ? 'awaiting_authorization' as const
          : request.status === 'approved' ? 'running' as const : 'failed' as const;
        return {
          ...record,
          authorization,
          status,
          summary: assistantToolSummary(record.toolName, status),
          isError: status === 'failed',
          endedAt: status === 'failed' ? record.endedAt ?? request.decidedAt : null,
        };
      });
    }
    default:
      return [...current];
  }
}

/**
 * 工具行的状态标签：待授权与授权结果优先于执行状态。
 * 只有批准（或无需授权）的调用才会出现“执行中 / 已完成 / 失败”。
 */
export function toolExecutionStateLabel(record: Pick<ToolExecution, 'status' | 'authorization'>): string {
  if (record.status === 'awaiting_authorization') return '待授权';
  const authorization = record.authorization;
  if (authorization && authorization.status !== 'pending' && authorization.status !== 'approved') {
    return AUTHORIZATION_OUTCOMES[authorization.status].short;
  }
  if (record.status === 'running') return '执行中';
  return record.status === 'succeeded' ? '已完成' : '失败';
}

/** 本组工具中是否有调用正在等待授权。 */
export function awaitingAuthorization(records: ToolExecutionRecords): boolean {
  return records.some((record) => record.status === 'awaiting_authorization');
}

/** 移除指定命令的工具记录；发送未成功或被新命令替换时调用。 */
export function withoutCommand(
  records: ToolExecutionRecords,
  commandId: string,
): ToolExecution[] {
  return records.filter((record) => record.commandId !== commandId);
}

export async function loadToolExecutionDetail(
  sessionId: string,
  toolCallId: string,
): Promise<AssistantToolExecutionDetail> {
  return getAssistantToolExecution(sessionId, toolCallId);
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
  if (event.type === 'assistant.command.reconciled') {
    // 命令终结而运行没有终态事件（等待授权时服务重启等）：交给下面按已有轨迹收尾。
    if (event.data.status !== 'terminal') return null;
    return event.data.terminalOutcome === 'succeeded'
      ? 'succeeded'
      : event.data.terminalOutcome === 'cancelled' ? 'cancelled' : 'failed';
  }
  if (event.type === 'assistant.run.succeeded') return 'succeeded';
  if (event.type === 'assistant.run.failed') return 'failed';
  if (event.type === 'assistant.run.cancelled') return 'cancelled';
  return event.type === 'assistant.run.processing' || event.type === 'assistant.thinking.delta' ||
    event.type === 'assistant.tool.started' || event.type === 'assistant.message.delta'
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
  // 对账只结束仍在运行的轨迹，不新建轨迹，也不改写运行终态事件已给出的结果。
  if (event.type === 'assistant.command.reconciled' && existing?.status !== 'running') return [...current];
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
  } else if (event.type === 'assistant.message.delta' && !entries.some((entry) =>
    entry.kind === 'message' && entry.messageId === event.data.messageId)) {
    // 只记录正文开始输出的位置，正文本身由消息流呈现。
    entries.push({ kind: 'message', cursor: event.cursor, messageId: event.data.messageId });
  }
  const next: RunTrace = {
    ...trace,
    cursor: event.cursor,
    status,
    entries,
    thinkingTruncated,
    // 对账时间不是运行的结束时间：中断的轨迹不给出用时，摘要显示“已结束”。
    endedAt: status === 'running' || event.type === 'assistant.command.reconciled' ? null : event.occurredAt,
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
    entry.kind !== 'tool' || recordIds.has(entry.toolCallId));
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
      /** 本轮最终回复之前的助手正文：作为过程说明收进轨迹，不单独成为回复。 */
      notes?: VisibleAssistantMessage[];
      /** 本轮是否已有最终回复显示在轨迹之后；未按轮次整理时为 undefined。 */
      replyFollows?: boolean;
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
    // 只找助手正文：本地回显同样带命令身份，但轨迹应在它之后。
    const streamingReplyIndex = grouped.findIndex((item) =>
      item.kind === 'message' && item.message.role === 'assistant' && item.message.commandId === trace.commandId);
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
    const owner = grouped[index];
    if (owner?.kind === 'message') grouped.splice(owner.message.role === 'user' ? index + 1 : index, 0, entry);
  }

  // 只有思考的轨迹可能先按时间插入到流式回复之后；命令身份可用时将其移回回复之前。
  // 带工具的轨迹排在同命令正文之后，说明正文先于工具调用，由按轮整理收进轨迹。
  for (let index = 0; index < grouped.length; index += 1) {
    const item = grouped[index];
    if (item?.kind !== 'trace' || !item.commandId || item.tools.length > 0) continue;
    const replyIndex = grouped.findIndex((candidate) => candidate.kind === 'message' &&
      candidate.message.role === 'assistant' && candidate.message.commandId === item.commandId);
    if (replyIndex < 0 || index < replyIndex) continue;
    grouped.splice(index, 1);
    grouped.splice(replyIndex, 0, item);
  }
  return foldTurns(grouped);
}

type TraceItem = Extract<AssistantGroupedTimelineItem, { kind: 'trace' }>;

/**
 * 按轮次整理：一条用户消息之后到下一条用户消息之前为一轮。
 *
 * Pi 每次调用工具后都会重新生成一条助手消息，一轮里可能有多段正文。其后还调用了工具的
 * 正文是过程说明，收进轨迹；之后不再调用工具的正文才是这一轮的回复。本轮所有工具与思考
 * 合并为一个轨迹，放在回复之前。运行中正在输出的正文先作为回复，其后一旦调用工具就收进
 * 轨迹。窗口起点之前的内容无法判断轮次，保持原样。
 */
function foldTurns(items: readonly AssistantGroupedTimelineItem[]): AssistantGroupedTimelineItem[] {
  const result: AssistantGroupedTimelineItem[] = [];
  let turn: AssistantGroupedTimelineItem[] | null = null;
  const flush = () => {
    if (turn) result.push(...foldTurn(turn));
    turn = null;
  };
  for (const item of items) {
    if (item.kind === 'message' && item.message.role === 'user') {
      flush();
      result.push(item);
      turn = [];
    } else if (turn) {
      turn.push(item);
    } else {
      result.push(item);
    }
  }
  flush();
  return result;
}

function foldTurn(items: readonly AssistantGroupedTimelineItem[]): AssistantGroupedTimelineItem[] {
  // 本轮以最后调用工具的命令为准；其他命令的记录（极少出现）保持原样。
  const owner = items.findLast((item): item is TraceItem => item.kind === 'trace' && item.tools.length > 0);
  if (!owner) return [...items];
  const owns = (item: TraceItem) => item.commandId === owner.commandId;

  // 从后往前找：出现过本命令带工具的轨迹之后，更早的正文都是过程说明。
  const notes = new Set<AssistantGroupedTimelineItem>();
  let toolsAfter = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === 'trace') toolsAfter ||= owns(item) && item.tools.length > 0;
    else if (toolsAfter) notes.add(item);
  }
  if (notes.size === 0) return [...items];

  const traces = items.filter((item): item is TraceItem => item.kind === 'trace' && owns(item));
  const others = items.filter((item) => item.kind === 'trace' && !owns(item));
  const replies = items.filter((item) => item.kind === 'message' && !notes.has(item));
  const noteMessages = [...notes].flatMap((item) => item.kind === 'message' ? [item.message] : []).reverse();
  const trace = traces.find((item) => item.trace)?.trace;
  // 键只取决于命令：正文从回复变为过程说明、工具陆续出现时轨迹不会重新挂载。
  const merged: TraceItem = {
    kind: 'trace',
    key: owner.commandId ? `run:${owner.commandId}` : owner.key,
    commandId: owner.commandId,
    tools: traces.flatMap((item) => item.tools),
    ...(trace ? { trace } : {}),
    notes: noteMessages,
    replyFollows: replies.length > 0,
  };
  return [...others, merged, ...replies];
}

/** 轨迹面板的条目：思考、工具与过程说明。 */
export type RunTraceDisplayEntry =
  | Exclude<RunTrace['entries'][number], { kind: 'message' }>
  | { kind: 'note'; message: VisibleAssistantMessage };

/**
 * 把过程说明放回轨迹：优先按服务端记录的正文开始位置（message 条目）就位；
 * 其余条目中的正文位置标记（如最终回复）不展示。没有位置记录的过程说明按时间
 * 排在它之后开始的第一个工具之前，之后没有工具的排在末尾。
 */
export function interleaveRunTraceNotes(
  entries: RunTrace['entries'],
  notes: readonly VisibleAssistantMessage[],
  records: ToolExecutionRecords,
): RunTraceDisplayEntry[] {
  const byMessageId = new Map(notes.flatMap((note) => note.runtimeMessageId ? [[note.runtimeMessageId, note] as const] : []));
  const placed = new Set<VisibleAssistantMessage>();
  const positioned = entries.flatMap((entry): RunTraceDisplayEntry[] => {
    if (entry.kind !== 'message') return [entry];
    const note = byMessageId.get(entry.messageId);
    if (!note || placed.has(note)) return [];
    placed.add(note);
    return [{ kind: 'note' as const, message: note }];
  });

  const startedAt = new Map(records.map((record) => [record.toolCallId, record.startedAt]));
  const pending = notes.filter((note) => !placed.has(note))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const result: RunTraceDisplayEntry[] = [];
  for (const entry of positioned) {
    const toolStartedAt = entry.kind === 'tool' ? startedAt.get(entry.toolCallId) : undefined;
    while (toolStartedAt !== undefined && pending.length > 0 && pending[0]!.createdAt <= toolStartedAt) {
      result.push({ kind: 'note', message: pending.shift()! });
    }
    result.push(entry);
  }
  return [...result, ...pending.map((message) => ({ kind: 'note' as const, message }))];
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
  runningCommands: ReadonlySet<string> = new Set(),
): AssistantTimelineItem[] {
  const items: AssistantTimelineItem[] = messages.map((message) => ({
    kind: 'message' as const,
    key: message.createdAt,
    message,
  }));
  const ownerIndexByCommand = new Map<string, number>();
  for (const anchor of commandAnchors) {
    const index = messages.findIndex((message) => message.piEntryId === anchor.piEntryId);
    // 没有产生回复就结束的命令锚在自己的用户消息上：记录放在该消息之后，仍属于这一轮。
    if (index >= 0) ownerIndexByCommand.set(anchor.commandId, messages[index]!.role === 'user' ? index + 1 : index);
  }
  const anchoredCommands = new Set(commandAnchors.map((anchor) => anchor.commandId));
  const latestUserIndex = messages.findLastIndex((message) => message.role === 'user');

  // 先算出每条记录的插入位置，再从后往前统一插入；否则前面的插入会移动后面锚点的下标。
  const placements: { position: number; sequence: number; tool: ToolExecution }[] = [];
  for (const [sequence, tool] of tools.entries()) {
    // 命令已有锚点但所属 Turn 不在窗口内：该记录属于更早的 Turn，等分页加载后再显示。
    if (tool.commandId !== null && anchoredCommands.has(tool.commandId) &&
        !ownerIndexByCommand.has(tool.commandId)) continue;
    const owner = tool.commandId === null ? undefined : ownerIndexByCommand.get(tool.commandId);
    // 运行中的命令属于最新一轮：排在最后一条用户消息之后，按事件顺序插入；
    // 已结束但没有锚点的旧命令（如被重启中断）仍按时间放回原处。
    const position = owner ?? (tool.commandId !== null && runningCommands.has(tool.commandId)
      ? inFlightIndex(messages, tool, latestUserIndex + 1)
      : insertionIndex(messages, tool.startedAt));
    placements.push({ position, sequence, tool });
  }
  // 同一位置按 sequence 降序插入，先插入的记录最终排在组内靠后，保持原有顺序。
  placements.sort((left, right) =>
    right.position - left.position || right.sequence - left.sequence);
  for (const placement of placements) {
    items.splice(placement.position, 0, { kind: 'tool', key: placement.tool.startedAt, tool: placement.tool });
  }
  return items;
}

/**
 * 在途工具记录的位置：从 low 起，排在第一条晚于该工具的正文之前。流式正文与工具记录
 * 共用事件水位，按水位比较（同一毫秒内的先后也能分清）；已回读的正文按时间比较。
 */
function inFlightIndex(messages: readonly VisibleAssistantMessage[], tool: ToolExecution, low: number): number {
  const toolCursor = cursorValue(tool.cursor);
  for (let index = low; index < messages.length; index += 1) {
    const message = messages[index]!;
    const earlier = message.role === 'assistant' && message.streamCursor !== undefined
      ? message.streamCursor < toolCursor
      : message.createdAt <= tool.startedAt;
    if (!earlier) return index;
  }
  return messages.length;
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
