import { test, expect, type Page, type TestInfo } from '@playwright/test';
import type { ProcessList, ProcessListItem, RunSnapshot, RunsSnapshot } from '@multivac/contracts';
import { resetE2eState } from './test-state.js';

const process: ProcessListItem = {
  processId: 'indicator-process', sessionId: 'indicator-session', taskId: null, runId: null, revision: 1,
  name: '短暂前台命令', command: 'node script.js', mode: 'foreground', state: 'running', requiredWhileRunning: false,
  startedAt: null, endedAt: null, port: null, exitCode: null, reason: '', taskTitle: null, taskAvailable: false, taskRunning: false,
  sessionTitle: '开发会话', sessionAvailable: true,
};
const active: ProcessList = { processes: [process], total: 1, nextOffset: null };
const empty: ProcessList = { processes: [], total: 0, nextOffset: null };
const runs: RunsSnapshot = { version: 1, observedAt: '', items: [], highlights: [], total: 0, nextOffset: null,
  counts: { running: 0, queued: 0, anomalies: 0, waiting: 0, processesRunning: 1 } };
const taskRun: RunSnapshot = {
  taskId: 'indicator-task', runId: 'indicator-run', sessionId: 'indicator-session', title: '正在执行的任务', revision: 1,
  state: 'running', anomaly: false, reason: '正在执行工具', nextStep: '', startedAt: null, endedAt: null,
  elapsedMs: null, lastTool: null, lastToolAt: null, canPause: true, taskAvailable: true, sessionAvailable: true,
};
type Path = '/api/runs' | '/api/processes';

