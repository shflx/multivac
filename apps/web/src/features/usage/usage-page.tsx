import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AlertCircle, LoaderCircle, RefreshCw } from 'lucide-react';
import type { UsageDaily, UsageDays, UsageTotals } from '@multivac/contracts';
import { ManagementPageActions } from '../../app/management-layout.js';
import { SettingsCard } from '../../components/settings-card.js';
import { useUsageStatistics } from './use-usage-statistics.js';
import './usage.css';

const ranges = [7, 30, 90] as const;
const dimensions = [{ id: 'model', label: '按模型' }, { id: 'project', label: '按项目' }, { id: 'source', label: '按来源' }] as const;
const share = (value: number | null) => value === null ? '—' : `${Number((value * 100).toFixed(1))}%`;
function tokens(value: number): string {
  for (const [factor, unit] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (value >= factor) return `${Number((value / factor).toFixed(factor === 1e3 ? 1 : 2))}${unit}`;
  }
  return value.toLocaleString('zh-CN');
}
// 无有效测量时，只对真实缺失显示占位；失败、取消和待返回仍显示已记录的零。
const value = (amount: number, totals: UsageTotals) => totals.missingRequests === 0 || totals.measuredRequests > 0 ? tokens(amount) : '—';
const breakdown = (totals: UsageTotals) => `输入 ${value(totals.input, totals)} · 缓存命中 ${value(totals.cacheRead, totals)} · 输出 ${value(totals.output, totals)}`;
const dayLabel = (date: string) => date.slice(5).split('-').map(Number).join('/');

function Metric({ label, amount, note }: { label: string; amount: string; note?: ReactNode }) {
  return <div className="usage-metric"><span>{label}</span><strong>{amount}</strong>{note && <small>{note}</small>}</div>;
}
/** radio 使用方向键切换并移动焦点，保持与点击一致的状态。 */
function moveRadio(event: KeyboardEvent<HTMLDivElement>) {
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length;
  buttons[next]?.click(); buttons[next]?.focus();
}

function DailyChart({ daily }: { daily: UsageDaily[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const detailId = useId();
  const active = daily.find(day => day.date === selected) ?? daily.at(-1)!;
  const peak = Math.max(0, ...daily.map(day => day.total));
  const axisIndexes = [...new Set([0, 1, 2, 3, 4].map(index => Math.round(index * (daily.length - 1) / 4)))];
  return <div className="usage-chart">
    <div className="usage-plot">
      <div className="usage-chart-scale" aria-hidden="true">{[1, .75, .5, .25, 0].map(scale => <span key={scale}>{peak > 0 ? tokens(Math.ceil(peak * scale)) : scale === 0 ? '0' : ''}</span>)}</div>
      <div className="usage-chart-bars" role="group" aria-label="每日 token 用量">
        {daily.map((day, index) => {
          const title = `${day.date} · 已记录 ${value(day.total, day)} token\n${breakdown(day)} · ${day.requests} 次已观测请求${day.missingRequests ? ` · ${day.missingRequests} 次缺失用量` : ''}`;
          return <button type="button" key={day.date} className="usage-bar" aria-label={title} aria-pressed={active.date === day.date}
            title={title} aria-describedby={detailId} tabIndex={active.date === day.date ? 0 : -1}
            onMouseEnter={() => setSelected(day.date)} onFocus={() => setSelected(day.date)} onClick={() => setSelected(day.date)}
            onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? daily.length - 1 : Math.max(0, Math.min(daily.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)));
              (event.currentTarget.parentElement?.children.item(next) as HTMLButtonElement | null)?.focus();
            }}>
            {day.total > 0 && <span className="usage-bar-stack" style={{ height: `${day.total / peak * 100}%` }} aria-hidden="true">
              <i className="input" style={{ flexGrow: day.input }} /><i className="cache" style={{ flexGrow: day.cacheRead }} /><i className="output" style={{ flexGrow: day.output }} />
            </span>}
          </button>;
        })}
      </div>
    </div>
    <div className="usage-chart-axis">{axisIndexes.map(index => <span key={daily[index]!.date}>{index === daily.length - 1 ? '今天' : dayLabel(daily[index]!.date)}</span>)}</div>
    <ul className="usage-legend"><li><i className="input" />输入</li><li><i className="cache" />缓存命中</li><li><i className="output" />输出</li></ul>
    <div id={detailId} className="usage-day-detail" aria-live="polite"><div className="usage-day-total"><strong>{active.date}</strong><span>{value(active.total, active)} <small>token</small></span></div><span>{breakdown(active)}</span><span>{active.requests} 次已观测请求{active.missingRequests > 0 && `，其中 ${active.missingRequests} 次用量缺失`}</span></div>
  </div>;
}

