import { assistantToolDisplayName, assistantToolInputSummary, assistantToolSummary, type SubagentListItem, type SubagentProcessEntry } from '@multivac/contracts';
import type { RunTrace, ToolExecution } from '../assistant/tool-executions.js';

/**
 * 子智能体过程按普通会话的一轮整理：委派输入是用户消息，中间的思考、过程说明与工具
 * 归入一段运行轨迹，最后一条助手正文是回复。工具行沿用会话的“动作 + 关键参数”口径。
 */
export interface SubagentTimeline {
  input: SubagentProcessEntry | null;
  trace: RunTrace | null;
  records: ToolExecution[];
  reply: SubagentProcessEntry | null;
}

/** 过程里的工具入参是 JSON；转成会话工具入参的“参数名: 取值”行，供共用摘要取关键参数。 */
function inputLines(text: string): string {
  try {
    const args: unknown = JSON.parse(text);
    if (!args || typeof args !== 'object' || Array.isArray(args)) return text;
    return Object.entries(args).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n');
  } catch { return text; }
}

function traceStatus(item: SubagentListItem): RunTrace['status'] {
  if (!item.stopConfirmed) return 'running';
  if (item.status === 'succeeded') return 'succeeded';
  return item.status === 'cancelled' ? 'cancelled' : 'failed';
}

export function subagentTimeline(item: SubagentListItem, entries: readonly SubagentProcessEntry[]): SubagentTimeline {
  const input = entries.find(entry => entry.role === 'user') ?? null;
  const lastStep = entries.findLastIndex(entry => entry.role === 'thinking' || entry.role === 'tool');
  const lastText = entries.findLastIndex(entry => entry.role === 'assistant');
  // 最后一条正文出现在全部过程之后才是回复；仍在执行时它只是过程说明。
  const replyIndex = lastText > lastStep && (item.stopConfirmed || lastText === entries.length - 1) ? lastText : -1;
  const status = traceStatus(item);
  const startedAt = item.startedAt ?? item.createdAt;
  const records = new Map<string, ToolExecution>();
  const traceEntries: RunTrace['entries'] = [];

  entries.forEach((entry, index) => {
    const cursor = String(index);
    if (entry.role === 'user' || index === replyIndex) return;
    if (entry.role !== 'tool') {
      // 空白思考（模型只给出签名等）不占轨迹行。
      if (entry.text.trim()) traceEntries.push({ kind: 'thinking', cursor, text: entry.text, truncated: false });
      return;
    }
    const toolCallId = entry.toolCallId ?? entry.id;
    const toolName = entry.toolName ?? '工具';
    const existing = records.get(toolCallId);
    if (entry.phase === 'output') {
      if (existing) records.set(toolCallId, { ...existing, status: 'succeeded', summary: assistantToolSummary(toolName, 'succeeded'), endedAt: startedAt });
      return;
    }
    // 没有输出：执行中仍在运行，已结束的执行视为未完成。
    const pending = status === 'running' ? 'running' : 'failed';
    records.set(toolCallId, {
      toolCallId, toolName, displayName: assistantToolDisplayName(toolName), commandId: item.parentCommandId, cursor,
      status: pending, summary: assistantToolSummary(toolName, pending), detail: assistantToolInputSummary(toolName, inputLines(entry.text)),
      isError: pending === 'failed', startedAt, endedAt: null, detailState: 'absent', authorization: null,
    });
    traceEntries.push({ kind: 'tool', cursor, toolCallId });
  });

  const trace: RunTrace | null = traceEntries.length || status === 'running' ? {
    commandId: item.parentCommandId, cursor: '0', status, entries: traceEntries, thinkingTruncated: false, startedAt, endedAt: item.endedAt,
    ...(status === 'failed' ? { error: { code: item.status, message: subagentOutcome(item) ?? '子智能体未正常完成。' } } : {}),
  } : null;
  return { input, trace, records: [...records.values()], reply: replyIndex >= 0 ? entries[replyIndex]! : null };
}

/** 委派输入按行拼接（“目标：…”“交付要求：…”）；渲染为 Markdown 时保留单个换行，代码块原样。 */
export function delegationMarkdown(text: string): string {
  let fenced = false;
  const lines = text.split('\n');
  return lines.map((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    return !fenced && line.trim() && lines[index + 1]?.trim() ? `${line}  ` : line;
  }).join('\n');
}

/** 未成功结束的委派：后端把停止或失败原因写在结论位置，按状态给出说明。 */
export function subagentOutcome(item: SubagentListItem): string | null {
  if (['preparing', 'running', 'stopping', 'succeeded'].includes(item.status)) return null;
  const reason = item.summary.trim();
  const label = { failed: '执行失败', cancelled: '已取消', exhausted: '额度耗尽', interrupted: '执行中断', reconcile: '停止待核对' }[item.status as 'failed'];
  return `${label}${reason ? `：${reason}` : '，没有记录原因。'}`;
}
