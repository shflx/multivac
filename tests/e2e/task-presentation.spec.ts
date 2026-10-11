import { test, expect } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

test('概览精简关系并保留排队等待，详情保留长目标与完整进展，更多操作支持 Esc 返回焦点', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  const create = async (title: string, fields = {}) => (await (await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: crypto.randomUUID(), title, goal: title, ...fields } })).json()).task;
  const parent = await create('上线账号功能');
  const dependency = await create('准备登录接口');
  let child = await create('联调登录流程', { parentTaskId: parent.taskId, dependencyIds: [dependency.taskId], goal: '验证登录成功和失败的处理。'.repeat(35) });
  for (let i = 0; i < 6; i++) child = (await (await request.patch(`${fakeApiRoot}/api/tasks/${child.taskId}`, { data: { commandId: crypto.randomUUID(), revision: child.revision, patch: { scope: `参考资料 ${i}` } } })).json()).task;
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
  const card = page.locator(`.task-board-card[data-task-id="${child.taskId}"]`);
  await expect(card).not.toContainText('准备登录接口');
  await expect(card).not.toContainText('上线账号功能');
  await page.getByRole('button', { name: '任务列表', exact: true }).click();
  await expect(page.locator('.task-tree-parent')).toHaveCount(0);
  await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill(child.title);
  await expect(page.locator('.task-tree-parent')).toContainText(parent.title);
  await expect(page.locator('.task-list-row')).not.toContainText('准备登录接口');
  await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill('');
  await page.getByRole('button', { name: '任务看板', exact: true }).click();
  await expect(card).not.toContainText('已取消 0');
  await card.getByRole('button', { name: `查看任务：${child.title}`, exact: true }).click();
  const inspector = page.getByRole('complementary', { name: '任务详情' });
  await expect(inspector.locator('.task-events li')).toHaveCount(4);
  await expect(inspector.getByText('暂无成果', { exact: true })).toHaveCount(0);
  await expect(inspector.getByText(child.taskId, { exact: true })).toHaveCount(0);
  await inspector.getByRole('button', { name: '展开目标', exact: true }).click();
  await expect(inspector.locator('.task-goal')).not.toHaveClass(/collapsed/);
  await inspector.getByRole('button', { name: '查看全部进展', exact: true }).click();
  await expect(inspector.locator('.task-events li')).toHaveCount(7);
  await inspector.getByRole('button', { name: '收起进展', exact: true }).click();
  await expect(inspector.locator('.task-events li')).toHaveCount(4);
  await expect(inspector.getByRole('button', { name: `删除任务：${child.title}` })).toHaveCount(0);
  const more = inspector.getByRole('button', { name: '更多任务操作', exact: true });
  await more.click(); await page.keyboard.press('Escape');
  await expect(more).toBeFocused(); await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(inspector).toBeVisible();
  await inspector.getByRole('button', { name: '收起目标', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('task-density-wide.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 900, height: 760 });
  await expect(inspector).toBeVisible();
  expect(await inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('task-density-narrow.png'), animations: 'disabled' });
  const queued = await request.post(`${fakeApiRoot}/api/tasks/${child.taskId}/control`, { data: { commandId: crypto.randomUUID(), revision: child.revision, action: 'start' } });
  expect(queued.ok()).toBeTruthy();
  await expect(card.getByText('等待「准备登录接口」进入审核中或已完成', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.getByRole('button', { name: '任务列表', exact: true }).click();
  await expect(page.locator('.task-list-row').filter({ hasText: child.title })).toContainText('等待「准备登录接口」进入审核中或已完成');
  const current = (await (await request.get(`${fakeApiRoot}/api/tasks/${child.taskId}`)).json()).task;
  const cancelled = await request.post(`${fakeApiRoot}/api/tasks/${child.taskId}/control`, { data: { commandId: crypto.randomUUID(), revision: current.revision, action: 'cancel' } });
  expect(cancelled.ok()).toBeTruthy();
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${child.taskId}`)).json()).runs[0].stopConfirmed).toBe(true);
});

test('看板在已完成列内展开较早完成任务，吸底条提示剩余数量并加载下一页', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  const create = async (title: string, fields = {}) => (await (await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: crypto.randomUUID(), title, goal: title, ...fields } })).json()).task;
  for (let i = 0; i < 105; i++) await create(`待办事项 ${i + 1}`);
  for (let i = 0; i < 12; i++) {
    const task = await create(`已办事项 ${i + 1}`, { humanOnly: true });
    expect((await request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/confirm-completion`, { data: { commandId: crypto.randomUUID(), revision: task.revision } })).ok()).toBeTruthy();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
  const done = page.getByRole('region', { name: '已完成', exact: true });
  await expect(done.locator('.task-board-card')).toHaveCount(5);
  await expect(page.getByRole('region', { name: '执行中', exact: true })).toContainText('已加载的任务中暂无');
  const older = done.getByRole('button', { name: '显示更早完成的 7 个任务', exact: true });
  await expect(older).toHaveAttribute('aria-expanded', 'false');
  await older.click();
  await expect(done.locator('.task-board-card')).toHaveCount(12);
  await expect(done.getByRole('button', { name: '收起更早完成的任务', exact: true })).toHaveAttribute('aria-expanded', 'true');

  // 吸底条在长列中途保持可见，无需滚到最高一列末尾。
  const more = page.getByRole('group', { name: '更多任务', exact: true });
  await expect(more).toContainText('还有 17 个任务未加载');
  await page.locator('.task-panel-main').evaluate((element) => { element.scrollTop = 3000; });
  await expect(more).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('task-board-load-more.png'), animations: 'disabled' });
  await more.getByRole('button', { name: '加载更多任务', exact: true }).click();
  await expect(page.getByRole('region', { name: '未开始', exact: true }).locator('.task-board-card')).toHaveCount(105);
  await expect(more).toHaveCount(0);
  await expect(page.locator('.task-panel')).toBeFocused();
  await expect(page.getByRole('region', { name: '执行中', exact: true })).toContainText('暂无任务');
});