export function UsagePage({ active }: { active: boolean }) {
  const [days, setDays] = useState<UsageDays>(30);
  const [dimension, setDimension] = useState<(typeof dimensions)[number]['id']>('model');
  const { data, error, loading, refresh } = useUsageStatistics(active, days);
  const summary = data?.summary;
  const deltaNote = data?.delta === null || !data ? null : `较上一周期 ${data.delta >= 0 ? '+' : '−'}${share(Math.abs(data.delta))}`;
  return <div className="usage-page" data-management-page="usage" aria-busy={loading}>
    <ManagementPageActions><div className="segmented" role="radiogroup" aria-label="统计时间范围" onKeyDown={moveRadio}>
      {ranges.map(range => <button type="button" key={range} role="radio" aria-checked={days === range} tabIndex={days === range ? 0 : -1} className={days === range ? 'active' : ''} onClick={() => setDays(range)}>近 {range} 天</button>)}
    </div></ManagementPageActions>
    {error && <div className="usage-error" role="alert"><AlertCircle aria-hidden="true" /><span>{data ? `更新失败，显示上次读取的数据。${error}` : error}</span><button type="button" className="secondary-button" disabled={loading} onClick={() => void refresh()}><RefreshCw aria-hidden="true" />重试</button></div>}
    {!data || !summary ? !error && <div className="management-page-state" role="status"><LoaderCircle className="spin" aria-hidden="true" /><p>正在读取真实用量</p></div> : <>
      <section className="usage-summary" aria-label="用量总览">
        <Metric label="总用量" amount={value(summary.total, summary)} note={deltaNote} />
        <Metric label="输入" amount={value(summary.input + summary.cacheRead, summary)} note={`缓存命中 ${share(summary.cacheHitRate)}`} />
        <Metric label="输出" amount={value(summary.output, summary)} />
        <Metric label="模型请求" amount={summary.requests.toLocaleString('zh-CN')} note={data.dailyAverage === null && data.warnings.length === 0 ? null : <>
          {data.dailyAverage !== null && <span title={`按实际统计的 ${data.statisticsDays} 天计算`}>日均 {tokens(Math.round(data.dailyAverage))} token</span>}
          {data.warnings.length > 0 && <span className="usage-warning" role="status">{data.warnings.map(warning => <span key={warning}>{warning}</span>)}</span>}
        </>} />
      </section>
      <SettingsCard title="每日用量" description={`近 ${days} 天，单日已记录最高 ${tokens(Math.max(0, ...data.daily.map(day => day.total)))} token。悬停或选择日期查看明细。`}>
        {summary.requests === 0 && <p className="usage-empty">近 {days} 天没有模型用量。</p>}
        <DailyChart daily={data.daily} />
      </SettingsCard>
      <div className="usage-details">
        <SettingsCard title="用量分布" description="按模型、项目或来源查看用量占比。">
          <div className="usage-card-toolbar"><div className="segmented" role="radiogroup" aria-label="用量分布维度" onKeyDown={moveRadio}>
            {dimensions.map(item => <button type="button" key={item.id} role="radio" aria-checked={dimension === item.id} tabIndex={dimension === item.id ? 0 : -1} className={dimension === item.id ? 'active' : ''} onClick={() => setDimension(item.id)}>{item.label}</button>)}
          </div></div>
          <ul className="usage-breakdown" aria-label="用量分布">{data.distributions[dimension].map(group => <li key={group.key}>
            <div className="usage-breakdown-head"><strong>{group.label}</strong><span>{value(group.total, group)} · {share(group.share)}</span></div>
            <div className="usage-meter" aria-hidden="true"><span style={{ width: `${(group.share ?? 0) * 100}%` }} /></div>
            <small>{breakdown(group)} · {group.requests} 次请求{group.missingRequests > 0 && ` · ${group.missingRequests} 次用量缺失`}</small>
          </li>)}</ul>
          {data.distributions[dimension].length === 0 && <p className="usage-empty">暂无可分组的用量记录。</p>}
        </SettingsCard>
        <SettingsCard title="用量最多的会话" description="按已记录用量排序，展示前五个会话。">
          <ol className="usage-sessions">{data.topSessions.map((session, index) => <li key={session.key}><span className="usage-session-rank" aria-hidden="true">{index + 1}</span><div><strong>{session.label}</strong><small>{session.description}{session.missingRequests > 0 && ` · ${session.missingRequests} 次用量缺失`}</small></div><span className="usage-session-amount">{value(session.total, session)}</span></li>)}</ol>
          {data.topSessions.length === 0 && <p className="usage-empty">暂无可确认用量的会话。</p>}
        </SettingsCard>
      </div>
    </>}
  </div>;
}
