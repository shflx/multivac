import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, CheckCircle2, ChevronRight, LoaderCircle, X } from 'lucide-react';
import { SubagentPageSchema, SubagentProcessPageSchema, type SubagentListItem, type SubagentPage, type SubagentProcessPage } from '@multivac/contracts';
import { fetchJson } from '../../data/assistant-api.js';
import { useOptionalWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { MarkdownBody } from '../assistant/markdown-body.js';
import { focusableWithin, wrapFocusIndex } from '../../components/focus-trap.js';
import './subagents.css';

const states = { preparing: '准备中', running: '执行中', stopping: '停止中', succeeded: '已完成', failed: '失败', cancelled: '已取消', exhausted: '额度耗尽', interrupted: '已中断', reconcile: '待核对' };
const modes = { read: '只读', write: '分工写', execute: '执行' };
const bytes = (n: number) => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
const elapsed = (item: SubagentListItem) => `${Math.round(item.elapsedMs / 1000)} 秒`;
type Filter = { parentSessionId?: string; taskId?: string; activeOnly?: boolean; active?: boolean };

/** 每个查看现场只订阅一次；事件合并刷新，重连及定期补读都只读事实。 */
export function useSubagents({ parentSessionId, taskId, activeOnly, active = true }: Filter) {
  const key = JSON.stringify({ parentSessionId, taskId, activeOnly });
  const [snapshot, setSnapshot] = useState<{ key: string; page: SubagentPage } | null>(null);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async (nextOffset = 0) => {
    if (!active) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const params = new URLSearchParams(JSON.parse(key) as Record<string, string>); params.set('offset', String(nextOffset)); params.set('limit', '20');
    try {
      const page = await fetchJson(`/api/subagents?${params}`, { signal: controller.signal }, SubagentPageSchema);
      if (!controller.signal.aborted) { setSnapshot({ key, page }); setOffset(nextOffset); setError(''); }
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '委派读取失败。'); }
  }, [active, key]);
  useEffect(() => {
    void refresh(offset);
    if (!active) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(offset); }, 5000);
    return () => { clearInterval(timer); request.current?.abort(); };
  }, [active, refresh, offset]);
  useOptionalWorkbenchEvents(event => {
    if (event.type === 'workbench.connected' || event.type === 'subagent.changed' && (!parentSessionId || event.parentSessionId === parentSessionId) && (!taskId || event.taskId === taskId)) void refresh(offset);
  });
  return { page: snapshot?.key === key ? snapshot.page : null, error, offset, refresh };
}

function ProcessDrawer({ item, onClose }: { item: SubagentListItem; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null), previous = useRef(document.activeElement);
  const [page, setPage] = useState<SubagentProcessPage | null>(null), [error, setError] = useState('');
  const [loaded, setLoaded] = useState(100);
  useLayoutEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { if (previous.current instanceof HTMLElement && previous.current.isConnected) previous.current.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    let disposed = false, request: AbortController | null = null;
    async function read() {
      request?.abort(); const controller = new AbortController(); request = controller;
      try {
        const items: SubagentProcessPage['items'] = []; let result: SubagentProcessPage | null = null;
        for (let offset = 0; offset < loaded; offset += 100) {
          result = await fetchJson(`/api/subagents/${encodeURIComponent(item.id)}/process?offset=${offset}&limit=100`, { signal: controller.signal }, SubagentProcessPageSchema);
          items.push(...result.items); if (result.nextOffset === null) break;
        }
        if (!disposed && !controller.signal.aborted && result) { setPage({ ...result, items }); setError(''); }
      } catch (error) { if (!disposed && !controller.signal.aborted) setError(error instanceof Error ? error.message : '过程读取失败。'); }
    }
    void read(); const timer = !item.stopConfirmed ? setInterval(() => void read(), 1500) : null;
    return () => { disposed = true; request?.abort(); if (timer) clearInterval(timer); };
  }, [item.id, item.stopConfirmed, loaded]);
  return createPortal(<div className="subagent-scrim" onPointerDown={event => event.stopPropagation()} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="subagent-drawer" ref={root} role="dialog" aria-modal="true" aria-label="子智能体只读过程" onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Tab') { const items = focusableWithin(event.currentTarget); const next = wrapFocusIndex(items.length, items.indexOf(document.activeElement as HTMLElement), event.shiftKey); if (next !== null) { event.preventDefault(); items[next]?.focus(); } }
    }}>
      <header><div><strong>{item.agent.name}</strong><small>只读过程 · {states[item.status]}</small></div><button type="button" className="icon-button" aria-label="关闭子智能体过程" onClick={onClose}><X /></button></header>
      <div className="subagent-drawer-body">
        <p className="subagent-parent">来自 {item.parentTitle}{item.taskId ? ' · 任务执行' : ' · 工作会话'}</p>
        <h2>{item.goal}</h2>
        <dl className="subagent-details"><div><dt>交付要求</dt><dd>{item.deliverable}</dd></div><div><dt>委派原因</dt><dd>{item.reason}</dd></div><div><dt>方式</dt><dd>{modes[item.mode]}</dd></div><div><dt>模型</dt><dd>{item.executor?.modelName ?? '尚未就绪'}</dd></div>{item.writeScope.length > 0 && <div><dt>写入范围</dt><dd>{item.writeScope.join('\n')}</dd></div>}<div><dt>已记录消耗</dt><dd>{elapsed(item)} · {item.toolCalls} 次工具 · {bytes(item.outputBytes)}{item.totalTokens !== null ? ` · ${item.totalTokens} token` : ' · token 未提供'}</dd></div></dl>
        <h3>完整过程</h3>
        {error && <p role="alert">{error}</p>}
        {!page && !error && <p role="status">正在读取过程…</p>}
        {page && !page.available && <p role="status">过程暂时不可读；未重新启动执行。</p>}
        {page?.items.map(entry => <article className={`subagent-process-entry ${entry.role}`} key={entry.id}>
          <strong>{entry.role === 'tool' ? `${entry.toolName} · ${entry.phase === 'input' ? '调用' : '输出'}` : entry.role === 'user' ? '委派输入' : entry.role === 'thinking' ? '思考' : item.agent.name}</strong>
          {entry.role === 'tool' || entry.role === 'thinking' ? <details open={entry.role === 'tool'}><summary>{entry.role === 'tool' ? '工具正文' : '查看思考'}</summary><pre>{entry.text}</pre></details> : <MarkdownBody text={entry.text} identity={`${item.id}:${entry.id}`} />}
        </article>)}
        {page?.nextOffset !== null && page?.nextOffset !== undefined && <button type="button" className="secondary-button" onClick={() => setLoaded(loaded + 100)}>读取后续过程</button>}
        {item.summary && <section><h3>结论</h3><MarkdownBody text={item.summary} identity={`${item.id}:summary`} /></section>}
        {item.changedFiles.length > 0 && <section><h3>改动文件</h3><pre>{item.changedFiles.join('\n')}</pre></section>}
        {item.commitHashes.length > 0 && <section><h3>本地提交</h3><pre>{item.commitHashes.join('\n')}</pre></section>}
        {!item.stopConfirmed && ['interrupted', 'reconcile'].includes(item.status) && <p>停止尚未确认，写入占用仍保留。</p>}
      </div>
    </div>
  </div>, document.body);
}

