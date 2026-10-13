import { test, expect, type Page } from '@playwright/test';
import type { UsageDays, UsageStatistics, UsageTotals } from '@multivac/contracts';
import { resetE2eState, openPanel } from './test-state.js';

// 仅浏览器测试的接口夹具；正式页面没有示例数据路径。
const zero = (): UsageTotals => ({ input: 0, cacheRead: 0, output: 0, total: 0, requests: 0, measuredRequests: 0, missingRequests: 0, cacheHitRate: null });
function fixture(days: UsageDays, uncovered = false): UsageStatistics {
  const date = new Date('2026-10-13T00:00:00.000Z');
  const summary = uncovered ? zero() : { input: 120, cacheRead: 80, output: 40, total: 240, requests: 1, measuredRequests: 1, missingRequests: 0, cacheHitRate: 0.4 };
  const daily = Array.from({ length: days }, (_, index) => {
    const day = new Date(date); day.setUTCDate(day.getUTCDate() + index - days + 1);
    return { date: day.toISOString().slice(0, 10), ...(index === days - 1 ? summary : zero()), coverage: uncovered ? 'uncovered' as const : 'complete' as const };
  });
  const group = (key: string, label: string) => ({ ...summary, key, label, share: 1 });
  return { days, timeZone: 'Asia/Shanghai', generatedAt: '2026-10-13T12:00:00.000Z', startDate: daily[0].date, endDate: '2026-10-13',
    summary, previous: zero(), delta: null, dailyAverage: uncovered ? null : 240 / days, daily,
    distributions: uncovered ? { model: [], project: [], source: [] } : { model: [group('m', 'provider / model')], project: [group('none', '日常（无项目）')], source: [group('task', '任务执行')] },
    topSessions: uncovered ? [] : [{ ...group('s', '真实用量会话'), description: '日常（无项目） · 任务执行' }],
    coverage: { current: uncovered ? 'uncovered' : 'complete', previous: 'partial', collectionStartedAt: '2026-10-01T00:00:00.000Z', history: 'scanned', unplacedRequests: 0,
      reasons: uncovered ? ['所选日期没有覆盖，历史用量未知'] : ['历史仅恢复可验证的响应'] } };
}
async function openUsage(page: Page) {
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '统计', exact: true }).click();
}

test('真实接口接入、默认范围、维度切换、当天明细与侧栏窄容器布局', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  const queries: URL[] = [];
  await page.route('**/api/usage?**', route => {
    const url = new URL(route.request().url()); queries.push(url);
    return route.fulfill({ json: fixture(Number(url.searchParams.get('days')) as UsageDays) });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openUsage(page);
  const usage = page.locator('.usage-page');
  await expect(page.getByRole('radio', { name: '近 30 天', exact: true })).toBeChecked();
  await expect(usage.locator('.usage-metric strong').first()).toHaveText('240');
  expect(queries[0].searchParams.get('days')).toBe('30');
  expect(queries[0].searchParams.has('timeZone')).toBeTruthy();
  expect(queries.every(url => !url.searchParams.has('projectId'))).toBeTruthy();
  await expect(usage.locator('select')).toHaveCount(0);
  await expect(usage.getByText(/费用|原型示例|预算管理/)).toHaveCount(0);
  await expect(usage.locator('.usage-bar')).toHaveCount(30);
  await usage.locator('.usage-bar').first().hover();
  await expect(usage.locator('.usage-day-detail')).toContainText('2026-09-14');
  await usage.locator('.usage-bar').last().focus();
  await page.keyboard.press('ArrowLeft');
  await expect(usage.locator('.usage-day-detail')).toContainText('2026-10-12');
  await page.getByRole('radio', { name: '按项目', exact: true }).click();
  await expect(usage.locator('.usage-breakdown')).toContainText('日常（无项目）');
  await page.getByRole('radio', { name: '按来源', exact: true }).click();
  await expect(usage.locator('.usage-breakdown')).toContainText('任务执行');
  await expect(usage.locator('.usage-sessions li')).toHaveCount(1);
  await expect(usage.locator('.usage-sessions a, .usage-sessions button')).toHaveCount(0);
  await usage.screenshot({ path: testInfo.outputPath('usage-1440.png') });
  await page.setViewportSize({ width: 1120, height: 900 });
  await page.keyboard.press('Control+j');
  await expect(usage).toBeVisible();
  expect(await usage.evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('usage-sidebar-1120.png') });
  for (const days of [7, 90] as const) {
    await page.getByRole('radio', { name: `近 ${days} 天`, exact: true }).click();
    await expect(usage.locator('.usage-bar')).toHaveCount(days);
  }
});

test('首次加载不伪造零、失败重试、未覆盖和真实零明确区分', async ({ page, request }) => {
  await resetE2eState(request);
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let mode: 'loading' | 'error' | 'uncovered' | 'zero' = 'loading';
  await page.route('**/api/usage?**', async route => {
    if (mode === 'loading') await gate;
    if (mode === 'error') return route.fulfill({ status: 500, json: { error: { code: 'INTERNAL_ERROR', message: '统计读取失败' } } });
    const data = fixture(Number(new URL(route.request().url()).searchParams.get('days')) as UsageDays, true);
    if (mode === 'zero') {
      data.coverage.current = 'complete'; data.coverage.reasons = []; data.dailyAverage = 0;
      data.daily = data.daily.map(day => ({ ...day, coverage: 'complete' }));
    }
    await route.fulfill({ json: data });
  });
  await openUsage(page);
  await expect(page.getByText('正在读取真实用量')).toBeVisible();
  await expect(page.locator('.usage-metric')).toHaveCount(0);
  mode = 'error'; release();
  await expect(page.locator('.usage-error')).toContainText('统计读取失败');
  mode = 'uncovered'; await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('.usage-metric strong').first()).toHaveText('—');
  await expect(page.getByText('数据覆盖不足，部分用量未知')).toBeVisible();
  await expect(page.locator('.usage-bar[data-coverage="uncovered"]')).toHaveCount(30);
  mode = 'zero';
  await page.getByRole('radio', { name: '近 7 天', exact: true }).click();
  await expect(page.locator('.usage-metric strong').first()).toHaveText('0');
});

test('快速切换范围时迟到响应不能覆盖新范围', async ({ page, request }) => {
  await resetE2eState(request);
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let receivedSeven = false;
  await page.route('**/api/usage?**', async route => {
    const days = Number(new URL(route.request().url()).searchParams.get('days')) as UsageDays;
    if (days === 7) { receivedSeven = true; await gate; }
    try { await route.fulfill({ json: fixture(days) }); } catch { /* 旧范围请求已被浏览器取消。 */ }
  });
  await openUsage(page);
  await expect(page.locator('.usage-bar')).toHaveCount(30);
  await page.getByRole('radio', { name: '近 7 天', exact: true }).click();
  await expect.poll(() => receivedSeven).toBeTruthy();
  await page.getByRole('radio', { name: '近 90 天', exact: true }).click();
  await expect(page.locator('.usage-bar')).toHaveCount(90);
  release();
  await expect(page.getByRole('radio', { name: '近 90 天', exact: true })).toBeChecked();
  await expect(page.locator('.usage-bar')).toHaveCount(90);
});
