import { test, expect, type Page } from '@playwright/test';
import type { UsageDays, UsageStatistics, UsageTotals } from '@multivac/contracts';
import { resetE2eState, openPanel } from './test-state.js';

// 仅浏览器测试的接口夹具；正式页面没有示例数据路径。
const zero = (): UsageTotals => ({ input: 0, cacheRead: 0, output: 0, total: 0, requests: 0, measuredRequests: 0, missingRequests: 0, cacheHitRate: null });
function fixture(days: UsageDays, empty = false): UsageStatistics {
  const date = new Date('2026-10-13T00:00:00.000Z');
  const summary = empty ? zero() : { input: 120, cacheRead: 80, output: 40, total: 240, requests: 1, measuredRequests: 1, missingRequests: 0, cacheHitRate: 0.4 };
  const daily = Array.from({ length: days }, (_, index) => {
    const day = new Date(date); day.setUTCDate(day.getUTCDate() + index - days + 1);
    return { date: day.toISOString().slice(0, 10), ...(index === days - 1 ? summary : zero()) };
  });
  const group = (key: string, label: string) => ({ ...summary, key, label, share: 1 });
  return { days, timeZone: 'Asia/Shanghai', generatedAt: '2026-10-13T12:00:00.000Z', startDate: daily[0].date, endDate: '2026-10-13',
    summary, previous: zero(), delta: null, dailyAverage: empty ? 0 : 240, statisticsDays: 1, daily,
    distributions: empty ? { model: [], project: [], source: [] } : { model: [group('m', 'provider / model')], project: [group('none', '日常（无项目）')], source: [group('task', '任务执行')] },
    topSessions: empty ? [] : [{ ...group('s', '真实用量会话'), description: '日常（无项目） · 任务执行' }],
    warnings: [] };
}
async function openUsage(page: Page) {
  await page.goto('/');
  // 等待外壳挂载后再按快捷键，避免初次加载时按键早于事件监听。
  await expect(page.getByRole('button', { name: '快捷键', exact: true })).toBeVisible();
  await openPanel(page, 'management');
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
  await expect(usage.locator('.usage-metric').first().locator('small')).toHaveCount(0);
  expect(queries[0].searchParams.get('days')).toBe('30');
  expect(queries[0].searchParams.has('timeZone')).toBeTruthy();
  expect(queries.every(url => !url.searchParams.has('projectId'))).toBeTruthy();
  await expect(usage.locator('select')).toHaveCount(0);
  await expect(usage.getByText(/费用|原型示例|预算管理|历史|覆盖|自.+开始统计|已记录用量 ·|Asia\/Shanghai/)).toHaveCount(0);
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

test('首次加载与读取失败不伪造零，空账本显示零，真实缺失用量仅有简短提示', async ({ page, request }) => {
  await resetE2eState(request);
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let mode: 'loading' | 'error' | 'empty' | 'missing' = 'loading';
  await page.route('**/api/usage?**', async route => {
    if (mode === 'loading') await gate;
    if (mode === 'error') return route.fulfill({ status: 500, json: { error: { code: 'INTERNAL_ERROR', message: '统计读取失败' } } });
    const data = fixture(Number(new URL(route.request().url()).searchParams.get('days')) as UsageDays, true);
    if (mode === 'missing') {
      data.summary = { ...zero(), requests: 1, missingRequests: 1 };
      data.daily[data.daily.length - 1] = { ...data.summary, date: data.endDate };
      data.dailyAverage = null;
      data.warnings = ['有 1 次请求未返回可确认的用量。'];
    }
    await route.fulfill({ json: data });
  });
  await openUsage(page);
  await expect(page.getByText('正在读取真实用量')).toBeVisible();
  await expect(page.locator('.usage-metric')).toHaveCount(0);
  mode = 'error'; release();
  await expect(page.locator('.usage-error')).toContainText('统计读取失败');
  mode = 'empty'; await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('.usage-metric strong')).toHaveText(['0', '0', '0', '0']);
  await expect(page.locator('.usage-page')).toContainText('近 30 天没有模型用量。');
  await expect(page.locator('.usage-bar')).toHaveCount(30);
  await expect(page.locator('.usage-warning')).toHaveCount(0);
  await expect(page.locator('.usage-page').getByText(/未知|历史|覆盖|自.+开始统计/)).toHaveCount(0);
  await page.locator('.usage-bar').first().hover();
  await expect(page.locator('.usage-day-detail')).toContainText('输入 0 · 缓存命中 0 · 输出 0');
  mode = 'missing';
  await page.getByRole('radio', { name: '近 7 天', exact: true }).click();
  await expect(page.locator('.usage-metric strong')).toHaveText(['—', '—', '—', '1']);
  await expect(page.locator('.usage-metric').last().locator('.usage-warning')).toHaveText('有 1 次请求未返回可确认的用量。');
  await expect(page.locator('.usage-page').getByText('暂无日均', { exact: true })).toHaveCount(0);
});

