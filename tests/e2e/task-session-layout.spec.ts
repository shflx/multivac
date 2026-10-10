import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

async function jump(page: Page, title: string) {
  await page.keyboard.press('ControlOrMeta+K');
  const palette = page.getByRole('dialog', { name: '跳到会话' });
  await palette.getByRole('combobox').fill(title);
  await expect(palette.getByRole('option').first().locator('strong')).toHaveText(title);
  await page.keyboard.press('Enter');
}
async function startTask(request: APIRequestContext, title: string, projectId?: string) {
  const created = await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: crypto.randomUUID(), title, goal: '核对两份资料的依据', ...(projectId ? { projectId } : {}) } });
  expect(created.ok()).toBeTruthy();
  const { task } = await created.json();
  const started = await request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/control`, { data: { commandId: crypto.randomUUID(), revision: task.revision, action: 'start' } });
  expect(started.ok()).toBeTruthy();
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).task.status).toBe('waiting');
  return (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).task;
}
async function prepareWork(request: APIRequestContext) {
  for (const [sessionId, title] of [['work-a', '并排工作甲'], ['work-b', '并排工作乙']]) {
    expect((await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title } })).ok()).toBeTruthy();
  }
  const saved = await request.put(`${fakeApiRoot}/api/workspaces/default/scene`, { data: { parallelCount: 2, slots: ['work-a', 'work-b'], focusedSessionId: 'work-a', viewMode: 'parallel', widths: { 2: [0.6, 0.4] }, barVisible: true } });
  expect(saved.ok()).toBeTruthy();
  return await saved.json();
}
const workTitles = (page: Page) => page.locator('.workspace-page .conversation-panel:visible h2');
const taskView = (page: Page) => page.getByRole('region', { name: '任务会话视图' });

test.beforeEach(async ({ request }) => { await resetE2eState(request); });

test('查看和切换任务不改工作区现场，刷新后返回与快速跳转都恢复并排列宽及草稿', async ({ page, request }, testInfo) => {
  await prepareWork(request);
  await page.goto('/'); await openPanel(page, 'workspace');
  await expect(workTitles(page)).toHaveText(['并排工作甲', '并排工作乙']);
  const composer = page.locator('.workspace-page .conversation-panel[data-session-id="work-a"]').getByLabel('Multivac 草稿');
  await composer.fill('工作会话未发送的草稿');
  const split = await page.getByRole('separator').getAttribute('aria-valuenow');
  const before = await (await request.get(`${fakeApiRoot}/api/workspaces/default/scene`)).json();
  const task = await startTask(request, '独占任务甲');
  await startTask(request, '独占任务乙');
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
  await page.getByRole('button', { name: '查看任务：独占任务甲', exact: true }).click();
  await page.getByRole('button', { name: '打开任务会话：独占任务甲', exact: true }).click();
  await expect(taskView(page).getByRole('heading', { name: task.title, exact: true })).toBeVisible();
  await expect(workTitles(page)).toHaveCount(0);
  await expect(taskView(page).getByText('任务会话', { exact: true })).toBeVisible();
  await taskView(page).getByRole('button', { name: '查看文件', exact: true }).click();
  await expect(taskView(page).locator('.conversation-original')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('task-view.png') });
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/workspaces/default/scene`)).json())).toEqual(before);
  await jump(page, '独占任务乙');
  await expect(taskView(page).getByRole('heading', { name: '独占任务乙', exact: true })).toBeVisible();
  await page.reload();
  await expect(taskView(page).getByRole('heading', { name: '独占任务乙', exact: true })).toBeVisible();
  await taskView(page).getByRole('button', { name: '返回工作区', exact: true }).click();
  await expect(workTitles(page)).toHaveText(['并排工作甲', '并排工作乙']);
  await expect(page.getByRole('separator')).toHaveAttribute('aria-valuenow', split!);
  await expect(composer).toHaveValue('工作会话未发送的草稿');
  await jump(page, '独占任务甲');
  await expect(taskView(page)).toBeVisible();
  await jump(page, '并排工作乙');
  await expect(workTitles(page)).toHaveText(['并排工作甲', '并排工作乙']);
  await expect(page.locator('.workspace-page .conversation-panel.active h2')).toHaveText('并排工作乙');
  await expect(page.getByRole('separator')).toHaveAttribute('aria-valuenow', split!);
  await page.screenshot({ path: testInfo.outputPath('returned-parallel.png') });
});

test('跨项目查看任务不切换原工作区，侧栏上下文反映任务，另一个窗口保持并排', async ({ page, request, context }) => {
  await prepareWork(request);
  const project = await (await request.post(`${fakeApiRoot}/api/projects`, { data: { name: '任务项目' } })).json();
  const task = await startTask(request, '跨项目任务', project.project.projectId);
  const before = await (await request.get(`${fakeApiRoot}/api/workspaces/default/scene`)).json();
  await page.goto('/'); await openPanel(page, 'workspace');
  const other = await context.newPage(); await other.goto('/'); await openPanel(other, 'workspace');
  await jump(page, task.title);
  await expect(taskView(page)).toBeVisible();
  await jump(page, task.title);
  await expect(workTitles(other)).toHaveText(['并排工作甲', '并排工作乙']);
  await page.keyboard.press('ControlOrMeta+J');
  const sidebar = page.locator('.multivac-sidebar');
  const sent = page.waitForRequest(item => item.method() === 'POST' && new URL(item.url()).pathname === '/api/assistant/turns');
  await sidebar.getByLabel('Multivac 草稿').fill('内部工具：get_current_view#task-view {}'); await sidebar.getByLabel('发送消息').click();
  const payload = (await sent).postDataJSON();
  expect(payload.view.workspace.workspaceId).toBe(project.workspace.workspaceId);
  expect(payload.view.workspace.scene.focusedSessionId).toBe(task.sessionId);
  expect(payload.view.workspace.taskSession).toEqual({ sessionId: task.sessionId, taskId: task.taskId });
  expect(payload.contextRefs).toEqual([{ kind: 'workspace-session', sessionId: task.sessionId }]);
  await expect(sidebar.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(sidebar).toContainText('任务会话「跨项目任务」');
  await page.keyboard.press('ControlOrMeta+J');
  await taskView(page).getByRole('button', { name: '返回工作区', exact: true }).click();
  await expect(workTitles(page)).toHaveText(['并排工作甲', '并排工作乙']);
  expect(await page.evaluate(() => localStorage.getItem('multivac.workspace.current'))).not.toBe(project.workspace.workspaceId);
  expect(await (await request.get(`${fakeApiRoot}/api/workspaces/default/scene`)).json()).toEqual(before);
  await other.close();
});
