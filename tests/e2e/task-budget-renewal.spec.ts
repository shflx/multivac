import { expect, test } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

test('额度耗尽显示具体原因，点击继续直接补充共享额度并开始新一轮执行', async ({ page, request }) => {
  await resetE2eState(request);
  const created = await request.post(`${fakeApiRoot}/api/tasks`, { data: {
    commandId: crypto.randomUUID(), title: '继续已有预算任务', goal: '核对已有工作',
    budget: { maxRuns: 1, maxMillis: 900000, maxOutputBytes: 4096 },
  } });
  expect(created.ok()).toBeTruthy();
  const root = (await created.json()).task;
  const child = (await (await request.post(`${fakeApiRoot}/api/tasks`, { data: {
    commandId: crypto.randomUUID(), title: '使用共享次数', goal: '核对', parentTaskId: root.taskId,
  } })).json()).task;
  expect((await request.post(`${fakeApiRoot}/api/tasks/${child.taskId}/control`, { data: { commandId: crypto.randomUUID(), revision: child.revision, action: 'start' } })).ok()).toBeTruthy();
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${child.taskId}`)).json()).runs[0]?.stopConfirmed).toBe(true);
  const originalChild = (await (await request.get(`${fakeApiRoot}/api/tasks/${child.taskId}`)).json()).runs[0];
  expect((await request.post(`${fakeApiRoot}/api/tasks/${root.taskId}/control`, { data: { commandId: crypto.randomUUID(), revision: root.revision, action: 'start' } })).ok()).toBeTruthy();
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${root.taskId}`)).json()).task.status).toBe('paused');

  await page.goto('/');
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
  await page.getByRole('button', { name: `查看任务：${root.title}`, exact: true }).click();
  const inspector = page.getByRole('complementary', { name: '任务详情' });
  await expect(inspector.getByRole('region', { name: '当前情况' })).toContainText('执行次数已用完（已用 1 次，上限 1 次）');
  await expect(inspector).toContainText('点击“继续任务”可补充额度并继续');
  await expect(inspector.locator('.task-resume-hint')).toContainText('按当前偏好补充执行额度');
  await inspector.getByRole('button', { name: `继续任务：${root.title}`, exact: true }).click();
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${root.taskId}`)).json()).runs[0]?.stopConfirmed).toBe(true);
  const resumed = (await (await request.get(`${fakeApiRoot}/api/tasks/${root.taskId}`)).json());
  expect(resumed.runs[0].hasStarted).toBe(true);
  expect(resumed.runs[0].budgetRenewal.limit).toEqual({ maxRuns: 20, maxMillis: 21600000, maxOutputBytes: 16777216 });
  expect(resumed.task.status).toBe('waiting');
  await expect(inspector).toContainText('本轮执行已结束');
  await page.reload();
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
  await page.getByRole('button', { name: `查看任务：${root.title}`, exact: true }).click();
  await expect(page.getByRole('complementary', { name: '任务详情' })).toContainText('本轮执行已结束');
  const savedChild = (await (await request.get(`${fakeApiRoot}/api/tasks/${child.taskId}`)).json()).runs[0];
  expect(savedChild).toEqual(originalChild);
});
