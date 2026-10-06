import { useWorkspaceSessions, useWorkspaces } from '../workspace/workspace-sessions-provider.js';
import { focusableWithin, wrapFocusIndex } from '../../components/focus-trap.js';
import { useEffect, useId, useLayoutEffect, useRef, type MutableRefObject } from 'react';
import { ArrowLeft, CheckCircle2, Maximize2, X } from 'lucide-react';
import { compareInboxItems, type InboxItem } from '@multivac/contracts';
import { ManagementPageActions } from '../../app/management-layout.js';
import { useTaskRequests } from './task-requests-provider.js';
import { useTasks } from './tasks-provider.js';
import { INBOX_LABELS, InboxRequestDetail } from './inbox-request-detail.js';
import './inbox.css';

export interface InboxViewProps {
  active: boolean; compact?: boolean; selected: string | null; onSelect: (id: string) => void;
  detailOpen: boolean; onDetail: (open: boolean) => void;
  scroll: MutableRefObject<Record<string, number>>;
  choices: MutableRefObject<Record<string, string>>;
  onClose: () => void; onExpand?: (() => void) | undefined; onSource: (item: InboxItem) => void;
}

function Completion() {
  return <div className="inbox-completion"><CheckCircle2 aria-hidden="true" /><h3>全部处理完毕</h3><p>新的决策请求会显示在这里。</p></div>;
}
function age(createdAt: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return new Date(createdAt).toLocaleDateString();
}

