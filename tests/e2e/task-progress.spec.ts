import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Task } from '@multivac/contracts';
import { fakeApiRoot, resetE2eState, openPanel } from './test-state.js';

async function create(request: APIRequestContext, title: string, fields: object = {}): Promise<Task> {
  const result = await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: crypto.randomUUID(), title, goal: title, ...fields } });
  expect(result.ok()).toBeTruthy(); return (await result.json()).task;
}
async function openTasks(page: Page, query: string) {
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill(query);
}

test('多窗口的看板和筛选外展开卡片实时更新增删、完成与改父，断线后补齐进度', async ({ page, context, request }) => {
  await resetE2eState(request);
  const root = await create(request, '进度总目标');
  const branch = await create(request, '上下文父目标', { parentTaskId: root.taskId });
  const destination = await create(request, '迁入父目标', { parentTaskId: root.taskId });
  const child = await create(request, '可迁移子项', { parentTaskId: branch.taskId, humanOnly: true });
  await openTasks(page, root.title);
  await page.getByRole('button', { name: '任务列表', exact: true }).click();
  await page.getByRole('button', { name: `展开子任务：${root.title}`, exact: true }).click();
  const branchRow = page.locator('.task-list-row').filter({ has: page.getByRole('button', { name: `查看任务：${branch.title}`, exact: true }) });
  const destinationRow = page.locator('.task-list-row').filter({ has: page.getByRole('button', { name: `查看任务：${destination.title}`, exact: true }) });
  await expect(branchRow).toContainText('子任务已完成 0 / 1');
  const other = await context.newPage();
  try {
    await openTasks(other, branch.title);
    const card = other.locator(`[data-task-id="${branch.taskId}"]`);
    await expect(card).toContainText('子任务已完成 0 / 1');
    const additional = await create(request, '可完成子项', { parentTaskId: branch.taskId, humanOnly: true });
    await expect(branchRow).toContainText('子任务已完成 0 / 2');
    await expect(card).toContainText('子任务已完成 0 / 2');
    const moved = await request.patch(`${fakeApiRoot}/api/tasks/${child.taskId}`, { data: { commandId: crypto.randomUUID(), revision: child.revision, patch: { parentTaskId: destination.taskId } } });
    expect(moved.ok()).toBeTruthy();
    await expect(branchRow).toContainText('子任务已完成 0 / 1');
    await expect(destinationRow).toContainText('子任务已完成 0 / 1');
    await expect(card).toContainText('子任务已完成 0 / 1');
    const completed = await request.post(`${fakeApiRoot}/api/tasks/${additional.taskId}/confirm-completion`, { data: { commandId: crypto.randomUUID(), revision: additional.revision } });
    expect(completed.ok()).toBeTruthy(); const done = (await completed.json()).task as Task;
    await expect(branchRow).toContainText('子任务已完成 1 / 1');
    await expect(card).toContainText('子任务已完成 1 / 1');
    const removed = await request.delete(`${fakeApiRoot}/api/tasks/${done.taskId}`, { data: { commandId: crypto.randomUUID(), revision: done.revision } });
    expect(removed.ok()).toBeTruthy();
    await expect(branchRow.getByText(/子任务已完成/)).toHaveCount(0);
    await expect(card.getByText(/子任务已完成/)).toHaveCount(0);
    await context.setOffline(true);
    const detached = await request.patch(`${fakeApiRoot}/api/tasks/${child.taskId}`, { data: { commandId: crypto.randomUUID(), revision: (await moved.json()).task.revision, patch: { parentTaskId: null } } });
    expect(detached.ok()).toBeTruthy();
    await context.setOffline(false);
    await expect(destinationRow.getByText(/子任务已完成/)).toHaveCount(0);
    const facts = await (await request.get(`${fakeApiRoot}/api/tasks/${destination.taskId}/relations`)).json();
    expect(facts.summary.children).toEqual({ total: 0, done: 0, cancelled: 0 });
    await expect(page.getByLabel('任务数量')).toHaveText('当前显示 1 / 1 个任务');
  } finally { await context.setOffline(false); await other.close(); }
});