export function SubagentGroups({ items, showParent = false }: { items: readonly SubagentListItem[]; showParent?: boolean }) {
  const [selected, setSelected] = useState<SubagentListItem | null>(null);
  const groups = new Map<string, SubagentListItem[]>();
  for (const item of items) { const key = `${item.parentSessionId}:${item.batchId ?? item.parentCommandId}`; groups.set(key, [...(groups.get(key) ?? []), item]); }
  return <>{[...groups].map(([key, group]) => {
    const running = group.filter(item => !item.stopConfirmed).length;
    return <section key={key} className="subagent-group" aria-label="子智能体委派">
      <header><Bot aria-hidden="true" /><strong>子智能体</strong><span>{group.length} 项{running ? ` · ${running} 项处理中` : ' · 已结束'}</span>{showParent && <small>{group[0]!.parentTitle}{group[0]!.taskId ? ' · 任务' : ' · 工作会话'}</small>}</header>
      {group.map(item => <div className={`subagent-item ${item.status}`} key={item.id}>
        <button type="button" className="subagent-open" aria-label={`查看子智能体过程：${item.reason}`} onClick={() => setSelected(item)}>
          {!item.stopConfirmed ? <LoaderCircle className="spin" aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
          <span className="subagent-item-main"><strong>{item.reason}</strong><span>{item.agent.name} · {modes[item.mode]} · {item.executor?.modelName ?? '模型准备中'}</span><small>{item.currentStep ?? states[item.status]}</small></span>
          <span className="subagent-item-facts"><span>{states[item.status]}</span><small>{elapsed(item)} · {item.toolCalls} 次调用</small><small>{bytes(item.outputBytes)}{item.totalTokens !== null ? ` · ${item.totalTokens} token` : ''}</small></span><ChevronRight aria-hidden="true" />
        </button>
        {item.summary && <details className="subagent-conclusion"><summary>结论{item.summaryTruncated ? '（已截断）' : ''}{item.changedFiles.length ? ` · ${item.changedFiles.length} 个改动文件` : ''}{item.commitHashes.length ? ` · ${item.commitHashes.length} 个本地提交` : ''}</summary><MarkdownBody text={item.summary} identity={`${item.id}:card`} />{item.changedFiles.length > 0 && <pre>{item.changedFiles.join('\n')}</pre>}{item.commitHashes.length > 0 && <pre>{item.commitHashes.join('\n')}</pre>}</details>}
      </div>)}
    </section>;
  })}{selected && <ProcessDrawer item={items.find(item => item.id === selected.id) ?? selected} onClose={() => setSelected(null)} />}</>;
}

export function SubagentActivity(props: Filter & { showParent?: boolean }) {
  const { page, error, offset, refresh } = useSubagents(props);
  return <>{error && <p role="alert">{error}<button className="inline-link" onClick={() => void refresh(offset)}>重试</button></p>}<SubagentGroups items={page?.items ?? []} showParent={props.showParent ?? false} />{page && (offset > 0 || page.nextOffset !== null) && <div className="subagent-pagination"><button className="inline-link" disabled={offset === 0} onClick={() => void refresh(Math.max(0, offset - 20))}>上一页委派</button><button className="inline-link" disabled={page.nextOffset === null} onClick={() => void refresh(page.nextOffset!)}>下一页委派</button></div>}</>;
}