test('豁免调用、混合用量、终态刷新及真实异常在各区域显示一致', async ({ page, request }) => {
  await resetE2eState(request);
  type Mode = 'exempt' | 'mixed' | 'completed' | 'missing' | 'collection-error';
  let mode: Mode = 'exempt';
  await page.route('**/api/usage?**', route => {
    const days = Number(new URL(route.request().url()).searchParams.get('days')) as UsageDays;
    const data = fixture(days);
    const measured = mode === 'mixed' || mode === 'completed' || mode === 'collection-error';
    const summary = { ...(measured ? data.summary : zero()), requests: mode === 'mixed' || mode === 'completed' ? 5 : 4, missingRequests: mode === 'missing' ? 1 : 0 };
    if (mode === 'completed') {
      for (const field of ['input', 'cacheRead', 'output', 'total', 'measuredRequests'] as const) summary[field] *= 2;
    }
    data.summary = summary;
    data.daily = data.daily.map(day => ({ ...day, ...(day.date === data.endDate ? summary : zero()) }));
    data.previous = { ...fixture(days).summary };
    data.delta = mode === 'missing' || mode === 'collection-error' ? null : (summary.total - data.previous.total) / data.previous.total;
    data.dailyAverage = mode === 'missing' || mode === 'collection-error' ? null : summary.total;
    for (const groups of Object.values(data.distributions)) for (const group of groups) Object.assign(group, summary, { share: measured ? 1 : null });
    data.topSessions = measured ? data.topSessions.map(group => ({ ...group, ...summary })) : [];
    data.warnings = mode === 'missing' ? ['有 1 次请求未返回可确认的用量。']
      : mode === 'collection-error' ? ['用量记录发生错误，当前仅显示已记录的用量。'] : [];
    return route.fulfill({ json: data });
  });
  await openUsage(page);
  const usage = page.locator('.usage-page');
  await expect(usage.locator('.usage-metric strong')).toHaveText(['0', '0', '0', '4']);
  await expect(usage).toContainText('缓存命中 —');
  await expect(usage).toContainText('日均 0 token');
  await expect(usage).toContainText('较上一周期 −100%');
  await expect(usage.locator('.usage-day-detail')).toContainText('输入 0 · 缓存命中 0 · 输出 0');
  await expect(usage.locator('.usage-day-detail')).toContainText('4 次已观测请求');
  for (const label of ['按模型', '按项目', '按来源']) {
    await page.getByRole('radio', { name: label, exact: true }).click();
    await expect(usage.locator('.usage-breakdown')).toContainText('0 · —');
    await expect(usage.locator('.usage-breakdown')).toContainText('4 次请求');
  }
  await expect(usage.getByText(/用量缺失|缺失用量|未返回可确认/)).toHaveCount(0);
  for (const next of ['mixed', 'completed'] as const) {
    mode = next;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(usage.locator('.usage-metric strong')).toHaveText(next === 'mixed' ? ['240', '200', '40', '5'] : ['480', '400', '80', '5']);
    await expect(usage.locator('.usage-day-detail')).toContainText(next === 'mixed' ? '输入 120 · 缓存命中 80 · 输出 40' : '输入 240 · 缓存命中 160 · 输出 80');
    await expect(usage.locator('.usage-session-amount')).toHaveText(next === 'mixed' ? '240' : '480');
    await expect(usage.getByText(/用量缺失|缺失用量|未返回可确认/)).toHaveCount(0);
  }
  mode = 'missing';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(usage.locator('.usage-metric strong')).toHaveText(['—', '—', '—', '4']);
  await expect(usage.locator('.usage-warning')).toContainText('有 1 次请求未返回可确认的用量。');
  await expect(usage.locator('.usage-day-detail')).toContainText('1 次用量缺失');
  await expect(usage.locator('.usage-breakdown')).toContainText('1 次用量缺失');
  await expect(usage.getByText(/日均|较上一周期/)).toHaveCount(0);
  mode = 'collection-error';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(usage.locator('.usage-metric strong')).toHaveText(['240', '200', '40', '4']);
  await expect(usage.locator('.usage-warning')).toContainText('用量记录发生错误');
  await expect(usage.getByText(/用量缺失|缺失用量|未返回可确认|日均|较上一周期/)).toHaveCount(0);
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


// 布局回归使用较完整的测试账本，核对大屏和侧栏展开后的真实可用空间。
function dashboardFixture(days: UsageDays): UsageStatistics {
  const data = fixture(days, true);
  data.daily = data.daily.map((day, index) => {
    const unit = ((index % 7) + 1) * 1000;
    return { ...day, input: unit * 3, cacheRead: unit * 2, output: unit, total: unit * 6,
      requests: 1, measuredRequests: 1, missingRequests: 0, cacheHitRate: .4 };
  });
  const summary = zero();
  for (const day of data.daily) for (const key of ['input', 'cacheRead', 'output', 'total', 'requests', 'measuredRequests'] as const) summary[key] += day[key];
  summary.cacheHitRate = .4;
  data.summary = summary; data.statisticsDays = days; data.dailyAverage = summary.total / days;
  const group = (key: string, label: string, share: number) => ({ ...summary, key, label, share,
    input: Math.round(summary.input * share), cacheRead: Math.round(summary.cacheRead * share),
    output: Math.round(summary.output * share), total: Math.round(summary.total * share),
    requests: Math.round(summary.requests * share), measuredRequests: Math.round(summary.requests * share) });
  data.distributions = {
    model: ['模型 A', '模型 B', '模型 C'].map((label, index) => group(`model-${index}`, label, [.5, .3, .2][index]!)),
    project: ['Multivac', '界面设计', '日常（无项目）'].map((label, index) => group(`project-${index}`, label, [.5, .3, .2][index]!)),
    source: ['Multivac 协调', '会话', '任务执行'].map((label, index) => group(`source-${index}`, label, [.5, .3, .2][index]!)),
  };
  data.topSessions = ['代码维护与问题排查', '统计页面设计', '阅读与资料整理', '服务端实现', '自动化回归'].map((label, index) => ({
    ...group(`session-${index}`, label, (5 - index) / 15), description: index === 2 ? '日常（无项目） · 会话' : 'Multivac · 任务执行',
  }));
  return data;
}

test('统计页在大屏铺满内容区，分布与排名并排；侧栏窄容器堆叠且不溢出', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  await page.route('**/api/usage?**', route => route.fulfill({ json: dashboardFixture(Number(new URL(route.request().url()).searchParams.get('days')) as UsageDays) }));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openUsage(page);
  const usage = page.locator('.usage-page');
  await expect(usage.locator('.usage-sessions li')).toHaveCount(5);
  const frame = page.locator('.management-page[data-page="usage"]');
  const body = frame.locator('.management-page-body');
  await expect(body).toHaveAttribute('data-width', 'full');
  const wide = (await usage.boundingBox())!;
  expect(wide.width).toBeGreaterThan(1500);
  expect(wide.width).toBeGreaterThan((await frame.boundingBox())!.width * .9);
  const distribution = usage.getByRole('region', { name: '用量分布', exact: true });
  const sessions = usage.getByRole('region', { name: '用量最多的会话', exact: true });
  const left = (await distribution.boundingBox())!, right = (await sessions.boundingBox())!;
  expect(left.y).toBeCloseTo(right.y, 0);
  expect(left.x + left.width).toBeLessThan(right.x);
  expect((await usage.locator('.usage-chart-bars').boundingBox())!.width).toBeGreaterThan(wide.width * .85);
  expect(await usage.evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('usage-wide-1920.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath('usage-desktop-1440.png') });
  await page.setViewportSize({ width: 1020, height: 1000 });
  await page.keyboard.press('Control+j');
  await expect(usage).toBeVisible();
  const metrics = usage.locator('.usage-metric');
  const first = (await metrics.nth(0).boundingBox())!, second = (await metrics.nth(1).boundingBox())!, third = (await metrics.nth(2).boundingBox())!;
  expect(first.y).toBeCloseTo(second.y, 0);
  expect(third.y).toBeGreaterThan(first.y);
  // 更窄的容器应按既有断点切为单列，侧栏加宽后仍不溢出。
  await page.setViewportSize({ width: 920, height: 1000 });
  const narrowFirst = (await metrics.nth(0).boundingBox())!, narrowSecond = (await metrics.nth(1).boundingBox())!;
  expect(narrowSecond.y).toBeGreaterThan(narrowFirst.y);
  const narrowLeft = (await distribution.boundingBox())!, narrowRight = (await sessions.boundingBox())!;
  expect(narrowRight.y).toBeGreaterThanOrEqual(narrowLeft.y + narrowLeft.height);
  expect(await usage.evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  await page.getByRole('radio', { name: '近 90 天', exact: true }).click();
  await expect(usage.locator('.usage-bar')).toHaveCount(90);
  expect(await usage.evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('usage-narrow-sidebar.png') });
});
