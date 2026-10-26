import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UsageStatistics } from '@multivac/contracts';
import { aggregateUsage } from '../../server/src/modules/usage/aggregate-usage.js';
import { measuredUsage, type UsageRecord } from '../../server/src/modules/usage/model-usage.js';

// 只替换页面数据读取和页头挂载点，实际 UsagePage、每日图、分布及排名参与渲染。
// 浏览器焦点刷新、维度切换交互和布局由 e2e/usage.spec.ts 覆盖。
const state = { data: null as UsageStatistics | null, error: '', loading: false, refresh: async () => {} };
const stateKey = Symbol.for('multivac.test.usage-page');
Reflect.set(globalThis, stateKey, state);
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/features/usage/use-usage-statistics.ts')) return { format: 'module', shortCircuit: true,
      source: 'export const useUsageStatistics = () => globalThis[Symbol.for("multivac.test.usage-page")];' };
    if (url.endsWith('/app/management-layout.tsx')) return { format: 'module', shortCircuit: true,
      source: 'export const ManagementPageActions = ({children}) => children;' };
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export {};' };
    return nextLoad(url, context);
  },
});
const { UsagePage } = await import('../src/features/usage/usage-page.js');
hooks.deregister();

const at = '2026-10-13T12:00:00.000Z';
function record(id: string, outcome: UsageRecord['outcome'], positive = false, startedAt = at): UsageRecord {
  return { requestId: id, startedAt, sessionId: 'shared', sessionTitle: '统计回归会话', runtimeSessionId: 'pi', provider: 'p', modelId: 'm',
    projectId: null, projectName: null, projectKnown: true, source: 'session', outcome,
    tokens: positive ? { input: 40, cacheRead: 20, output: 40, total: 100 } : null, raw: null,
    missingReason: positive ? null : '已有账本保留的无用量原因' };
}
const exempt = () => [record('failed', 'failed'), record('cancelled', 'cancelled'), record('running', 'pending'), record('restart-pending', 'pending', false, '2026-10-12T12:00:00.000Z')];
function data(records: UsageRecord[], reliable = true): UsageStatistics {
  return aggregateUsage(records, { days: 30, timeZone: 'UTC', now: at, collectionStartedAt: '2026-01-01T00:00:00.000Z',
    collectionReliable: reliable, warnings: reliable ? [] : ['用量记录发生错误，当前仅显示已记录的用量。'] });
}
function render(result: UsageStatistics): string {
  state.data = result;
  return renderToStaticMarkup(createElement(UsagePage, { active: true }));
}
function metrics(html: string): string[] {
  return [...html.matchAll(/<div class="usage-metric"><span>[^<]*<\/span><strong>([^<]*)<\/strong>/g)].map(match => match[1]!);
}
function area(html: string, className: string, end: string): string {
  const start = html.indexOf(`class="${className}"`);
  assert.ok(start >= 0, `缺少页面区域 ${className}`);
  return html.slice(start, html.indexOf(end, start) + end.length);
}

test('仅失败、取消、进行中及重启遗留pending显示已记录零与请求数，无分母指标仍为—', () => {
  const html = render(data(exempt()));
  assert.deepEqual(metrics(html), ['0', '0', '0', '4']);
  assert.match(html, /缓存命中 —/);
  assert.match(html, /日均 0 token/);
  assert.doesNotMatch(html, /用量缺失|缺失用量|未返回可确认|usage-warning|没有模型用量/);
  const detail = area(html, 'usage-day-detail', '</div></div>');
  assert.match(detail, /输入 0 · 缓存命中 0 · 输出 0/);
  assert.match(detail, /3 次已观测请求/);
  const distribution = area(html, 'usage-breakdown', '</ul>');
  assert.match(distribution, /0 · —/);
  assert.match(distribution, /4 次请求/);
  // 零用量会话仍遵循既有 Top5 筛选，不伪造可确认的测量。
  assert.match(html, /暂无可确认用量的会话/);
});

