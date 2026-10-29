import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, LoaderCircle, RefreshCw, SquareSlash, X } from 'lucide-react';
import type { ContextCompactionOperation, ContextSnapshot } from '@multivac/contracts';
import type { SessionContext } from './session-context.js';
import './context-panel.css';

const operationNames = { running: '正在压缩', succeeded: '压缩成功', failed: '压缩失败', cancelled: '压缩已取消',
  'no-content': '没有可压缩内容', unavailable: '主动压缩不可用', 'reconciliation-required': '压缩结果待核对' };
const number = (value: number | null) => value === null ? '未知' : value.toLocaleString('zh-CN');
const percent = (ratio: number, digits = 0) => `${(Math.min(ratio, 1) * 100).toFixed(digits)}%`;

/** 相对时间：一小时内按分钟，其余显示当日时刻或日期。 */
function since(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString('zh-CN');
}

/** 占用比例；token 或窗口未知时返回 null，不做猜测。 */
function usageRatio(snapshot: ContextSnapshot | undefined): number | null {
  if (!snapshot || snapshot.tokens === null || !snapshot.contextWindow) return null;
  return snapshot.tokens / snapshot.contextWindow;
}

/** 按占用比例分级着色：70% 起提醒，90% 起警告。 */
function usageLevel(ratio: number | null): 'unknown' | 'normal' | 'warn' | 'danger' {
  if (ratio === null) return 'unknown';
  return ratio >= 0.9 ? 'danger' : ratio >= 0.7 ? 'warn' : 'normal';
}

/** 入口圆环：用描边长度表示占用比例。 */
function UsageRing({ ratio }: { ratio: number | null }) {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  return <svg className="context-ring" viewBox="0 0 16 16" aria-hidden="true">
    <circle className="context-ring-track" cx="8" cy="8" r={radius} />
    {ratio !== null && <circle className="context-ring-value" cx="8" cy="8" r={radius}
      strokeDasharray={circumference} strokeDashoffset={circumference * (1 - Math.min(ratio, 1))} />}
  </svg>;
}

/** 只读的上下文占用；主动压缩通过输入区的 /compact 命令触发。 */
export function ContextPanel({ context }: { context: SessionContext }) {
  const root = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    if (!open || !root.current || !popup.current) return;
    const position = () => {
      const anchor = root.current, panel = popup.current;
      if (!anchor || !panel) return;
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + 16;
      const right = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth) - 16;
      panel.style.maxWidth = `${Math.max(0, right - left)}px`;
      // 默认右对齐入口，触及视口边缘时平移；不按固定按钮宽度猜测可用空间。
      const anchorRight = anchor.getBoundingClientRect().right;
      panel.style.right = `${anchorRight - Math.max(left + panel.offsetWidth, Math.min(anchorRight, right))}px`;
    };
    const observer = new ResizeObserver(position);
    observer.observe(root.current); observer.observe(popup.current);
    position();
    window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position); window.visualViewport?.addEventListener('scroll', position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position); window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target) && root.current) root.current.open = false; };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const current = context.data?.state.current;
  const operation = context.operation;
  const ratio = usageRatio(current);
  const level = usageLevel(ratio);
  // 入口只给比例；比例不可得时退回 token 数，再退回占位符。
  const label = ratio !== null ? percent(ratio) : current && current.tokens !== null ? number(current.tokens) : '—';
  const title = !current || current.tokens === null ? '上下文占用未知'
    : `已用 ${number(current.tokens)} / ${number(current.contextWindow)} token${context.stale ? '（已过期）' : ''}`;
  // 来源一行只回答“哪个模型、何时统计”；统计口径不再向用户展开。
  const updated = current && since(current.measuredAt);
  const meta = current && [current.model?.modelId, updated && `${updated}${/\d$/u.test(updated) ? ' ' : ''}更新`].filter(Boolean).join(' · ');
  const note = context.error ?? (current?.stale || context.stale ? current?.staleReason ?? null : null) ?? current?.unavailableReason ?? null;

  return <details className="context-panel" ref={root} onToggle={event => {
    const next = event.currentTarget.open;
    setOpen(next);
    if (next) void context.refresh();
  }} onKeyDown={event => {
    if (event.key === 'Escape' && root.current?.open) {
      event.preventDefault(); event.stopPropagation(); root.current.open = false; trigger.current?.focus();
    }
  }}>
    <summary aria-label="会话上下文" ref={trigger} title={title} data-level={level} data-stale={context.stale || undefined}>
      <UsageRing ratio={ratio} /><span className="context-label">{label}</span>
    </summary>
    <div ref={popup} className="context-panel-content" aria-label="会话上下文详情" data-level={level}>
      <div className="context-panel-heading"><strong>上下文</strong>
        <button type="button" className="context-icon-button" aria-label="刷新状态" title="刷新状态" onClick={() => void context.refresh()} disabled={context.reading}>
          <RefreshCw aria-hidden="true" className={context.reading ? 'spin' : undefined} />
        </button>
      </div>
      {current ? <>
        <div className="context-usage">
          <strong>{current.tokens === null ? '—' : number(current.tokens)}</strong>
          {current.contextWindow !== null && <span> / {number(current.contextWindow)}</span>}
          {ratio !== null && <em>{percent(ratio, 1)}</em>}
        </div>
        <div className="context-meter" role="meter" aria-label="上下文占用" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={ratio === null ? undefined : Math.round(Math.min(ratio, 1) * 100)}><span style={{ width: ratio === null ? 0 : percent(ratio, 1) }} /></div>
        <p className="context-meta" title={current.model ? `${current.model.provider} / ${current.model.modelId}` : undefined}>{meta}</p>
      </> : <p className="context-meta">正在读取…</p>}
      {note && <p className="context-note" role={context.error ? 'alert' : undefined}>{note}</p>}
      {/* 只展示仍在影响 /compact 可用性的操作；已结束的结果在输入区反馈过即可。 */}
      {operation && (operation.status === 'running' || operation.status === 'reconciliation-required') &&
        <p className="context-operation" role="status" data-status={operation.status}>
        {operationNames[operation.status]}{operation.error ? `：${operation.error.message}` : ''}
      </p>}
      <p className="context-hint"><SquareSlash aria-hidden="true" /><span>输入 <kbd>/compact</kbd> 压缩较早上下文</span></p>
    </div>
  </details>;
}

/** /compact 执行后的输入区反馈：进行中显示进度，结束后显示结果，可手动关闭。 */
export function CompactFeedback({ operation, onDismiss }: { operation: ContextCompactionOperation; onDismiss: () => void }) {
  const running = operation.status === 'running';
  const Icon = running ? LoaderCircle : operation.status === 'succeeded' ? CircleCheck : CircleAlert;
  return <div className="compact-feedback" role="status" data-status={operation.status}>
    <Icon className={running ? 'spin' : undefined} aria-hidden="true" />
    <span>{running ? '正在压缩较早上下文…' : operationNames[operation.status]}{operation.error ? `：${operation.error.message}` : ''}</span>
    {!running && <button type="button" aria-label="关闭" title="关闭" onClick={onDismiss}><X aria-hidden="true" /></button>}
  </div>;
}
