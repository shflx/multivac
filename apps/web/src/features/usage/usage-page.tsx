import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AlertCircle, LoaderCircle, RefreshCw } from 'lucide-react';
import type { UsageCoverage, UsageDaily, UsageDays, UsageTotals } from '@multivac/contracts';
import { ManagementPageActions } from '../../app/management-layout.js';
import { SettingsCard } from '../../components/settings-card.js';
import { useUsageStatistics } from './use-usage-statistics.js';
import './usage.css';

const ranges = [7, 30, 90] as const;
const dimensions = [{ id: 'model', label: '按模型' }, { id: 'project', label: '按项目' }, { id: 'source', label: '按来源' }] as const;
const coverageLabel = { complete: '已覆盖', partial: '部分覆盖', uncovered: '未覆盖' };
const share = (value: number | null) => value === null ? '—' : `${Number((value * 100).toFixed(1))}%`;
function tokens(value: number): string {
  for (const [factor, unit] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (value >= factor) return `${Number((value / factor).toFixed(factor === 1e3 ? 1 : 2))}${unit}`;
  }
  return value.toLocaleString('zh-CN');
}
const value = (amount: number, totals: UsageTotals, coverage: UsageCoverage = 'partial') => totals.measuredRequests > 0 || coverage === 'complete' ? tokens(amount) : '—';
const breakdown = (totals: UsageTotals, coverage: UsageCoverage = 'partial') => `输入 ${value(totals.input, totals, coverage)} · 缓存命中 ${value(totals.cacheRead, totals, coverage)} · 输出 ${value(totals.output, totals, coverage)}`;
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
  const peak = Math.max(1, ...daily.map(day => day.total));
  return <div className="usage-chart">
    <div className="usage-chart-bars" role="group" aria-label="每日 token 用量">
      {daily.map((day, index) => {
        const title = `${day.date} · 已记录 ${value(day.total, day, day.coverage)} token · ${coverageLabel[day.coverage]}\n${breakdown(day, day.coverage)} · ${day.requests} 次已观测请求${day.missingRequests ? ` · ${day.missingRequests} 次缺失用量` : ''}`;
        return <button type="button" key={day.date} className="usage-bar" data-coverage={day.coverage} aria-label={title}
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
    <div className="usage-chart-axis"><span>{dayLabel(daily[0]!.date)}</span><span>今天</span></div>
    <ul className="usage-legend"><li><i className="input" />输入</li><li><i className="cache" />缓存命中</li><li><i className="output" />输出</li><li><i className="uncovered" />覆盖不足</li></ul>
    <div id={detailId} className="usage-day-detail" aria-live="polite"><strong>{active.date} · {coverageLabel[active.coverage]}</strong><span>{breakdown(active, active.coverage)}</span><span>{active.requests} 次已观测请求{active.missingRequests > 0 && `，其中 ${active.missingRequests} 次用量缺失`}</span></div>
  </div>;
}

export function UsagePage({ active }: { active: boolean }) {
  const [days, setDays] = useState<UsageDays>(30);
  const [dimension, setDimension] = useState<(typeof dimensions)[number]['id']>('model');
  const { data, error, loading, refresh } = useUsageStatistics(active, days);
  const summary = data?.summary;
  let deltaNote = '历史覆盖不足，暂不比较';
  if (data?.coverage.current === 'complete') deltaNote = data.coverage.previous !== 'complete' ? '上一周期覆盖不足' : data.delta === null ? '上一周期没有用量' : `较上一周期 ${data.delta >= 0 ? '+' : '−'}${share(Math.abs(data.delta))}`;
  return <div className="usage-page" data-management-page="usage" aria-busy={loading}>
    <ManagementPageActions><div className="segmented" role="radiogroup" aria-label="统计时间范围" onKeyDown={moveRadio}>
      {ranges.map(range => <button type="button" key={range} role="radio" aria-checked={days === range} tabIndex={days === range ? 0 : -1} className={days === range ? 'active' : ''} onClick={() => setDays(range)}>近 {range} 天</button>)}
    </div></ManagementPageActions>
    {error && <div className="usage-error" role="alert"><AlertCircle aria-hidden="true" /><span>{data ? `更新失败，显示上次读取的数据。${error}` : error}</span><button type="button" className="secondary-button" disabled={loading} onClick={() => void refresh()}><RefreshCw aria-hidden="true" />重试</button></div>}
    {!data || !summary ? !error && <div className="management-page-state" role="status"><LoaderCircle className="spin" aria-hidden="true" /><p>正在读取真实用量</p></div> : <>
      <section className="usage-summary" aria-label="用量总览">
        <Metric label="总用量" amount={value(summary.total, summary, data.coverage.current)} note={deltaNote} />
        <Metric label="输入" amount={value(summary.input + summary.cacheRead, summary, data.coverage.current)} note={`缓存命中 ${share(summary.cacheHitRate)}`} />
        <Metric label="输出" amount={value(summary.output, summary, data.coverage.current)} />
        <Metric label="模型请求" amount={summary.requests > 0 || data.coverage.current === 'complete' ? summary.requests.toLocaleString('zh-CN') : '—'} note={data.dailyAverage === null ? '日均暂无完整数据' : `日均 ${tokens(Math.round(data.dailyAverage))} token`} />
      </section>
      <div className="usage-coverage"><p>已记录用量 · {data.startDate} 至 {data.endDate} · {data.timeZone}{loading && ' · 正在更新'}</p>
        {data.coverage.reasons.length > 0 && <details><summary>{data.coverage.current === 'complete' ? '历史数据覆盖说明' : '数据覆盖不足，部分用量未知'}</summary><ul>{data.coverage.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></details>}
      </div>
      <SettingsCard title="每日用量" description={`近 ${days} 天，${summary.measuredRequests > 0 || data.coverage.current === 'complete' ? `单日已记录最高 ${tokens(Math.max(0, ...data.daily.map(day => day.total)))}` : '暂无可确认的每日峰值'}。悬停、聚焦或点击柱子查看当天明细。`}>
        {summary.requests === 0 && <p className="usage-empty">{data.coverage.current === 'complete' ? `近 ${days} 天没有模型用量。` : '所选范围没有可确认的用量记录；未覆盖时段的用量未知。'}</p>}
        <DailyChart daily={data.daily} />
      </SettingsCard>
      <SettingsCard title="用量分布">
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
      <SettingsCard title="用量最多的会话" description="按会话已记录用量累计，包含它发起的全部已观测模型请求。">
        <ol className="usage-sessions">{data.topSessions.map(session => <li key={session.key}><div><strong>{session.label}</strong><small>{session.description}{session.missingRequests > 0 && ` · ${session.missingRequests} 次用量缺失`}</small></div><span>{tokens(session.total)}</span></li>)}</ol>
        {data.topSessions.length === 0 && <p className="usage-empty">暂无可确认用量的会话。</p>}
      </SettingsCard>
    </>}
  </div>;
}
