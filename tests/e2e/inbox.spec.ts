import { expect, test } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';

test('Inbox 抽屉共享持久草稿、查看计数、原位回执与窄屏焦点', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  const taskResponse = await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: 'inbox-create', title: '来源核对', goal: '核对资料' } });
  expect(taskResponse.ok()).toBeTruthy();
  const { task } = await taskResponse.json();
  const ask = await request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/requests`, { data: { commandId: 'inbox-ask', question: '采用哪份资料？' } });
  expect(ask.ok()).toBeTruthy();
  const { request: human } = await ask.json();
  const fresh = await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json();
  await request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/control`, { data: { commandId: 'inbox-pause', revision: fresh.task.revision, action: 'pause' } });
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Inbox，1 项待处理', exact: true });
  await expect(trigger).toBeVisible(); await trigger.click();
  const drawer = page.getByRole('dialog', { name: 'Inbox', exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('img', { name: '未查看', exact: true })).toHaveCount(1);
  await drawer.locator('.inbox-item').click();
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/inbox/${human.requestId}`)).json()).item.state.seen).toBe(true);
  await expect(trigger).toHaveText(/1/);
  await drawer.getByRole('textbox', { name: '澄清回应' }).fill('仅采用已授权项目资料');
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/inbox/${human.requestId}`)).json()).item.state.draft).toBe('仅采用已授权项目资料');
  await page.screenshot({ path: testInfo.outputPath('inbox-desktop.png') });
  await page.keyboard.press('Escape'); await expect(drawer).not.toBeVisible(); await expect(trigger).toBeFocused();
  await page.reload(); await trigger.click(); await drawer.locator('.inbox-item').click();
  await expect(drawer.getByRole('textbox', { name: '澄清回应' })).toHaveValue('仅采用已授权项目资料');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('inbox-narrow.png') });
  for (let index = 0; index < 12; index++) { await page.keyboard.press('Tab'); expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(true); }
  await drawer.getByRole('button', { name: '提交回应', exact: true }).click();
  await expect(drawer).toContainText('回应已保存');
  await expect(page.getByRole('button', { name: 'Inbox，0 项待处理', exact: true })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: '采用哪份资料？', exact: true })).toBeVisible();
  const updated = await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json();
  expect(updated.task.pauseSource).toBe('user'); expect(updated.task.currentRunId).toBe(null);
});