/** 抽屉与管理页共用请求事实与决定，只有证据正文滚动，操作栏保持可见。 */
export function InboxView({ active, compact = false, selected, onSelect, detailOpen, onDetail, scroll, choices, onClose, onExpand, onSource }: InboxViewProps) {
  const state = useTaskRequests();
  const { tasks } = useTasks();
  const { sessions, ensureLoaded } = useWorkspaceSessions();
  const { workspaces, ensureLoaded: ensureWorkspaces } = useWorkspaces();
  useEffect(() => { if (active) { void ensureLoaded().catch(() => undefined); void ensureWorkspaces().catch(() => undefined); } }, [active, ensureLoaded, ensureWorkspaces]);
  const list = state.items.filter(item => item.status === 'pending' || item.status === 'unknown').sort(compareInboxItems);
  const item = state.items.find(value => value.id === selected) ?? (!compact ? list[0] : undefined);
  const detail = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const shouldFocus = useRef(false);
  const titleId = useId();
  const visible = active && (!compact || detailOpen);
  useEffect(() => {
    if (!visible || !item) return;
    // 固定实际展示的首项；后来到达的高优先级请求不抢走当前详情。
    if (selected !== item.id) onSelect(item.id);
    if (!item.state.seen) void state.store?.seen(item.id);
  }, [visible, item?.id, item?.state.seen, selected, onSelect, state.store]);
  useLayoutEffect(() => {
    if (!active) return;
    if (listRef.current) listRef.current.scrollTop = scroll.current.list ?? 0;
    if (visible && shouldFocus.current) { detail.current?.focus({ preventScroll: true }); shouldFocus.current = false; }
  }, [active, visible, item?.id, scroll]);
  const select = (id: string) => { shouldFocus.current = true; onSelect(id); onDetail(true); };
  const returnToList = () => { onDetail(false); requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>('[aria-current="true"],button')?.focus({ preventScroll: true })); };
  const next = list.find(value => value.id !== item?.id);
  function source(value: InboxItem): string {
    const task = tasks.find(task => task.taskId === value.taskId);
    const session = sessions?.find(session => session.sessionId === value.sessionId);
    const workspace = workspaces?.find(value => task ? value.project?.projectId === task.projectId : value.workspaceId === session?.workspaceId);
    const project = workspace?.project?.name ?? (task?.projectId ? '来源项目' : session && !workspace ? '来源工作区' : '日常');
    const title = task?.title ?? (value.taskId ? '来源任务' : value.sessionId === 'global-coordinator' ? '全局 Multivac' : session?.title ?? '工作会话');
    return `${title} · ${project}`;
  }
  return <div className={`inbox-view${compact ? ' compact' : ''}`}>
    {compact ? <header className="inbox-header">
      {detailOpen && <button className="icon-button" aria-label="返回 Inbox 列表" onClick={returnToList}><ArrowLeft /></button>}
      <h2>Inbox</h2><span>{state.pendingCount} 项待处理</span>
      {onExpand && <button className="icon-button" aria-label="展开到管理" onClick={onExpand}><Maximize2 /></button>}
      <button className="icon-button" aria-label="关闭 Inbox" onClick={onClose}><X /></button>
    </header> : <ManagementPageActions><span className="inbox-pending-count">{state.pendingCount} 项待处理</span></ManagementPageActions>}
    {state.inboxError && <div role="alert" className="inbox-error">{state.inboxError}<button className="inline-link" onClick={() => void state.store?.refreshInbox().catch(() => undefined)}>重新读取</button></div>}
    {!state.loaded && !state.inboxError && <p className="inbox-loading" role="status">正在读取 Inbox…</p>}
    <div className="inbox-layout">
      <section className="inbox-list" aria-label="待处理事项" hidden={compact && detailOpen}>
        <div className="inbox-list-heading">{state.pendingCount} 项待处理</div>
        <div ref={listRef} className="inbox-list-scroll" onScroll={event => { if (active && (!compact || !detailOpen)) scroll.current.list = event.currentTarget.scrollTop; }}>
          {list.map(value => <button key={value.id} className="inbox-item" aria-current={value.id === item?.id ? 'true' : undefined} onClick={() => select(value.id)}>
            <span className="inbox-item-title"><strong>{value.title}</strong>{!value.state.seen && <i aria-label="未查看" role="img" />}</span>
            <span className="inbox-source">{source(value)}</span>
            <span className="inbox-meta"><span className="inbox-type">{INBOX_LABELS[value.kind]}</span><span className={value.blocksWork ? 'inbox-impact blocking' : 'inbox-impact'}>{value.status === 'unknown' ? '结果待核对' : value.blocksWork ? '工作等待决定' : '仅本次操作'}</span><time dateTime={value.createdAt} title={new Date(value.createdAt).toLocaleString()}>{age(value.createdAt)}</time></span>
          </button>)}
          {state.loaded && !list.length && !state.inboxError && <Completion />}
        </div>
        {compact && <footer className="inbox-list-footer"><span>{list.length ? '选择事项查看详情' : '没有待处理事项'}</span><button className="secondary-button" onClick={onClose}>关闭 Inbox</button></footer>}
      </section>
      <section ref={detail} className="inbox-detail" aria-label="请求详情" tabIndex={-1} hidden={compact && !detailOpen}>
        {item ? <>
          <header className="inbox-detail-header"><div className="inbox-detail-context"><span className="inbox-type">{INBOX_LABELS[item.kind]}</span><span>{state.pendingCount} 项待处理</span></div><h2 id={titleId} title={item.title}>{item.title}</h2></header>
          <InboxRequestDetail key={item.id} item={item} active={visible} source={source(item)} sourceAvailable={item.sessionId === 'global-coordinator' || Boolean(sessions?.some(session => session.sessionId === item.sessionId && !session.archivedAt))} onSource={() => onSource(item)} onRetainSelection={() => onSelect(item.id)} next={next} onNext={select} onReturn={returnToList} onFinish={onClose} compact={compact} scroll={scroll} choices={choices} />
        </> : state.loaded && !list.length && !state.inboxError ? <div className="inbox-empty-detail"><Completion />{!compact && <button className="secondary-button" onClick={onClose}>返回任务面板</button>}</div> : <div className="inbox-empty-detail"><p>选择需要处理的事项</p></div>}
      </section>
    </div>
  </div>;
}

export function InboxDrawer({ open, ...props }: InboxViewProps & { open: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
    return () => { if (element.open) element.close(); };
  }, [open]);
  return <dialog ref={dialog} className="inbox-drawer" aria-modal={open ? true : undefined} aria-label="Inbox"
    onClick={event => { if (event.target !== event.currentTarget) return; const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) props.onClose(); }}
    onCancel={event => { event.preventDefault(); props.onClose(); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose(); }
      if (event.key === 'Tab') {
        const elements = focusableWithin(event.currentTarget).filter(element => element.getClientRects().length > 0);
        const next = wrapFocusIndex(elements.length, elements.indexOf(document.activeElement as HTMLElement), event.shiftKey);
        if (next !== null) { event.preventDefault(); elements[next]?.focus(); }
      } }}>
    <InboxView {...props} compact active={open} />
  </dialog>;
}
