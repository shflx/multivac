import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { fakeApiRoot, resetE2eState, openPanel } from './test-state.js';

/** 保持会话流连通，但丢掉工作台变更：模拟没有触发重连补读的一次漏通知。 */
async function dropWorkbenchChanges(page: Page) {
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    let connected = false;
    Object.defineProperty(window, '__runsWorkbenchConnected', { get: () => connected });
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const input = args[0];
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname !== '/api/events' || !response.body) return response;
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let pending = '';
      return new Response(response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          pending += decoder.decode(chunk, { stream: true });
          let boundary: number;
          while ((boundary = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.slice(0, boundary + 2);
            pending = pending.slice(boundary + 2);
            if (frame.includes('"type":"workbench.connected"')) connected = true;
            if (!frame.includes('event: workbench-event') || frame.includes('"type":"workbench.connected"')) {
              controller.enqueue(encoder.encode(frame));
            }
          }
        },
      })), { status: response.status, headers: response.headers });
    };
  });
}

async function startTask(request: APIRequestContext) {
  const created = await request.post(`${fakeApiRoot}/api/tasks`, {
    data: { commandId: 'refresh-task', title: '漏通知时仍显示的任务', goal: '核对运行事实' },
  });
  expect(created.ok()).toBeTruthy();
  const task = (await created.json()).task;
  expect((await request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/control`, {
    data: { commandId: 'refresh-start', revision: task.revision, action: 'start' },
  })).ok()).toBeTruthy();
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).task.status).toBe('running');
  expect((await (await request.get(`${fakeApiRoot}/api/runs?activeOnly=true`)).json()).total).toBe(1);
  return task;
}

test('漏掉工作台推送时定期核对顶栏和运行页，暂停后移出活跃列表', async ({ page, request }) => {
  await resetE2eState(request);
  await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`);
  await dropWorkbenchChanges(page);
  await page.clock.install();
  await page.goto('/');
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '运行', exact: true }).click();
  const section = page.getByRole('region', { name: '任务会话', exact: true });
  await expect(page.getByRole('button', { name: /^空闲：/ })).toBeVisible();
  await expect(section.getByText('没有正在运行的任务会话。')).toBeVisible();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__runsWorkbenchConnected'))).toBe(true);
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 1000));
  const task = await startTask(request);
  try {
    await expect(section.locator('.run-row')).toHaveCount(0);
    await page.clock.fastForward(5500);
    await expect(section.getByRole('button', { name: task.title, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^运行中：.*1 个执行中/ })).toBeVisible();
    await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }));
    const current = (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).task;
    const pause = request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/control`, {
      data: { commandId: 'refresh-pause', revision: current.revision, action: 'pause' },
    });
    await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).runs[0].stopIntent).toBe('pause');
    await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`);
    expect((await pause).ok()).toBeTruthy();
    await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).task.status).toBe('paused');
    let reads = 0;
    page.on('request', (request) => { if (/\/api\/(runs|processes)\?/.test(request.url())) reads += 1; });
    await page.clock.fastForward(5500);
    expect(reads).toBe(0);
    await expect(section.locator('.run-row')).toHaveCount(1);
    await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }));
    await page.clock.fastForward(5500);
    await expect(section.locator('.run-row')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^空闲：/ })).toBeVisible();
  } finally {
    await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`);
  }
});

test('漏掉推送后进入运行页立即补读任务和进程，回到前台恢复顶栏', async ({ page, request }) => {
  await resetE2eState(request);
  await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`);
  await dropWorkbenchChanges(page);
  await page.clock.install();
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^空闲：/ })).toBeVisible();
  await openPanel(page, 'management');
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__runsWorkbenchConnected'))).toBe(true);
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 1000));
  const task = await startTask(request);
  try {
    const process = await request.post(`${fakeApiRoot}/api/__e2e/managed-process`, { data: { taskId: task.taskId, required: false } });
    expect(process.ok()).toBeTruthy();
    await expect(page.getByRole('button', { name: /^空闲：/ })).toBeVisible();
    await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '运行', exact: true }).click({ force: true });
    await expect(page.getByRole('region', { name: '任务会话', exact: true }).getByRole('button', { name: task.title, exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '后台进程', exact: true }).getByText('真实测试后台进程', { exact: true })).toBeVisible();
    await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`);
    await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).task.status).toBe('waiting');
    // 不推进定时器：前台恢复必须立即核对，而不是等下一个轮询周期。
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('region', { name: '任务会话', exact: true }).locator('.run-row')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^运行中：1 个进程$/ })).toBeVisible();
  } finally {
    await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`);
  }
});
