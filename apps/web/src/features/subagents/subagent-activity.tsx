import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Bot, CheckCircle2, ChevronRight, CircleAlert, LoaderCircle } from 'lucide-react';
import { SubagentPageSchema, type SubagentListItem, type SubagentPage } from '@multivac/contracts';
import { fetchJson } from '../../data/assistant-api.js';
import { useOptionalWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { SubagentSessionView } from './subagent-session-view.js';
import { SUBAGENT_STATES as states, formatElapsed } from './subagent-labels.js';
import './subagents.css';

const elapsed = (item: SubagentListItem) => formatElapsed(item.elapsedMs);
type Filter = { parentSessionId?: string; taskId?: string; activeOnly?: boolean; active?: boolean; limit?: number };

/** 每个查看现场只订阅一次；事件合并刷新，重连及定期补读都只读事实。 */
export function useSubagents({ parentSessionId, taskId, activeOnly, active = true, limit = 20 }: Filter) {
  const key = JSON.stringify({ parentSessionId, taskId, activeOnly });
  const [snapshot, setSnapshot] = useState<{ key: string; page: SubagentPage } | null>(null);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async (nextOffset = 0) => {
    if (!active) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const params = new URLSearchParams(JSON.parse(key) as Record<string, string>); params.set('offset', String(nextOffset)); params.set('limit', String(limit));
    try {
      const page = await fetchJson(`/api/subagents?${params}`, { signal: controller.signal }, SubagentPageSchema);
      if (!controller.signal.aborted) { setSnapshot({ key, page }); setOffset(nextOffset); setError(''); }
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '委派读取失败。'); }
  }, [active, key, limit]);
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

export function SubagentGroups({ items, showParent = false }: { items: readonly SubagentListItem[]; showParent?: boolean }) {
  const [selected, setSelected] = useState<SubagentListItem | null>(null);
  const groups = new Map<string, SubagentListItem[]>();
  for (const item of items) { const key = `${item.parentSessionId}:${item.batchId ?? item.parentCommandId}`; groups.set(key, [...(groups.get(key) ?? []), item]); }
  return <>{[...groups].map(([key, group]) => {
    const running = group.filter(item => !item.stopConfirmed).length;
    // 单项委派不需要分组标题；多项或跨会话列表才说明数量与来源。
    const titled = group.length > 1 || showParent;
    return <section key={key} className="subagent-group" aria-label="子智能体委派">
      {titled && <header><Bot aria-hidden="true" /><span>子智能体 · {group.length} 项{running ? ` · ${running} 项处理中` : ''}</span>{showParent && <small>{group[0]!.parentTitle}{group[0]!.taskId ? ' · 任务' : ' · 工作会话'}</small>}</header>}
      {group.map(item => {
        const done = item.stopConfirmed;
        const Icon = !done ? LoaderCircle : item.status === 'succeeded' ? CheckCircle2 : CircleAlert;
        return <div className={`subagent-item ${item.status}`} key={item.id}>
          <button type="button" className="subagent-open" aria-label={`查看子智能体过程：${item.goal}`} aria-haspopup="dialog" title={item.goal} onClick={() => setSelected(item)}>
            <Icon className={done ? '' : 'spin'} aria-hidden="true" />
            <span className="subagent-item-main">
              <strong>{item.goal}</strong>
              <small>{titled ? '' : '子智能体 · '}{item.agent.name} · {!done && item.currentStep ? item.currentStep : `${elapsed(item)} · ${item.toolCalls} 次工具`}</small>
            </span>
            {item.status !== 'succeeded' && <span className="subagent-item-state">{states[item.status]}</span>}
            <ChevronRight aria-hidden="true" />
          </button>
        </div>;
      })}
    </section>;
  })}{selected && <SubagentSessionView item={items.find(item => item.id === selected.id) ?? selected} onClose={() => setSelected(null)} />}</>;
}

/** empty：读取完成且没有委派时的占位内容。 */
export function SubagentActivity({ empty, ...props }: Filter & { showParent?: boolean; empty?: ReactNode }) {
  const { page, error, offset, refresh } = useSubagents(props);
  return <>{error && <p role="alert">{error}<button className="inline-link" onClick={() => void refresh(offset)}>重试</button></p>}{page?.total === 0 && empty}<SubagentGroups items={page?.items ?? []} showParent={props.showParent ?? false} />{page && (offset > 0 || page.nextOffset !== null) && <div className="subagent-pagination"><button className="inline-link" disabled={offset === 0} onClick={() => void refresh(Math.max(0, offset - 20))}>上一页委派</button><button className="inline-link" disabled={page.nextOffset === null} onClick={() => void refresh(page.nextOffset!)}>下一页委派</button></div>}</>;
}
