import { test, expect } from '@playwright/test';
import { fakeApiRoot, resetE2eState, openPanel } from './test-state.js';
test('键盘移动不能绕过完成，跨列取消真实执行，排序保持优先级', async ({ page, request }) => {
  await resetE2eState(request);
  const title = `键盘任务 ${Date.now()}`;
  const created = await (await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: `move-${Date.now()}`, title, goal: '验证键盘动作', priority: 'high' } })).json();
  await page.goto('/'); await openPanel(page, 'management');
  const card = page.getByRole('article', { name: `移动任务：${title}`, exact: true });
  await card.focus(); await page.keyboard.press('Space');
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('完成需要');
  expect((await (await request.get(`${fakeApiRoot}/api/tasks/${created.task.taskId}`)).json()).task.status).toBe('idle');
  await card.focus(); await page.keyboard.press('Space'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Enter');
  await expect(page.locator('[data-column="cancelled"]')).toContainText(title);
  const current = (await (await request.get(`${fakeApiRoot}/api/tasks/${created.task.taskId}`)).json()).task;
  expect(current.status).toBe('cancelled'); expect(current.priority).toBe('high');
});
