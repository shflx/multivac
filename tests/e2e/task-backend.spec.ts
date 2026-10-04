import { test, expect, type Page } from '@playwright/test';
import { fakeApiRoot, resetE2eState, openPanel } from './test-state.js';

async function openTasks(page: Page) {
  await page.goto('/');
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
}

test('搜索、项目与状态筛选在服务端分页前完成，能找到首屏之外的旧任务', async ({ page, request }) => {
  await resetE2eState(request);
  const project = (await (await request.post(`${fakeApiRoot}/api/projects`, { data: { name: '旧任务项目' } })).json()).workspace.project;
  const old = (await (await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: 'old', title: '旧任务在第二页', goal: '核对旧任务', projectId: project.projectId } })).json()).task;
  await request.post(`${fakeApiRoot}/api/tasks/${old.taskId}/control`, { data: { commandId: 'old-cancel', revision: old.revision, action: 'cancel' } });
  await Promise.all(Array.from({ length: 105 }, (_, i) => request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: `new-${i}`, title: `新任务-${i}`, goal: '普通任务' } })));
  const first = (await (await request.get(`${fakeApiRoot}/api/tasks?sort=recent&limit=100`)).json()).tasks;
  expect(first.some((task: { taskId: string }) => task.taskId === old.taskId)).toBe(false);
  await openTasks(page);
  await expect(page.getByRole('button', { name: '查看任务：旧任务在第二页', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill('旧任务在第二页');
  await expect(page.getByRole('button', { name: '查看任务：旧任务在第二页', exact: true })).toBeVisible();
  await expect(page.locator('.task-board-card')).toHaveCount(1);
  await expect(page.getByLabel('任务数量')).toHaveCount(0);
  await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill('');
  const projectResponse = page.waitForResponse((response) => new URL(response.url()).searchParams.get('projectId') === project.projectId);
  await page.getByRole('button', { name: '任务项目筛选：全部项目', exact: true }).click();
  await page.getByRole('option', { name: '旧任务项目', exact: true }).click();
  expect((await projectResponse).ok()).toBeTruthy();
  await expect(page.locator('.task-board-card')).toHaveCount(1);
  await expect(page.getByLabel('任务数量')).toHaveCount(0);
  await page.getByRole('button', { name: '任务项目筛选：旧任务项目', exact: true }).click();
  await page.getByRole('option', { name: '全部项目', exact: true }).click();
  await page.getByRole('button', { name: '任务列表', exact: true }).click();
  const statusResponse = page.waitForResponse((response) => new URL(response.url()).searchParams.get('viewStatus') === 'cancelled');
  await page.getByRole('button', { name: '任务状态筛选：全部状态', exact: true }).click();
  await page.getByRole('option', { name: '已取消', exact: true }).click();
  expect((await statusResponse).ok()).toBeTruthy();
  await expect(page.getByLabel('任务数量')).toHaveText('当前显示 1 / 1 个任务');
  await expect(page.getByRole('button', { name: '查看任务：旧任务在第二页', exact: true })).toBeVisible();
});

test('首屏之外的旧人工请求可回应，分页不丢失待处理事实', async ({ page, request }) => {
  await resetE2eState(request);
  const create = async (index: number) => {
    const task = (await (await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: `create-${index}`, title: index === 0 ? '旧澄清任务' : `近期请求任务-${index}`, goal: '核对来源' } })).json()).task;
    const result = await request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/requests`, { data: { commandId: `ask-${index}`, question: index === 0 ? '旧任务应采用哪份资料？' : `问题-${index}` } });
    expect(result.ok()).toBeTruthy();
    return { task, question: (await result.json()).request };
  };
  const old = await create(0);
  await Promise.all(Array.from({ length: 100 }, (_, i) => create(i + 1)));
  await openTasks(page);
  await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill('旧澄清任务');
  await page.getByRole('button', { name: '查看任务：旧澄清任务', exact: true }).click();
  const card = page.getByRole('complementary', { name: '任务详情' }).getByRole('region', { name: '任务人工请求' });
  await expect(card).toContainText('旧任务应采用哪份资料？');
  await card.getByRole('textbox', { name: '澄清回应', exact: true }).fill('采用资料 A，并保留引用。');
  await card.getByRole('button', { name: '提交回应', exact: true }).click();
  await expect(card).toHaveCount(0);
  const decided = (await (await request.get(`${fakeApiRoot}/api/task-requests/${old.question.requestId}`)).json()).request;
  expect(decided.status).toBe('answered');
  expect(decided.answer).toBe('采用资料 A，并保留引用。');
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${old.task.taskId}`)).json()).runs.length).toBe(1);
});

test('读取失败可重试，创建响应丢失后重试不重复建任务，执行结束后可继续原上下文', async ({ page, request }) => {
  await resetE2eState(request);
  let readsFail = true;
  let createFail = true;
  const commands: string[] = [];
  await page.route((url) => url.pathname === '/api/tasks', async (route) => {
    if (route.request().method() === 'GET' && readsFail) {
      await route.fulfill({ status: 503, json: { error: { code: 'INTERNAL_ERROR', message: '任务列表暂时读取失败' } } });
    } else if (route.request().method() === 'POST') {
      commands.push(route.request().postDataJSON().commandId);
      const response = await route.fetch();
      if (createFail) {
        createFail = false;
        await route.fulfill({ status: 503, json: { error: { code: 'INTERNAL_ERROR', message: '创建回执未收到，请重试' } } });
      } else await route.fulfill({ response });
    } else await route.continue();
  });
  await openTasks(page);
  await expect(page.getByRole('alert')).toContainText('任务列表暂时读取失败');
  readsFail = false;
  await page.getByRole('button', { name: '重试读取任务', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建任务', exact: true });
  await dialog.getByRole('textbox', { name: '任务名称', exact: true }).fill('创建重试任务');
  await dialog.getByRole('textbox', { name: '目标说明', exact: true }).fill('核对来源并保存结果');
  await dialog.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('创建回执未收到');
  await dialog.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(commands.length).toBe(2);
  expect(commands[0]).toBe(commands[1]);
  const list = (await (await request.get(`${fakeApiRoot}/api/tasks`)).json());
  expect(list.total).toBe(1);
  const task = list.tasks[0];
  const inspector = page.getByRole('complementary', { name: '任务详情' });
  await inspector.getByRole('button', { name: '启动任务：创建重试任务', exact: true }).click();
  await expect(inspector.getByRole('button', { name: '继续任务：创建重试任务', exact: true })).toBeVisible();
  const first = (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).runs[0];
  await inspector.getByRole('button', { name: '继续任务：创建重试任务', exact: true }).click();
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).runs.length).toBe(2);
  const next = (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).runs[0];
  expect(next.sessionId).toBe(first.sessionId);
  expect(next.directory).toEqual(first.directory);
});
