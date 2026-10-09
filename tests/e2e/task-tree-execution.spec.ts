import { test, expect } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

test('父任务一次启动固定子任务范围，子项跳转到统一执行且不能重复启动', async ({ page, request }) => {
  await resetE2eState(request);
  const create = async (title: string, fields = {}) => {
    const response = await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: crypto.randomUUID(), title, goal: title, ...fields } });
    expect(response.ok()).toBeTruthy(); return (await response.json()).task;
  };
  const before = await create('等待外部准备');
  const parent = await create('统一执行远程访问', { dependencyIds: [before.taskId] });
  const child = await create('实现访问 token', { parentTaskId: parent.taskId });
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
  await page.getByRole('button', { name: `查看任务：${parent.title}`, exact: true }).click();
  const inspector = page.getByRole('complementary', { name: '任务详情' });
  await inspector.getByRole('button', { name: `启动任务：${parent.title}`, exact: true }).click();
  await expect(inspector.getByRole('region', { name: '任务树执行' })).toContainText('本次固定范围 1 项');
  await page.getByRole('button', { name: `查看任务：${child.title}`, exact: true }).click();
  await expect(inspector).toContainText('没有独立子任务运行');
  await expect(inspector.getByRole('button', { name: `启动任务：${child.title}`, exact: true })).toHaveCount(0);
  const detail = await (await request.get(`${fakeApiRoot}/api/tasks/${child.taskId}`)).json();
  expect(detail.runs).toHaveLength(0);
  const conflict = await request.post(`${fakeApiRoot}/api/tasks/${child.taskId}/control`, { data: { commandId: crypto.randomUUID(), revision: detail.task.revision, action: 'start' } });
  expect(conflict.status()).toBe(409);
  await inspector.getByRole('button', { name: `查看父任务执行：${child.title}`, exact: true }).click();
  await expect(inspector.getByRole('heading', { name: parent.title, exact: true })).toBeVisible();
  const current = (await (await request.get(`${fakeApiRoot}/api/tasks/${parent.taskId}`)).json()).task;
  expect((await request.post(`${fakeApiRoot}/api/tasks/${parent.taskId}/control`, { data: { commandId: crypto.randomUUID(), revision: current.revision, action: 'cancel' } })).ok()).toBeTruthy();
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${child.taskId}`)).json()).task.status).toBe('paused');
});
