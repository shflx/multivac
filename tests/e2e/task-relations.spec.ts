import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Task } from '@multivac/contracts';
import { fakeApiRoot, resetE2eState, openPanel } from './test-state.js';

async function create(request: APIRequestContext, title: string, fields: Partial<Task> = {}): Promise<Task> {
  const result = await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: crypto.randomUUID(), title, goal: title, ...fields } });
  expect(result.ok()).toBeTruthy(); return (await result.json()).task;
}
async function openTasks(page: Page) {
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
}
async function select(page: Page, title: string) {
  await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill(title);
  await page.getByRole('button', { name: `查看任务：${title}`, exact: true }).click();
}

test('创建日常子任务固定父项目，按身份选择同名多前置，关系导航返回来源且不启动', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  const parent = await create(request, '日常父目标');
  const first = await create(request, '同名前置'); const second = await create(request, '同名前置');
  const project = (await (await request.post(`${fakeApiRoot}/api/projects`, { data: { name: '另一项目' } })).json()).workspace.project;
  const foreign = await create(request, '同名前置', { projectId: project.projectId });
  await openTasks(page); await select(page, parent.title);
  const inspector = page.getByRole('complementary', { name: '任务详情' });
  await inspector.getByRole('button', { name: '创建子任务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建任务' });
  await expect(dialog.getByRole('button', { name: '任务所属项目：不关联项目', exact: true })).toBeDisabled();
  await expect(dialog.getByText(/从父任务创建，项目与父任务固定/)).toBeVisible();
  await dialog.getByLabel('任务名称', { exact: true }).fill('日常子目标');
  await dialog.getByLabel('目标说明', { exact: true }).fill('仅记录目标');
  await dialog.getByRole('button', { name: '添加前置任务', exact: true }).click();
  const picker = dialog.getByRole('group', { name: '前置任务', exact: true });
  await picker.getByRole('textbox', { name: '搜索前置任务', exact: true }).fill('同名前置');
  await expect(picker.getByRole('button', { name: `选择前置任务：同名前置（${foreign.taskId}）`, exact: true })).toHaveCount(0);
  await picker.getByRole('button', { name: `选择前置任务：同名前置（${first.taskId}）`, exact: true }).click();
  await picker.getByRole('button', { name: `选择前置任务：同名前置（${second.taskId}）`, exact: true }).click();
  await picker.getByRole('textbox').focus(); await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0); await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '添加前置任务', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(inspector.getByRole('heading', { name: '日常子目标', exact: true })).toBeVisible();
  const child = (await (await request.get(`${fakeApiRoot}/api/tasks?query=日常子目标`)).json()).tasks[0] as Task;
  expect(child.parentTaskId).toBe(parent.taskId); expect(child.projectId).toBeNull();
  expect(new Set(child.dependencyIds)).toEqual(new Set([first.taskId, second.taskId])); expect(child.status).toBe('idle'); expect(child.currentRunId).toBeNull();
  await expect(inspector.getByText('还有 2 个前置任务未完成；这是执行条件。尚未申请执行。', { exact: true })).toBeVisible();
  await inspector.getByRole('button', { name: `返回「${parent.title}」`, exact: true }).click();
  await expect(inspector.getByRole('heading', { name: parent.title, exact: true })).toBeVisible();
  await expect(inspector.getByText('已完成 0 / 1 · 已取消 0', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 900, height: 760 });
  await page.screenshot({ path: testInfo.outputPath('task-relations-900.png'), animations: 'disabled' });
});