/** 控制两路状态查询并沿现有 SSE 流注入工作台变更，其余 API 使用正常 E2E 环境。 */
async function installStatusControl(page: Page, held: Path[] = []) {
  await page.addInitScript(({ runs, empty, held }) => {
    const original = window.fetch;
    const values: Record<string, unknown> = { '/api/runs': runs, '/api/processes': empty };
    const holding = new Set<string>(held), failures = new Set<string>();
    const pending = new Map<string, ((response: Response) => void)[]>();
    let events: TransformStreamDefaultController<Uint8Array> | undefined;
    let seq = 1000;
    const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    Reflect.set(window, '__indicatorControl', {
      set(path: string, value: unknown) { values[path] = value; },
      hold(path: string) { holding.add(path); },
      fail(path: string) { failures.add(path); },
      allow(path: string) { holding.delete(path); failures.delete(path); },
      pending(path: string) { return pending.get(path)?.length ?? 0; },
      eventsReady() { return !!events; },
      processChanged() {
        if (!events) throw Error('全局事件流尚未连接');
        const event = { type: 'process.changed', seq: ++seq, origin: { windowId: null, commandId: null } };
        events.enqueue(new TextEncoder().encode(`event: workbench-event\ndata: ${JSON.stringify(event)}\n\n`));
      },
      release(path: string, body: unknown) {
        holding.delete(path);
        for (const resolve of pending.get(path) ?? []) resolve(response(body));
        pending.delete(path);
      },
    });
    window.fetch = (...args) => {
      const input = args[0];
      const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
      // 通过真实 SSE 解析及工作台订阅链注入变更，不调用组件内部方法。
      if (path === '/api/events') return original(...args).then(response => {
        if (!response.ok || !response.body) return response;
        const stream = new TransformStream<Uint8Array, Uint8Array>({ start(controller) { events = controller; } });
        return new Response(response.body.pipeThrough(stream), { headers: response.headers, status: response.status });
      });
      if (!(path in values)) return original(...args);
      if (holding.has(path)) return new Promise<Response>(resolve => {
        const reads = pending.get(path) ?? []; reads.push(resolve); pending.set(path, reads);
      });
      if (failures.has(path)) return Promise.reject(new TypeError('状态刷新失败'));
      return Promise.resolve(response(values[path]));
    };
  }, { runs, empty, held });
  await page.clock.install();
}
async function control(page: Page, method: string, path: Path, value?: unknown) {
  return page.evaluate(({ method, path, value }) => Reflect.get(window, '__indicatorControl')[method](path, value), { method, path, value });
}
async function open(page: Page) {
  await page.locator('.run-indicator').click();
  const popover = page.getByRole('dialog', { name: '运行状态', exact: true });
  await expect(popover).toBeVisible();
  return popover;
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('runs 计数为 1、进程首次读取延迟，先显示读取提示，再显示同快照列表和数量', async ({ page, request }, info) => {
  await resetE2eState(request); await installStatusControl(page, ['/api/processes']);
  await page.goto('/');
  const popover = await open(page);
  await expect(popover.getByRole('status')).toContainText('正在读取进程明细');
  await expect(popover).not.toContainText('1 个进程');
  await expect(popover).not.toContainText('没有运行中的任务会话或进程。');
  await screenshot(page, info, 'initial-loading');
  await control(page, 'set', '/api/processes', active);
  await control(page, 'release', '/api/processes', active);
  await expect(popover.getByRole('heading', { name: '进程（1）' })).toBeVisible();
  await expect(popover).toContainText('1 个进程');
  await expect(popover).toContainText('短暂前台命令');
});

test('明细先返回空列表、runs 后返回旧计数，短命进程出现并退出后恢复准确空闲', async ({ page, request }, info) => {
  await resetE2eState(request); await installStatusControl(page, ['/api/runs']);
  await page.goto('/');
  const popover = await open(page);
  await expect(popover.getByRole('status')).toContainText('正在读取任务运行状态');
  await expect(popover).toContainText('没有活跃进程');
  await control(page, 'release', '/api/runs', runs);
  await expect(popover.locator('header strong')).toHaveText('空闲');
  await expect(popover).not.toContainText('1 个进程');
  await control(page, 'set', '/api/processes', active);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(popover).toContainText('短暂前台命令');
  await control(page, 'set', '/api/processes', empty);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(popover.locator('header strong')).toHaveText('空闲');
  await expect(popover).not.toContainText('短暂前台命令');
  await expect(popover).not.toContainText('1 个进程');
  await screenshot(page, info, 'exited-empty');
});

test('刷新失败保留已有列表和旧结果标记，恢复后迟到响应不能覆盖新状态', async ({ page, request }, info) => {
  await resetE2eState(request); await installStatusControl(page);
  await page.goto('/');
  await control(page, 'set', '/api/processes', active);
  const popover = await open(page);
  await expect(popover).toContainText('短暂前台命令');
  await control(page, 'fail', '/api/processes');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(popover.getByRole('alert')).toContainText('上次确认结果');
  await expect(popover).toContainText('短暂前台命令');
  await screenshot(page, info, 'refresh-error');
  await control(page, 'allow', '/api/processes');
  await control(page, 'hold', '/api/processes');
  await popover.getByRole('button', { name: '重试进程状态' }).click();
  await expect.poll(() => control(page, 'pending', '/api/processes')).toBeGreaterThan(0);
  await expect(popover).toContainText('正在核对进程状态');
  await control(page, 'allow', '/api/processes');
  await control(page, 'set', '/api/processes', empty);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(popover.locator('header strong')).toHaveText('空闲');
  await control(page, 'release', '/api/processes', active);
  await expect(popover).not.toContainText('短暂前台命令');
  await expect(popover.getByRole('alert')).toHaveCount(0);
});

for (const source of ['/api/runs', '/api/processes'] as const) {
  test(`${source} 超时后明确待核对，重试保留错误且迟到结果不覆盖恢复`, async ({ page, request }) => {
    await resetE2eState(request); await installStatusControl(page);
    await page.goto('/');
    await expect(page.locator('.run-indicator')).toHaveAccessibleName(/^空闲：/);
    await control(page, 'hold', source);
    const popover = await open(page);
    await expect(popover).toHaveAttribute('aria-busy', 'true');
    await expect(popover.locator('header strong')).toHaveText('空闲');
    await expect(popover).toContainText('没有运行中的任务会话或进程。');
    await expect(popover.getByRole('status')).toHaveCount(0);
    await page.clock.fastForward(11_000);
    await expect(popover.getByRole('alert')).toContainText('超时');
    await expect(popover.locator('header strong')).toHaveText('状态待核对');
    await expect(popover).not.toContainText('没有运行中的任务会话或进程。');
    const retryName = source === '/api/runs' ? '重试任务状态' : '重试进程状态';
    await popover.getByRole('button', { name: retryName }).click();
    await expect(popover).toHaveAttribute('aria-busy', 'true');
    await expect(popover.getByRole('alert')).toContainText('超时');
    await expect(popover.locator('header strong')).toHaveText('状态待核对');
    await control(page, 'allow', source);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(popover.locator('header strong')).toHaveText('空闲');
    await expect(popover.getByRole('alert')).toHaveCount(0);
    await control(page, 'release', source, source === '/api/runs'
      ? { ...runs, counts: { ...runs.counts, running: 1 } } : active);
    await expect(popover.locator('header strong')).toHaveText('空闲');
    await expect(popover).not.toContainText('短暂前台命令');
  });
}

/** 保存可审查的坐标、尺寸、颜色、计数及明细；不把静态 DOM 结果当作浏览器尺寸。 */
async function geometry(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector)!;
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const button = document.querySelector('.run-indicator')!;
    const popover = document.querySelector('.run-popover')!;
    return {
      button: rect('.run-indicator'), neighbor: rect('.shell-inbox'), popover: rect('.run-popover'),
      label: button.textContent, summary: button.getAttribute('aria-label'),
      color: getComputedStyle(document.querySelector('.run-indicator-dot')!).backgroundColor,
      content: popover.textContent,
    };
  });
}

