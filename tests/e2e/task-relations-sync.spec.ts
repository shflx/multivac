import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Task } from '@multivac/contracts';
import { fakeApiRoot, resetE2eState, openPanel } from './test-state.js';

async function create(request: APIRequestContext, title: string, fields: object = {}): Promise<Task> {
  const response = await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: crypto.randomUUID(), title, goal: title, ...fields } });
  expect(response.ok()).toBeTruthy(); return (await response.json()).task;
}
async function select(page: Page, title: string) {
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
  await page.getByLabel('搜索任务', { exact: true }).fill(title);
  await page.getByRole('button', { name: `查看任务：${title}`, exact: true }).click();
}

test('两个窗口更新旧新父进度，查询失败可重试，排队与安全暂停保留未保存的关系草稿', async ({ page, context, request }) => {
  await resetE2eState(request);
  const first = await create(request, '同步原父'); const second = await create(request, '同步新父');
  const before = await create(request, '同步前置'); const extra = await create(request, '草稿前置');
  const child = await create(request, '同步子目标', { parentTaskId: first.taskId, dependencyIds: [before.taskId] });
  let fail = true;
  await page.route(`**/api/tasks/${first.taskId}/relations*`, async (route) => { if (fail) { await route.abort('failed'); } else await route.continue(); });
  await select(page, first.title);
  const inspector = page.getByRole('complementary', { name: '任务详情' });
  await expect(inspector.getByRole('button', { name: '重试任务关系', exact: true })).toBeVisible();
  await expect(inspector.getByRole('button', { name: '编辑关系', exact: true })).toBeDisabled();
  fail = false;
  await inspector.getByRole('button', { name: '重试任务关系', exact: true }).click();
  await expect(inspector.getByText('已完成 0 / 1 · 已取消 0', { exact: true })).toBeVisible();
  const other = await context.newPage();
  try {
    await select(other, second.title);
    const otherInspector = other.getByRole('complementary', { name: '任务详情' });
    await expect(otherInspector.getByText('已完成 0 / 0 · 已取消 0', { exact: true })).toBeVisible();
    await inspector.getByRole('button', { name: new RegExp(`^${child.title}`) }).click();
    await inspector.getByRole('button', { name: '编辑关系', exact: true }).click();
    await inspector.getByRole('button', { name: '更换父任务', exact: true }).click();
    const picker = inspector.getByRole('group', { name: '父任务', exact: true });
    await picker.getByRole('textbox').fill(second.title);
    await picker.getByRole('button', { name: `选择父任务：${second.title}（${second.taskId}）`, exact: true }).click();
    await inspector.getByRole('button', { name: '保存关系', exact: true }).click();
    await expect(otherInspector.getByText('已完成 0 / 1 · 已取消 0', { exact: true })).toBeVisible();
    await inspector.getByRole('button', { name: `返回「${first.title}」`, exact: true }).click();
    await expect(inspector.getByText('已完成 0 / 0 · 已取消 0', { exact: true })).toBeVisible();
    await otherInspector.getByRole('button', { name: new RegExp(`^${child.title}`) }).click();
    await otherInspector.getByRole('button', { name: '编辑关系', exact: true }).click();
    await otherInspector.getByRole('button', { name: '添加前置任务', exact: true }).click();
    const depPicker = otherInspector.getByRole('group', { name: '前置任务', exact: true });
    await depPicker.getByRole('textbox').fill(extra.title);
    await depPicker.getByRole('button', { name: `选择前置任务：${extra.title}（${extra.taskId}）`, exact: true }).click();
    await depPicker.getByRole('button', { name: '关闭前置任务', exact: true }).click();
    const start = await request.post(`${fakeApiRoot}/api/tasks/${child.taskId}/control`, { data: { commandId: crypto.randomUUID(), revision: 2, action: 'start' } });
    expect(start.ok()).toBeTruthy();
    await expect(otherInspector.getByRole('button', { name: '保存关系', exact: true })).toBeDisabled();
    await expect(otherInspector.getByRole('button', { name: `移除前置任务：${extra.title}`, exact: true })).toBeVisible();
    await expect(otherInspector.getByText(/任务已进入执行流程，请先安全停止，再修改关系。/).first()).toBeVisible();
    const queuedDetail = await (await request.get(`${fakeApiRoot}/api/tasks/${child.taskId}`)).json();
    const queued = queuedDetail.task as Task;
    expect(queued.status).toBe('queued'); expect(queuedDetail.runs[0].hasStarted).toBe(false);
    const pause = await request.post(`${fakeApiRoot}/api/tasks/${child.taskId}/control`, { data: { commandId: crypto.randomUUID(), revision: queued.revision, action: 'pause' } });
    expect(pause.ok()).toBeTruthy();
    await otherInspector.getByRole('button', { name: '使用最新版本重新核对', exact: true }).click();
    await otherInspector.getByRole('button', { name: '保存关系', exact: true }).click();
    await expect(otherInspector.getByRole('button', { name: '保存关系', exact: true })).toHaveCount(0);
    const updated = (await (await request.get(`${fakeApiRoot}/api/tasks/${child.taskId}`)).json()).task as Task;
    expect(updated.status).toBe('paused'); expect(new Set(updated.dependencyIds)).toEqual(new Set([before.taskId, extra.taskId]));
  } finally { await other.close(); }
});
