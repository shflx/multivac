import { test, expect, type Page, type TestInfo } from '@playwright/test';
import type { ProcessList, ProcessListItem, RunsSnapshot } from '@multivac/contracts';
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
type Path = '/api/runs' | '/api/processes';

/** 只控制两路状态查询；真实浏览器、应用组件和其余 API 使用正常 E2E 环境。 */
async function installStatusControl(page: Page, held: Path[] = []) {
  await page.addInitScript(({ runs, empty, held }) => {
    const original = window.fetch;
    const values: Record<string, unknown> = { '/api/runs': runs, '/api/processes': empty };
    const holding = new Set<string>(held), failures = new Set<string>();
    const pending = new Map<string, ((response: Response) => void)[]>();
    const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    Reflect.set(window, '__indicatorControl', {
      set(path: string, value: unknown) { values[path] = value; },
      hold(path: string) { holding.add(path); },
      fail(path: string) { failures.add(path); },
      allow(path: string) { holding.delete(path); failures.delete(path); },
      pending(path: string) { return pending.get(path)?.length ?? 0; },
      release(path: string, body: unknown) {
        holding.delete(path);
        for (const resolve of pending.get(path) ?? []) resolve(response(body));
        pending.delete(path);
      },
    });
    window.fetch = (...args) => {
      const input = args[0];
      const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
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

test('进程请求超时后明确待核对，保留空快照并允许恢复', async ({ page, request }) => {
  await resetE2eState(request); await installStatusControl(page);
  await page.goto('/');
  await expect(page.locator('.run-indicator')).toHaveAccessibleName(/^空闲：/);
  await control(page, 'hold', '/api/processes');
  const popover = await open(page);
  await expect(popover).toContainText('正在核对进程状态');
  await page.clock.fastForward(11_000);
  await expect(popover.getByRole('alert')).toContainText('超时');
  await expect(popover.locator('header strong')).toHaveText('状态待核对');
  await expect(popover).not.toContainText('没有运行中的任务会话或进程。');
  await control(page, 'allow', '/api/processes');
  await popover.getByRole('button', { name: '重试进程状态' }).click();
  await expect(popover.locator('header strong')).toHaveText('空闲');
  await control(page, 'release', '/api/processes', active);
  await expect(popover).not.toContainText('短暂前台命令');
});
