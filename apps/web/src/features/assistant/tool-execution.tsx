import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  ShieldAlert,
  ShieldX,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ASSISTANT_FAILURE_REASON_UNAVAILABLE } from '@multivac/contracts';
import { runTraceExpandable, runTraceSummary, type RunTraceTiming } from './run-trace-summary.js';
import {
  awaitingAuthorization,
  interleaveRunTraceNotes,
  renderableRunTraceEntries,
  toolExecutionStateLabel,
  type RunTrace,
  type ToolExecution,
} from './tool-executions.js';
import type { VisibleAssistantMessage } from './streaming-messages.js';
import { approvalLabel } from './tool-authorizations.js';
import { ObjectRefLinks } from './object-links.js';

interface ToolExecutionGroupProps {
  records: readonly ToolExecution[];
  trace?: RunTrace;
  /** 本轮最终回复之前的助手正文，作为过程说明与思考、工具按时间排列。 */
  notes?: readonly VisibleAssistantMessage[];
  replyVisible: boolean;
  unanchored?: boolean;
  /** 尚无服务端轨迹时，由当前命令的运行反馈提供状态。 */
  feedbackStatus?: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
}

/** 工具行的图标与样式状态：待授权与未获批准的调用各有自己的样式，不显示执行中的旋转图标。 */
function toolRowState(record: ToolExecution): { className: string; Icon: typeof CheckCircle2 } {
  if (record.status === 'awaiting_authorization') return { className: 'awaiting-authorization', Icon: ShieldAlert };
  const authorization = record.authorization?.status;
  if (authorization && authorization !== 'pending' && authorization !== 'approved') {
    return { className: 'not-authorized', Icon: ShieldX };
  }
  if (record.status === 'failed') return { className: 'failed', Icon: CircleAlert };
  if (record.status === 'running') return { className: 'running', Icon: LoaderCircle };
  return { className: 'succeeded', Icon: CheckCircle2 };
}

/** 时钟只更新摘要，避免每秒重新渲染整段思考与工具内容；恢复时沿用服务端开始时间。 */
function RunTraceSummary({ timing }: { timing: RunTraceTiming }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!timing.running || timing.awaitingAuthorization || !timing.startedAt || !Number.isFinite(Date.parse(timing.startedAt))) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [timing.running, timing.awaitingAuthorization, timing.startedAt]);
  return <span>{runTraceSummary(timing, now)}</span>;
}

/** 原型中的运行 Trace：摘要展示思考中或用时，展开后展示阶段说明和工具步骤。 */
export function ToolExecutionGroup({ records, trace, notes = [], feedbackStatus, replyVisible, unanchored = false }: ToolExecutionGroupProps) {
  const running = records.some((record) =>
    record.status === 'running' || record.status === 'awaiting_authorization');
  const traceStatus = trace?.status ?? feedbackStatus ?? (running ? 'running' : 'unknown');
  const isRunning = traceStatus === 'running';
  const failed = traceStatus === 'failed';
  // 等待授权时本轮既不在思考也不在执行，摘要如实说明，不显示运行中的强调色。
  const waitingForAuthorization = isRunning && awaitingAuthorization(records);
  // 失败原因默认展开；其他轨迹在挂载时已有回复则直接收起。
  const [open, setOpen] = useState(failed || isRunning && !replyVisible);
  const openedForRun = useRef(isRunning && !replyVisible);

  useEffect(() => {
    // 先出现部分回复再失败时，也展开所属原因，不受回复自动收起逻辑影响。
    if (failed) {
      openedForRun.current = false;
      setOpen(true);
      return;
    }
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
  }, [failed, isRunning, replyVisible]);
  const recordsById = new Map(records.map((record) => [record.toolCallId, record]));
  const entries = interleaveRunTraceNotes(renderableRunTraceEntries(trace, records), notes, records);
  // 历史失败必须在所属轨迹内保留原因入口；进行中的提示仍由当前状态条负责。
  const waitingForContent = entries.length === 0 && isRunning;
  // 失败说明也是可展开内容，没有工具或思考时仍可查看原因。
  const expandable = failed || runTraceExpandable({ running: isRunning, entryCount: entries.length });

  function toolEntry(record: ToolExecution) {
    const { className, Icon } = toolRowState(record);
    // 批准依据：用户在卡上批准的范围，或按已记住的授权放行（没有出现授权卡）。
    const approval = record.authorization?.status === 'approved' ? record.authorization.approval : null;
    return (
      <div
        className={`run-trace-tool ${className}`}
        data-tool-call-id={record.toolCallId}
        key={`tool:${record.toolCallId}`}
      >
        <Icon className={className === 'running' ? 'status-spinner' : ''} aria-hidden="true" />
        <span title={record.detail ?? record.displayName}>{record.detail ?? record.displayName}</span>
        <em title={[
          toolExecutionStateLabel(record),
          ...(approval ? [approvalLabel(approval)] : []),
          ...(record.status === 'succeeded' && record.result ? [record.result.summary] : []),
        ].join(' · ')}>
          {toolExecutionStateLabel(record)}
          {approval && <small className="run-trace-approval"> · {approvalLabel(approval)}</small>}
          {/* 内部工具的结果摘要（如“共 2 个工作区”），来自服务端公开的结果，不含工具原始输出。 */}
          {record.status === 'succeeded' && record.result && (
            <small className="run-trace-result"> · {record.result.summary}</small>
          )}
        </em>
        {/* 结果涉及的会话与项目：可以点开（会话在工作区打开，项目打开设置 · 项目）。 */}
        {record.status === 'succeeded' && record.result && <ObjectRefLinks refs={record.result.refs} />}
      </div>
    );
  }

  return (
    <details
      className={`run-trace ${waitingForAuthorization ? 'awaiting-authorization' : traceStatus}${expandable ? '' : ' empty'}`}
      data-run-command-id={trace?.commandId}
      aria-label={unanchored ? '未关联消息的历史运行记录' : undefined}
      open={open && expandable}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary onClick={expandable ? undefined : (event) => event.preventDefault()}>
        {failed ? <span>{unanchored ? '历史处理失败 · 查看原因' : '处理失败 · 查看原因'}</span> : <RunTraceSummary timing={{ running: isRunning, awaitingAuthorization: waitingForAuthorization,
          startedAt: trace?.startedAt, endedAt: trace?.endedAt }} />}
        {records.length > 0 && <small>{records.length} 个工具</small>}
        {expandable && <ChevronRight className="disclosure-chevron" aria-hidden="true" />}
      </summary>
      {expandable && <div className="run-trace-content">
        {failed && <div className="run-failure-reason" role="note" aria-label="本次运行失败原因">
          <p className="run-trace-thought">{trace?.error?.message ?? ASSISTANT_FAILURE_REASON_UNAVAILABLE}</p>
        </div>}
        {waitingForContent && (
          <p className="run-trace-thought muted">正在等待模型输出…</p>
        )}
        {entries.map((entry, index) => entry.kind === 'thinking' ? (
          <p className="run-trace-thought" key={`thinking:${entry.cursor}:${index}`}>
            {entry.text}{entry.truncated ? '\n…（思考内容已截断）' : ''}
          </p>
        ) : entry.kind === 'note' ? (
          // 过程说明与思考同样呈现为普通段落；不是回复，不提供引用等操作。
          <p className="run-trace-thought run-trace-note" key={`note:${entry.message.id}`}>
            {entry.message.text}
          </p>
        ) : toolEntry(recordsById.get(entry.toolCallId)!))}
      </div>}
    </details>
  );
}