for (const mode of ['active', 'task', 'idle', 'recovery'] as const) {
  test(`${mode} 同快照两轮定时刷新、工作台事件和打开弹层均保持布局`, async ({ page, request }, info) => {
    await resetE2eState(request); await installStatusControl(page);
    await page.goto('/');
    const processList = mode === 'active' ? active : empty;
    await control(page, 'set', '/api/processes', processList);
    const runSnapshot = {
      ...runs, highlights: mode === 'task' ? [taskRun] : [], total: mode === 'task' ? 1 : 0,
      counts: { ...runs.counts, running: mode === 'task' ? 1 : 0, processesRecovery: mode === 'recovery' ? 1 : 0 },
    };
    await control(page, 'set', '/api/runs', runSnapshot);
    const popover = await open(page);
    await expect(popover).toHaveAttribute('aria-busy', 'false');
    // 两次浏览器调用之间时钟仍在前进，使用稍后的时刻避免暂停目标落在过去。
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 1000));
    const baseline = await geometry(page);
    const samples: { stage: string; measurement: Awaited<ReturnType<typeof geometry>> }[] = [];
    async function stable(stage: string) {
      const measurement = await geometry(page);
      samples.push({ stage, measurement });
      expect(measurement).toEqual(baseline);
    }
    async function hold() {
      await control(page, 'hold', '/api/runs');
      await control(page, 'hold', '/api/processes');
    }
    async function checkRefresh(stage: string) {
      await expect.poll(() => control(page, 'pending', '/api/runs')).toBeGreaterThan(0);
      await expect.poll(() => control(page, 'pending', '/api/processes')).toBeGreaterThan(0);
      await expect(popover).toHaveAttribute('aria-busy', 'true');
      await stable(`${stage}:both-pending`);
      await control(page, 'release', '/api/runs', runSnapshot);
      await stable(`${stage}:process-pending`);
      await control(page, 'release', '/api/processes', processList);
      await expect(popover).toHaveAttribute('aria-busy', 'false');
      await stable(`${stage}:settled`);
    }
    for (let round = 1; round <= 2; round++) {
      await hold();
      await page.clock.runFor(5000);
      await checkRefresh(`poll-${round}`);
    }
    await expect.poll(() => control(page, 'eventsReady', '/api/processes')).toBe(true);
    await hold();
    await control(page, 'processChanged', '/api/processes');
    await checkRefresh('workbench-event');
    await page.keyboard.press('Escape');
    await hold();
    await open(page);
    await checkRefresh('reopen');
    if (mode === 'active') await expect(popover).toContainText(process.name);
    if (mode === 'task') await expect(popover).toContainText(taskRun.title);
    if (mode === 'idle') await expect(popover).toContainText('没有运行中的任务会话或进程。');
    if (mode === 'recovery') await expect(popover.getByRole('status')).toContainText('停止状态尚未确认');
    await info.attach('refresh-dimensions', { body: JSON.stringify({ baseline, samples }, null, 2), contentType: 'application/json' });
    await screenshot(page, info, `${mode}-stable`);
  });
}