test('关系保存丢失回执沿用命令重试，冲突保留草稿并显式采用最新版本', async ({ page, request }) => {
  await resetE2eState(request);
  const first = await create(request, '原父目标'); const second = await create(request, '新父目标'); const dep = await create(request, '前置目标');
  const child = await create(request, '关系编辑目标', { parentTaskId: first.taskId });
  await openTasks(page); await select(page, child.title);
  const inspector = page.getByRole('complementary', { name: '任务详情' });
  await inspector.getByRole('button', { name: '编辑关系', exact: true }).click();
  await inspector.getByRole('button', { name: '更换父任务', exact: true }).click();
  let picker = inspector.getByRole('group', { name: '父任务', exact: true });
  await picker.getByRole('textbox').fill(second.title);
  await picker.getByRole('button', { name: `选择父任务：${second.title}（${second.taskId}）`, exact: true }).click();
  await inspector.getByRole('button', { name: '添加前置任务', exact: true }).click();
  picker = inspector.getByRole('group', { name: '前置任务', exact: true });
  await picker.getByRole('textbox').fill(dep.title);
  await picker.getByRole('button', { name: `选择前置任务：${dep.title}（${dep.taskId}）`, exact: true }).click();
  await picker.getByRole('button', { name: '关闭前置任务', exact: true }).click();
  const commands: { commandId: string; revision: number }[] = [];
  let lose = true;
  await page.route(`**/api/tasks/${child.taskId}`, async (route) => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return; }
    commands.push(route.request().postDataJSON());
    if (lose) { lose = false; await route.fetch(); await route.abort('failed'); } else await route.continue();
  });
  await inspector.getByRole('button', { name: '保存关系', exact: true }).click();
  await expect(inspector.getByRole('button', { name: '重试保存', exact: true })).toBeEnabled();
  await inspector.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(inspector.getByRole('button', { name: '保存关系', exact: true })).toHaveCount(0);
  expect(commands).toHaveLength(2); expect(commands[0]?.commandId).toBe(commands[1]?.commandId); expect(commands[1]?.revision).toBe(1);
  let detail = await (await request.get(`${fakeApiRoot}/api/tasks/${child.taskId}`)).json();
  expect(detail.task.revision).toBe(2); expect(detail.task.parentTaskId).toBe(second.taskId); expect(detail.events.filter((event: { kind: string }) => event.kind === 'updated')).toHaveLength(1);
  await page.unroute(`**/api/tasks/${child.taskId}`);
  await inspector.getByRole('button', { name: '编辑关系', exact: true }).click();
  await inspector.getByRole('button', { name: '解除父任务', exact: true }).click();
  let conflict = true;
  await page.route(`**/api/tasks/${child.taskId}`, async (route) => {
    if (route.request().method() === 'PATCH' && conflict) { conflict = false; await request.patch(`${fakeApiRoot}/api/tasks/${child.taskId}`, { data: { commandId: crypto.randomUUID(), revision: 2, patch: { priority: 'high' } } }); }
    await route.continue();
  });
  await inspector.getByRole('button', { name: '保存关系', exact: true }).click();
  await expect(inspector.getByText('任务已变化，请读取最新版本后重试。', { exact: true })).toBeVisible();
  await expect(inspector.getByText('无父任务', { exact: true })).toBeVisible();
  await inspector.getByRole('button', { name: '使用最新版本重新核对', exact: true }).click();
  await inspector.getByRole('button', { name: '保存关系', exact: true }).click();
  await expect(inspector.getByRole('button', { name: '保存关系', exact: true })).toHaveCount(0);
  detail = await (await request.get(`${fakeApiRoot}/api/tasks/${child.taskId}`)).json();
  expect(detail.task.parentTaskId).toBeNull(); expect(detail.task.priority).toBe('high'); expect(detail.task.dependencyIds).toEqual([dep.taskId]); expect(detail.task.revision).toBe(4);
});

test('超过百条子任务完整统计与分页，展开去重、深层关系和筛选上下文不污染主查询', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  const parent = await create(request, '大量子任务父目标');
  const children: Task[] = [];
  for (let index = 0; index < 110; index++) children.push(await create(request, `子目标-${index}`, { parentTaskId: parent.taskId }));
  const grandchild = await create(request, '深层二', { parentTaskId: children[0]!.taskId });
  const third = await create(request, '深层三', { parentTaskId: grandchild.taskId });
  await create(request, '深层四', { parentTaskId: third.taskId });
  await openTasks(page); await select(page, parent.title);
  const inspector = page.getByRole('complementary', { name: '任务详情' });
  await expect(inspector.getByText('已完成 0 / 110 · 已取消 0', { exact: true })).toBeVisible();
  await inspector.getByRole('button', { name: '加载更多子任务', exact: true }).click();
  await inspector.getByRole('button', { name: '加载更多子任务', exact: true }).click();
  await expect(inspector.getByRole('button', { name: '加载更多子任务', exact: true })).toHaveCount(0);
  await expect(inspector.getByText('已读取 110 / 110 项', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '任务列表', exact: true }).click();
  await page.getByRole('button', { name: `展开子任务：${parent.title}`, exact: true }).click();
  await expect(page.locator('.task-list-row')).toHaveCount(51);
  await page.getByRole('button', { name: `加载更多子任务：${parent.title}`, exact: true }).click();
  await expect(page.locator('.task-list-row')).toHaveCount(101);
  await page.getByRole('button', { name: `加载更多子任务：${parent.title}`, exact: true }).click();
  await expect(page.locator('.task-list-row')).toHaveCount(111);
  await expect(page.getByLabel('任务数量')).toHaveText('当前显示 1 / 1 个任务');
  await expect(page.locator('.relation-context')).toHaveCount(110);
  for (const title of [children[0]!.title, grandchild.title, third.title]) await page.getByRole('button', { name: `展开子任务：${title}`, exact: true }).click();
  await expect(page.locator('.task-list-row')).toHaveCount(114);
  await expect(page.locator('[data-depth="4"]')).toContainText('深层四');
  await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill('');
  await expect(page.getByLabel('任务数量')).toContainText('/ 114 个任务');
  await expect(page.locator('.task-list-row')).toHaveCount(114);
  await expect(page.locator('.task-panel-list').getByRole('button', { name: `查看任务：${children[0]!.title}`, exact: true })).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('task-tree-1440.png'), animations: 'disabled' });
});
