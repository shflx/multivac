import { test, expect } from '@playwright/test';
import { fakeApiRoot, resetE2eState, openPanel } from './test-state.js';
test('Multivac 直接创建任务无需确认，管理工具按真实版本修改并返回任务引用', async ({ page, request }) => {
  await resetE2eState(request);
  await page.goto('/');
  const title = `直接创建任务 ${Date.now()}`;
  const composer = page.locator('.work-surface').first().getByLabel('Multivac 草稿');
  await composer.fill(`内部工具：create_task#create-${Date.now()} ${JSON.stringify({ title, goal: '核对真实任务查询与管理', scope: '仅任务独立目录', acceptance: true })}`);
  await composer.press('Enter');
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks?query=${encodeURIComponent(title)}`)).json()).total).toBe(1);
  await expect(page.locator('.proposal-card')).toHaveCount(0);
  const listed = await (await request.get(`${fakeApiRoot}/api/tasks?query=${encodeURIComponent(title)}`)).json();
  const task = listed.tasks[0]; expect(task.status).toBe('idle');
  await composer.fill(`内部工具：update_task#update-${Date.now()} ${JSON.stringify({ taskId: task.taskId, revision: task.revision, patch: { priority: 'high' } })}`);
  await composer.press('Enter');
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).task.priority).toBe('high');
  await page.locator('.work-surface').first().getByRole('button', { name: title, exact: true }).last().click();
  await expect(page.getByRole('button', { name: `查看任务：${title}`, exact: true })).toBeVisible();
  await expect(page.getByRole('complementary', { name: '任务详情' })).toContainText('核对真实任务查询与管理');
});


test('对话按关系顺序删除整组任务无需确认，其他窗口同步移除', async ({ page, context, request }) => {
  await resetE2eState(request);
  const create = async (title: string, fields = {}) => {
    const response = await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: crypto.randomUUID(), title, goal: title, ...fields } });
    expect(response.ok()).toBeTruthy();
    return (await response.json()).task;
  };
  const parent = await create('整组删除父目标');
  const child = await create('整组删除前置', { parentTaskId: parent.taskId });
  const dependent = await create('整组删除后续', { parentTaskId: parent.taskId, dependencyIds: [child.taskId] });
  const other = await context.newPage();
  await other.goto('/');
  await openPanel(other, 'management');
  await other.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
  await other.getByRole('button', { name: `查看任务：${parent.title}`, exact: true }).click();
  await expect(other.getByRole('complementary', { name: '任务详情' })).toBeVisible();
  await page.goto('/');
  const surface = page.locator('.work-surface').first();
  const composer = surface.getByLabel('Multivac 草稿');
  await composer.fill(`内部工具：delete_task#blocked ${JSON.stringify({ taskId: parent.taskId, revision: parent.revision })}`);
  await composer.press('Enter');
  await expect(surface.getByText(/此任务仍有子任务或被其他任务依赖/).last()).toBeVisible();
  expect((await request.get(`${fakeApiRoot}/api/tasks/${parent.taskId}`)).ok()).toBeTruthy();
  await composer.fill([dependent, child, parent].map((task, index) => `内部工具：delete_task#delete-${index} ${JSON.stringify({ taskId: task.taskId, revision: task.revision })}`).join('\n'));
  await composer.press('Enter');
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks`)).json()).total).toBe(0);
  await expect(page.locator('.proposal-card')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(other.getByRole('complementary', { name: '任务详情' })).toHaveCount(0);
  await expect(other.locator('.task-board-card')).toHaveCount(0);
  await expect(surface.getByText(/会话、运行与成果历史保留/).last()).toBeVisible();
});
