import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';

interface HarnessView {
  key: string;
  sessionId: string;
  variant: 'page' | 'sidebar';
}

async function setViews(page: Page, views: HarnessView[]): Promise<void> {
  await page.evaluate((next) => {
    (window as Window & { __setViews: (views: unknown[]) => void }).__setViews(next);
  }, views);
}

test.beforeEach(async ({ request }) => {
  await resetE2eState(request);
});

test('多个会话同时打开时每个会话只有一条事件订阅，最后一个呈现实例离开后释放', async ({ page, request }) => {
  const sessionId = `multi-${Date.now()}`;
  const created = await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: '多实例会话' } });
  expect(created.ok()).toBe(true);

  const subscriptions = new Map<string, number>();
  page.on('request', (event) => {
    const path = new URL(event.url()).pathname;
    if (path.endsWith('/events')) subscriptions.set(path, (subscriptions.get(path) ?? 0) + 1);
  });

  await page.goto('/multi-session-harness.html');
  await page.waitForFunction(() => '__setViews' in window);
  await setViews(page, [
    { key: 'global', sessionId: 'global-coordinator', variant: 'page' },
    { key: 'work-page', sessionId, variant: 'page' },
    { key: 'work-sidebar', sessionId, variant: 'sidebar' },
  ]);

  const workPage = page.locator('[data-view="work-page"]');
  const workSidebar = page.locator('[data-view="work-sidebar"]');
  const globalView = page.locator('[data-view="global"]');
  await expect(workPage.getByLabel('Multivac 草稿')).toBeEditable();
  await expect(workSidebar.getByLabel('Multivac 草稿')).toBeEditable();
  await expect(globalView.getByLabel('Multivac 草稿')).toBeEditable();

  // 同一会话的两个呈现实例共享同一份草稿；与全局会话互不影响。
  await workPage.getByLabel('Multivac 草稿').fill('工作会话里的草稿');
  await expect(workSidebar.getByLabel('Multivac 草稿')).toHaveValue('工作会话里的草稿');
  await expect(globalView.getByLabel('Multivac 草稿')).toHaveValue('');
  await expect(workPage.locator('article.chat-row')).toHaveCount(0);

  // 在工作会话发送消息：两个呈现实例同时看到，全局会话不受影响。
  await workPage.getByLabel('发送消息').click();
  await expect(workSidebar.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(workSidebar.locator('article.chat-row.user').filter({ hasText: '工作会话里的草稿' })).toHaveCount(1);
  await expect(globalView.locator('article.chat-row.user').filter({ hasText: '工作会话里的草稿' })).toHaveCount(0);
  expect(await page.evaluate((id) => sessionStorage.getItem(`multivac.assistant.command-generation:${id}`), sessionId))
    .not.toBeNull();

  expect(subscriptions.get(`/api/sessions/${sessionId}/events`)).toBe(1);
  expect(subscriptions.get('/api/assistant/events')).toBe(1);

  // 卸载该会话的全部呈现实例后释放其订阅；全局会话常驻。
  const released = page.waitForEvent('requestfailed', (event) =>
    new URL(event.url()).pathname === `/api/sessions/${sessionId}/events`);
  await setViews(page, [{ key: 'global', sessionId: 'global-coordinator', variant: 'page' }]);
  await released;
  await setViews(page, []);
  await page.waitForTimeout(300);
  expect(subscriptions.get('/api/assistant/events')).toBe(1);
});
