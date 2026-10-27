import { useEffect, useRef, useState } from 'react';
import type { ContextCoverageItem, ContextSnapshot } from '@multivac/contracts';
import type { SessionContext } from './session-context.js';
import './context-panel.css';

const sources = { 'current-estimate': '当前估算', 'last-request-input': '最近请求实际输入', unavailable: '不可用' };
const coverageNames = { systemPrompt: '系统提示', toolDefinitions: '工具定义', summary: '压缩摘要', toolResults: '工具结果', attachments: '附件' };
const coverageStatuses = { included: '包含', excluded: '未包含', partial: '部分覆盖', unknown: '覆盖未知' };
const operationNames = { running: '正在压缩', succeeded: '压缩成功', failed: '压缩失败', cancelled: '压缩已取消',
  'no-content': '没有可压缩内容', unavailable: '主动压缩不可用', 'reconciliation-required': '压缩结果待核对' };
const number = (value: number | null) => value === null ? '未知' : value.toLocaleString('zh-CN');
function time(value: string | null): string { return value ? new Date(value).toLocaleString('zh-CN') : '未知'; }

export function ContextSnapshotDetails({ snapshot, stale = false }: { snapshot: ContextSnapshot; stale?: boolean }) {
  return <div className="context-snapshot">
    <strong>{sources[snapshot.source]}：{snapshot.tokens === null ? '未知' : `${number(snapshot.tokens)} token`}</strong>
    <span>统计模型：{snapshot.model ? `${snapshot.model.provider} / ${snapshot.model.modelId}` : '未知'}</span>
    <span>模型窗口：{number(snapshot.contextWindow)} token</span>
    <span>统计时间：{time(snapshot.measuredAt)}</span>
    <span>读取时间：{time(snapshot.observedAt)}</span>
    {(stale || snapshot.stale) && <span>统计已过期：{snapshot.staleReason ?? '上下文已变化，正在重新读取。'}</span>}
    {snapshot.unavailableReason && <span>{snapshot.unavailableReason}</span>}
    {snapshot.basis && <span>统计依据：{snapshot.source === 'last-request-input' ? '提供方输入用量，包含缓存命中，不含输出。' : '最近回复用量（包含输出）加后续消息估算，不是精确请求计数。'}</span>}
    <details><summary>计数覆盖说明</summary><ul>{(Object.entries(snapshot.coverage) as [keyof typeof coverageNames, ContextCoverageItem][]).map(([key, item]) =>
      <li key={key}>{coverageNames[key as keyof typeof coverageNames]} · {coverageStatuses[item.status]}：{item.explanation}</li>)}</ul></details>
  </div>;
}

export function ContextPanel({ context, running }: { context: SessionContext; running: boolean }) {
  const root = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target) && root.current) root.current.open = false; };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const current = context.data?.state.current;
  const model = context.data?.state.compaction.model;
  const disabled = running || context.pending || context.stale || context.reading || !context.data?.state.compaction.available;
  const label = !current || current.tokens === null ? '上下文 · 未知'
    : current.source === 'current-estimate' && current.contextWindow
      ? `上下文 · 估算 ${(current.tokens / current.contextWindow * 100).toFixed(1)}%` : `上下文 · ${number(current.tokens)} token`;
  return <details className="context-panel" ref={root} onToggle={event => {
    const next = event.currentTarget.open;
    setOpen(next);
    if (next) void context.refresh();
  }} onKeyDown={event => {
    if (event.key === 'Escape' && root.current?.open) {
      event.preventDefault(); event.stopPropagation(); root.current.open = false; trigger.current?.focus();
    }
  }}>
    <summary aria-label="会话上下文" ref={trigger} title="查看上下文统计和主动压缩状态">{label}{context.stale && current ? ' · 已过期' : ''}</summary>
    <div className="context-panel-content" aria-label="会话上下文详情">
      <div className="context-panel-heading"><strong>会话上下文</strong><button type="button" onClick={() => void context.refresh()} disabled={context.reading}>刷新状态</button></div>
      {context.error && <p role="alert">{context.error}</p>}
      {current ? <ContextSnapshotDetails snapshot={current} stale={context.stale} /> : <p>正在读取上下文状态。</p>}
      {context.data?.state.lastRequest && <details><summary>最近请求输入（不代表当前占用）</summary><ContextSnapshotDetails snapshot={context.data.state.lastRequest} /></details>}
      <div className="context-compaction">
        <strong>主动压缩</strong>
        <p>执行模型：{model ? `${model.provider} / ${model.modelId}` : '当前持久模型尚不可核对'}</p>
        <p>使用会话当前持久模型；输入区的本轮智能体选择不会更改此模型。</p>
        {context.data?.state.compaction.reason && <p>{context.data.state.compaction.reason}</p>}
        {running && <p>会话运行中，暂不能主动压缩。</p>}
        <button type="button" disabled={disabled} onClick={() => void context.compact()}>压缩较早上下文</button>
        {context.operation && <div role="status"><strong>{operationNames[context.operation.status]}</strong>
          {context.operation.error && <p>{context.operation.error.message}</p>}
          <span>操作 ID：{context.operation.operationId}</span>
          <details><summary>操作前统计</summary><ContextSnapshotDetails snapshot={context.operation.before} /></details>
          {context.operation.after && <details><summary>操作后统计</summary><ContextSnapshotDetails snapshot={context.operation.after} /></details>}
        </div>}
        <p>聊天历史仍可查看，不保证固定压缩比例；自动压缩沿用原配置。</p>
      </div>
    </div>
  </details>;
}