test('正常与豁免调用混合时所有已记录值、会话排名及满足原条件的环比显示一致', () => {
  const html = render(data([...exempt(), record('good', 'succeeded', true), record('previous', 'succeeded', true, '2026-09-01T12:00:00.000Z')]));
  assert.deepEqual(metrics(html), ['100', '60', '40', '5']);
  assert.match(html, /缓存命中 33.3%/);
  assert.match(html, /日均 3 token/);
  assert.match(html, /较上一周期 \+0%/);
  assert.doesNotMatch(html, /用量缺失|缺失用量|未返回可确认|usage-warning/);
  assert.match(area(html, 'usage-day-detail', '</div></div>'), /输入 40 · 缓存命中 20 · 输出 40/);
  assert.match(area(html, 'usage-breakdown', '</ul>'), /5 次请求/);
  const sessions = area(html, 'usage-sessions', '</ol>');
  assert.match(sessions, /统计回归会话/);
  assert.match(sessions, /class="usage-session-amount">100/);
});

test('仅豁免调用在上期有正数用量且周期完整时显示零日均与下降100%', () => {
  const html = render(data([...exempt(), record('previous', 'succeeded', true, '2026-09-01T12:00:00.000Z')]));
  assert.deepEqual(metrics(html), ['0', '0', '0', '4']);
  assert.match(html, /日均 0 token/);
  assert.match(html, /较上一周期 −100%/);
});

test('重新读取终态补入后的聚合结果只更新用量，不增加请求数', () => {
  const records = exempt();
  const before = render(data(records));
  assert.deepEqual(metrics(before), ['0', '0', '0', '4']);
  const after = render(data(records.map(item => item.requestId === 'running' ? { ...item, ...measuredUsage({ role: 'assistant', stopReason: 'stop',
    usage: { input: 40, cacheRead: 20, cacheWrite: 0, output: 40, totalTokens: 100 } }) } : item)));
  assert.deepEqual(metrics(after), ['100', '60', '40', '4']);
  assert.match(area(after, 'usage-sessions', '</ol>'), /class="usage-session-amount">100/);
  assert.doesNotMatch(after, /用量缺失|缺失用量|未返回可确认|usage-warning/);
});

test('成功但无效用量保留占位和缺失提示，混合测量仍显示已记录的实际数值', () => {
  for (const usage of [undefined, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0 }]) {
    const missing = { ...record('missing', 'succeeded'), ...measuredUsage({ role: 'assistant', stopReason: 'stop', usage }) };
    const html = render(data([...exempt(), missing]));
    assert.deepEqual(metrics(html), ['—', '—', '—', '5']);
    assert.match(html, /有 1 次请求未返回可确认的用量/);
    assert.match(area(html, 'usage-day-detail', '</div></div>'), /1 次用量缺失/);
    assert.match(area(html, 'usage-breakdown', '</ul>'), /1 次用量缺失/);
    assert.doesNotMatch(html, /日均|较上一周期/);
    const mixed = render(data([...exempt(), missing, record('good', 'succeeded', true)]));
    assert.deepEqual(metrics(mixed), ['100', '60', '40', '6']);
    assert.match(area(mixed, 'usage-sessions', '</ol>'), /1 次用量缺失/);
    assert.match(mixed, /有 1 次请求未返回可确认的用量/);
    assert.doesNotMatch(mixed, /日均|较上一周期/);
  }
});

test('真实采集异常提示独立于缺失数，日均和环比继续隐藏', () => {
  const html = render(data([...exempt(), record('good', 'succeeded', true), record('previous', 'succeeded', true, '2026-09-01T12:00:00.000Z')], false));
  assert.deepEqual(metrics(html), ['100', '60', '40', '5']);
  assert.match(html, /class="usage-warning"/);
  assert.match(html, /用量记录发生错误，当前仅显示已记录的用量/);
  assert.doesNotMatch(html, /用量缺失|缺失用量|未返回可确认|日均|较上一周期/);
});
