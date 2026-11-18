import { useState } from 'react';
import { Bot, CircleAlert, Eye, LoaderCircle, Terminal } from 'lucide-react';
import type { SubagentListItem } from '@multivac/contracts';
import { useSubagents } from '../subagents/subagent-activity.js';
import { SubagentSessionView } from '../subagents/subagent-session-view.js';
import { SUBAGENT_STATES, formatElapsed } from '../subagents/subagent-labels.js';

/** 正常推进中的状态只用转圈表示，不另加状态标签；其余（待核对等）如实标出。 */
const PROGRESSING = new Set<SubagentListItem['status']>(['preparing', 'running']);

/**
 * 运行页的“子智能体运行”：与任务会话同一行式排版——目标与来源、已用时与当前步骤、查看过程。
 * 只列未确认停止的委派；已结束的过程从父会话或任务详情查看。
 */
export function SubagentRunSection({ active }: { active: boolean }) {
  const { page, error, offset, refresh } = useSubagents({ activeOnly: true, active });
  // 查看中的委派结束后会离开列表；保留打开时的记录，过程视图不因此关闭。
  const [opened, setOpened] = useState<SubagentListItem | null>(null);
  const items = page?.items ?? [];
  const selected = opened && (items.find(item => item.id === opened.id) ?? opened);

  return <section className="run-section" aria-label="子智能体运行" aria-busy={!page && !error}>
    <div className="run-section-heading"><h2>子智能体运行</h2><span>{page ? `${page.total} 个运行中` : '读取中…'}</span></div>
    {error && <p role="alert">{error} <button className="secondary-button compact" onClick={() => void refresh(offset)}>重试</button></p>}
    {items.map(item => {
      const progressing = PROGRESSING.has(item.status);
      return <article key={item.id} className={`run-row ${progressing ? '' : 'stalled'}`}>
        {progressing
          ? <LoaderCircle className="run-row-mark running spin" aria-hidden="true" />
          : <CircleAlert className="run-row-mark" aria-hidden="true" />}
        <div className="run-row-main">
          <div>
            <button className="run-row-title" title={item.goal} aria-haspopup="dialog" onClick={() => setOpened(item)}>{item.goal}</button>
            {!progressing && <span className="run-stalled">{SUBAGENT_STATES[item.status]}</span>}
          </div>
          <p title={`${item.agent.name} · 来自「${item.parentTitle}」`}>{item.agent.name} · 来自{item.taskId ? '任务' : '工作会话'}「{item.parentTitle}」</p>
        </div>
        <dl className="run-row-facts">
          <div><dt>已用时</dt><dd>{formatElapsed(item.elapsedMs)}</dd></div>
          <div><dt>当前步骤</dt><dd className="run-row-step"><Terminal aria-hidden="true" /><span title={item.currentStep ?? undefined}>{item.currentStep ?? '尚无工具调用'}</span><small>{item.toolCalls} 次工具</small></dd></div>
        </dl>
        <div className="run-row-actions">
          <button className="secondary-button compact" aria-haspopup="dialog" aria-label={`查看子智能体过程：${item.goal}`} onClick={() => setOpened(item)}>
            <Eye aria-hidden="true" />查看过程
          </button>
        </div>
      </article>;
    })}
    {page?.total === 0 && <div className="empty-state run-empty">
      <Bot aria-hidden="true" />
      <h3>没有正在运行的子智能体</h3>
      <p>会话或任务委派的子智能体运行时出现在这里；结束后可在父会话或任务详情中查看过程。</p>
    </div>}
    {page && (offset > 0 || page.nextOffset !== null) && <div className="run-row-actions">
      <button className="secondary-button compact" disabled={offset === 0} onClick={() => void refresh(Math.max(0, offset - 20))}>上一页</button>
      <button className="secondary-button compact" disabled={page.nextOffset === null} onClick={() => void refresh(page.nextOffset!)}>下一页</button>
    </div>}
    {selected && <SubagentSessionView item={selected} onClose={() => setOpened(null)} />}
  </section>;
}
