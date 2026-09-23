import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { RunTrace, ToolExecution } from './tool-executions.js';

interface ToolExecutionGroupProps {
  records: readonly ToolExecution[];
  trace?: RunTrace;
  replyVisible: boolean;
  feedback?: {
    status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
    summary: string;
    message: string;
  };
}

function statusIcon(status: ToolExecution['status']) {
  if (status === 'failed') return CircleAlert;
  if (status === 'running') return LoaderCircle;
  return CheckCircle2;
}

const STATUS_LABELS: Record<ToolExecution['status'], string> = {
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
};

/** 原型中的运行 Trace：摘要展示思考状态，展开后展示阶段说明和工具步骤。 */
function traceSummary(status: RunTrace['status'] | 'unknown'): string {
  if (status === 'running') return '思考中';
  if (status === 'succeeded') return '处理完成';
  if (status === 'failed') return '处理失败';
  if (status === 'cancelled') return '已停止';
  return '状态待确认';
}

export function ToolExecutionGroup({ records, trace, feedback, replyVisible }: ToolExecutionGroupProps) {
  const running = records.some((record) => record.status === 'running');
  const traceStatus = trace?.status ?? feedback?.status ?? (running ? 'running' : 'unknown');
  const summary = trace ? traceSummary(trace.status) : feedback?.summary ?? traceSummary(traceStatus);
  const isRunning = traceStatus === 'running';
  const [open, setOpen] = useState(isRunning);
  const openedForRun = useRef(isRunning);

  useEffect(() => {
    if (replyVisible) {
      if (openedForRun.current) {
        openedForRun.current = false;
        setOpen(false);
      }
      return;
    }
    if (isRunning) {
      openedForRun.current = true;
      setOpen(true);
      return;
    }
  }, [isRunning, replyVisible]);
  const recordsById = new Map(records.map((record) => [record.toolCallId, record]));
  const representedTools = new Set(
    trace?.entries.flatMap((entry) => entry.kind === 'tool' ? [entry.toolCallId] : []) ?? [],
  );
  const entries = [
    ...(trace?.entries ?? []),
    ...records.filter((record) => !representedTools.has(record.toolCallId)).map((record) => ({
      kind: 'tool' as const,
      cursor: record.cursor,
      toolCallId: record.toolCallId,
    })),
  ];
  // 轨迹只讲“过程里发生了什么”；运行状态由输入区状态条负责，不在这里重复一遍。
  const waitingForContent = entries.length === 0 && isRunning;

  function toolEntry(record: ToolExecution) {
    const Icon = statusIcon(record.status);
    return (
      <div
        className={`run-trace-tool ${record.status}`}
        data-tool-call-id={record.toolCallId}
        key={`tool:${record.toolCallId}`}
      >
        <Icon className={record.status === 'running' ? 'status-spinner' : ''} aria-hidden="true" />
        <span title={record.detail ?? record.displayName}>{record.detail ?? record.displayName}</span>
        <em>{STATUS_LABELS[record.status]}</em>
      </div>
    );
  }

  return (
    <details
      className={`run-trace ${traceStatus}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>{summary}</span>
        {records.length > 0 && <small>{records.length} 个工具</small>}
        <ChevronRight className="disclosure-chevron" aria-hidden="true" />
      </summary>
      <div className="run-trace-content">
        {waitingForContent && (
          <p className="run-trace-thought muted">正在等待模型输出…</p>
        )}
        {entries.map((entry, index) => entry.kind === 'thinking' ? (
          <p className="run-trace-thought" key={`thinking:${entry.cursor}:${index}`}>
            {entry.text}{entry.truncated ? '\n…（思考内容已截断）' : ''}
          </p>
        ) : recordsById.get(entry.toolCallId)
          ? toolEntry(recordsById.get(entry.toolCallId)!)
          : null)}
      </div>
    </details>
  );
}
