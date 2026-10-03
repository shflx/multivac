import { test, expect } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

test('列表详情不等待网络，保留筛选，快速切换与关闭不受迟到响应影响，失败可重试', async ({ page, request }) => {
  await resetE2eState(request);
  const create = async (title: string) => (await (await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: crypto.randomUUID(), title, goal: title } })).json()).task;
  const a = await create('慢接口任务 A'); const b = await create('慢接口任务 B'); const c = await create('慢接口任务 C');
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
  await page.getByRole('button', { name: '任务列表', exact: true }).click();
  const search = page.getByRole('textbox', { name: '搜索任务', exact: true });
  await search.fill('慢接口任务');
  await expect(page.locator('.task-list-row')).toHaveCount(3);
  let releaseA!: () => void; let releaseB!: () => void;
  const gates = new Map([[a.taskId, new Promise<void>((resolve) => { releaseA = resolve; })], [b.taskId, new Promise<void>((resolve) => { releaseB = resolve; })]]);
  const counts = new Map<string, number>();
  let mainQueries = 0;
  page.on('request', (req) => { const url = new URL(req.url()); if (url.pathname === '/api/tasks' && url.searchParams.get('sort') === 'recent') mainQueries++; });
  await page.route(/\/api\/tasks\/[^/?]+$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop()!;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (id === c.taskId && counts.get(id) === 1) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '详情暂不可用' } }) });
      return;
    }
    const response = await route.fetch();
    await gates.get(id);
    await route.fulfill({ response });
  });
  const inspector = page.getByRole('complementary', { name: '任务详情' });
  const open = async (title: string) => page.getByRole('button', { name: `查看任务：${title}`, exact: true }).click();
  try {
    await open(a.title);
    // 请求仍被门闩阻塞，面板和已知任务身份必须已经可见。
    await expect(inspector.getByRole('heading', { name: a.title, exact: true })).toBeVisible({ timeout: 1500 });
    await expect(inspector.getByText('正在读取任务详情…', { exact: true })).toBeVisible();
    await expect(search).toHaveValue('慢接口任务');
    await open(b.title);
    await expect(inspector.getByRole('heading', { name: b.title, exact: true })).toBeVisible({ timeout: 1500 });
    const receivedA = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/tasks/${a.taskId}`);
    releaseA(); await receivedA;
    await expect(inspector.getByRole('heading', { name: b.title, exact: true })).toBeVisible();
    await expect(inspector.getByText('正在读取任务详情…', { exact: true })).toBeVisible();
    await inspector.getByRole('button', { name: '关闭任务详情', exact: true }).click();
    const receivedB = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/tasks/${b.taskId}`);
    releaseB(); await receivedB;
    await expect(inspector).toHaveCount(0);
    expect(counts.get(a.taskId)).toBe(1); expect(counts.get(b.taskId)).toBe(1);
    expect(mainQueries).toBe(0);
    await open(c.title);
    await expect(inspector.getByRole('heading', { name: c.title, exact: true })).toBeVisible();
    await expect(inspector.getByRole('alert')).toContainText('详情暂不可用');
    await inspector.getByRole('button', { name: '重试任务详情', exact: true }).click();
    await expect(inspector.getByRole('heading', { name: '最近进展', exact: true })).toBeVisible();
    await expect(search).toHaveValue('慢接口任务');
  } finally { releaseA(); releaseB(); }
});