for (const source of ['/api/runs', '/api/processes'] as const) {
  test(`${source} 单路失败及重试保留错误，成功后更新真实运行`, async ({ page, request }, info) => {
    await resetE2eState(request); await installStatusControl(page);
    await page.goto('/');
    await control(page, 'set', '/api/processes', active);
    const popover = await open(page);
    await expect(popover).toHaveAttribute('aria-busy', 'false');
    await control(page, 'fail', source);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(popover.locator('header strong')).toHaveText('状态待核对');
    await expect(popover.getByRole('alert')).toContainText('上次确认结果');
    await expect(popover).toContainText(process.name);
    await control(page, 'allow', source); await control(page, 'hold', source);
    const retryName = source === '/api/runs' ? '重试任务状态' : '重试进程状态';
    await popover.getByRole('button', { name: retryName }).click();
    await expect.poll(() => control(page, 'pending', source)).toBeGreaterThan(0);
    await expect(popover.getByRole('alert')).toContainText('上次确认结果');
    await expect(popover.locator('header strong')).toHaveText('状态待核对');
    await expect(popover.getByRole('status')).toContainText('正在核对');
    await screenshot(page, info, source === '/api/runs' ? 'task-retry-error-retained' : 'process-retry-error-retained');
    await control(page, 'release', source, source === '/api/runs' ? runs : active);
    await expect(popover.getByRole('alert')).toHaveCount(0);
    await expect(popover.locator('header strong')).toHaveText('运行中');
    await control(page, 'set', '/api/processes', empty);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(popover.locator('header strong')).toHaveText('空闲');
    await expect(popover).not.toContainText(process.name);
  });
}

test('最窄桌面视口长标题与错误可达，移动视口沿用隐藏入口规则', async ({ page, request }, info) => {
  await page.setViewportSize({ width: 761, height: 700 });
  await resetE2eState(request); await installStatusControl(page);
  await page.goto('/');
  const longName = '长进程标题与路径'.repeat(20);
  await control(page, 'set', '/api/processes', { ...active, processes: [{ ...process, name: longName, sessionTitle: longName }] });
  const popover = await open(page);
  await expect(popover).toHaveAttribute('aria-busy', 'false');
  await expect(popover.locator('.run-popover-text strong')).toHaveAttribute('title', longName);
  const measurement = await geometry(page);
  expect(measurement.popover.x).toBeGreaterThanOrEqual(0);
  expect(measurement.popover.x + measurement.popover.width).toBeLessThanOrEqual(761);
  expect(await popover.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await control(page, 'fail', '/api/processes');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(popover.getByRole('button', { name: '重试进程状态' })).toBeVisible();
  expect(await popover.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await info.attach('narrow-dimensions', { body: JSON.stringify(measurement, null, 2), contentType: 'application/json' });
  await screenshot(page, info, 'narrow-long-title');
  await page.setViewportSize({ width: 390, height: 700 });
  await expect(page.locator('.run-indicator')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
