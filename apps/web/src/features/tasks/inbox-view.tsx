import { useWorkspaceSessions } from '../workspace/workspace-sessions-provider.js';
import { focusableWithin, wrapFocusIndex } from '../../components/focus-trap.js';
import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Inbox, Maximize2, X } from 'lucide-react';
import { compareInboxItems, type InboxItem } from '@multivac/contracts';
import { useTaskRequests } from './task-requests-provider.js';
import { TaskRequestCard } from './task-request-card.js';
import { ExternalRequestCard } from './external-request-card.js';
import { AuthorizationCard } from '../assistant/authorization-card.js';
import { useTasks } from './tasks-provider.js';

const LABELS: Record<InboxItem['kind'], string> = { clarification: '澄清', authorization: '目录授权', external: '外发授权', review: '成果验收', recovery: '恢复确认' };
export interface InboxViewProps {
  active: boolean; compact?: boolean; selected: string | null; onSelect: (id: string) => void;
  detailOpen: boolean; onDetail: (open: boolean) => void;
  scroll: MutableRefObject<Record<string, number>>;
  onClose: () => void; onExpand?: (() => void) | undefined; onSource: (item: InboxItem) => void;
}

/** 抽屉与管理页共用业务卡片；选中、滚动只属于本窗口。 */
export function InboxView({ active, compact = false, selected, onSelect, detailOpen, onDetail, scroll, onClose, onExpand, onSource }: InboxViewProps) {
  const state = useTaskRequests();
  const { tasks } = useTasks();
  const { sessions, ensureLoaded } = useWorkspaceSessions();
  useEffect(() => { if (active) void ensureLoaded().catch(() => undefined); }, [active, ensureLoaded]);
  const list = state.items.filter((item) => item.status === 'pending' || item.status === 'unknown').sort(compareInboxItems);
  const item = state.items.find((value) => value.id === selected);
  const detail = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const shouldFocus = useRef(false);
  const visible = active && (!compact || detailOpen);
  useEffect(() => {
    if (visible && item && !item.state.seen) void state.store?.seen(item.id);
  }, [visible, item?.id, item?.state.seen, state.store]);
  useLayoutEffect(() => {
    if (!active) return;
    if (listRef.current) listRef.current.scrollTop = scroll.current.list ?? 0;
    if (detail.current && item) detail.current.scrollTop = scroll.current[item.id] ?? 0;
    if (visible && shouldFocus.current) { detail.current?.focus({ preventScroll: true }); shouldFocus.current = false; }
  }, [active, visible, item?.id, scroll]);
  const select = (id: string) => { shouldFocus.current = true; onSelect(id); onDetail(true); };
  const next = list.find((value) => value.id !== selected);
  const source = (value: InboxItem) => value.taskId ? tasks.find((task) => task.taskId === value.taskId)?.title ?? `任务 ${value.taskId}` : value.sessionId === 'global-coordinator' ? '全局 Multivac' : '工作会话';
  return <div className={`inbox-view${compact ? ' compact' : ''}`}>
    <header className="inbox-header">
      {compact && detailOpen && <button aria-label="返回 Inbox 列表" onClick={() => { onDetail(false); requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>('[aria-current="true"],button')?.focus()); }}><ArrowLeft /></button>}
      {compact && <h2 id="inbox-title">Inbox</h2>}<span>{state.pendingCount} 项待处理</span>
      {compact && onExpand && <button aria-label="展开到管理" onClick={onExpand}><Maximize2 /></button>}
      {compact && <button aria-label="关闭 Inbox" onClick={onClose}><X /></button>}
    </header>
    {state.inboxError && <div role="alert" className="inbox-error">{state.inboxError}<button onClick={() => void state.store?.refreshInbox().catch(() => undefined)}>重新读取</button></div>}
    {!state.loaded && !state.inboxError && <p role="status">正在读取 Inbox…</p>}
    <div className="inbox-layout">
      <section className="inbox-list" aria-label="待处理事项" hidden={compact && detailOpen}>
        <div ref={listRef} className="inbox-list-scroll" onScroll={(event) => { if (active && (!compact || !detailOpen)) scroll.current.list = event.currentTarget.scrollTop; }}>
          {list.map((value) => <button key={value.id} className="inbox-item" aria-current={value.id === selected ? 'true' : undefined} onClick={() => select(value.id)}>
            <span className="inbox-item-title"><strong>{value.title}</strong>{!value.state.seen && <i aria-label="未查看" role="img" />}</span>
            <span className="inbox-source">{source(value)}</span>
            <span className="inbox-meta"><span>{LABELS[value.kind]}</span><span>{value.status === 'unknown' ? '结果待核对' : value.blocksWork ? '等待你的决定' : '仅本次操作'}</span><time dateTime={value.createdAt}>{new Date(value.createdAt).toLocaleString()}</time></span>
          </button>)}
          {state.loaded && !list.length && !state.inboxError && <div className="inbox-empty"><CheckCircle2 /><h3>全部处理完毕</h3><p>新的决策请求会显示在这里。</p><button onClick={onClose}>{compact ? '关闭 Inbox' : '返回任务面板'}</button></div>}
        </div>
      </section>
      <section ref={detail} className="inbox-detail" aria-label="请求详情" tabIndex={-1} hidden={compact && !detailOpen} onScroll={(event) => { if (visible && item) scroll.current[item.id] = event.currentTarget.scrollTop; }}>
        {item ? <>
          <div className="inbox-detail-intro"><span>{LABELS[item.kind]}</span><h3>{item.title}</h3><p>{source(item)} · <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></p>
            {(item.sessionId === 'global-coordinator' || sessions?.some((session) => session.sessionId === item.sessionId && !session.archivedAt)) ? <button className="inline-link" onClick={() => onSource(item)}>返回来源会话 <ArrowRight /></button> : <p>来源会话不可用；请求仍以服务端记录为准。</p>}
          </div>
          {item.authorization ? <AuthorizationCard request={item.authorization} onDecide={(decision) => void state.store?.decideItem(item, decision)} /> : item.external ? <ExternalRequestCard item={item} /> : item.human ? <TaskRequestCard inInbox request={item.human} /> : null}
          <footer className="inbox-detail-footer"><span>{item.status === 'pending' ? '决定后会在这里保留处理回执。' : '当前回执已保留。'}</span>{next ? <button onClick={() => select(next.id)}>处理下一项 <ArrowRight /></button> : <button onClick={onClose}>{compact ? '关闭 Inbox' : '返回任务面板'}</button>}</footer>
        </> : <div className="inbox-empty"><Inbox /><h3>选择需要处理的事项</h3><p>查看详情不会减少待处理数。</p></div>}
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
  return <dialog ref={dialog} className="inbox-drawer" aria-modal={open ? true : undefined} aria-labelledby="inbox-title"
    onCancel={(event) => { event.preventDefault(); props.onClose(); }}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose(); }
      if (event.key === 'Tab') {
        const elements = focusableWithin(event.currentTarget).filter((element) => element.getClientRects().length > 0);
        const next = wrapFocusIndex(elements.length, elements.indexOf(document.activeElement as HTMLElement), event.shiftKey);
        if (next !== null) { event.preventDefault(); elements[next]?.focus(); }
      } }}>
    <InboxView {...props} compact active={open} />
  </dialog>;
}
