import { test, expect } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';

test('自然语言工具复用关系服务，确认卡展示父与多前置，查询与按版本更新不启动执行', async ({ page, request }) => {
  await resetE2eState(request);
  const create = async (title: string) => (await (await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: crypto.randomUUID(), title, goal: title } })).json()).task;
  const parent = await create('工具父目标'); const first = await create('工具前置一'); const second = await create('工具前置二');
  await page.goto('/');
  const surface = page.locator('.work-surface').first();
  const composer = surface.getByLabel('Multivac 草稿');
  const title = '工具创建子目标';
  await composer.fill(`内部工具：propose_create_task#relations-create ${JSON.stringify({ title, goal: '核对关系工具', parentTaskId: parent.taskId, dependencyIds: [first.taskId, second.taskId] })}`);
  await composer.press('Enter');
  const card = page.locator('.proposal-card').filter({ hasText: title });
  await expect(card).toContainText(`工具父目标（${parent.taskId}）`);
  await expect(card).toContainText(`工具前置一（${first.taskId}）`); await expect(card).toContainText(`工具前置二（${second.taskId}）`);
  expect((await (await request.get(`${fakeApiRoot}/api/tasks?query=${title}`)).json()).total).toBe(0);
  await card.getByRole('button', { name: '创建任务', exact: true }).click(); await expect(card).toContainText('已创建');
  const child = (await (await request.get(`${fakeApiRoot}/api/tasks?query=${title}`)).json()).tasks[0];
  expect(child.parentTaskId).toBe(parent.taskId); expect(new Set(child.dependencyIds)).toEqual(new Set([first.taskId, second.taskId])); expect(child.currentRunId).toBeNull();
  await composer.fill(`内部工具：get_task#relations-get ${JSON.stringify({ taskId: parent.taskId })}`); await composer.press('Enter');
  await expect(surface.getByText(/直属子任务完成 0\/1，已取消 0。/)).toBeVisible();
  await composer.fill(`内部工具：list_tasks#relations-list ${JSON.stringify({ parentTaskId: parent.taskId, limit: 1 })}`); await composer.press('Enter');
  await expect(surface.getByText(/共 1 项，当前 1 项；下一页 offset：无。/)).toBeVisible();
  await composer.fill(`内部工具：update_task#relations-update ${JSON.stringify({ taskId: child.taskId, revision: child.revision, patch: { parentTaskId: null, dependencyIds: [second.taskId] } })}`); await composer.press('Enter');
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${child.taskId}`)).json()).task.parentTaskId).toBeNull();
  const updated = (await (await request.get(`${fakeApiRoot}/api/tasks/${child.taskId}`)).json()).task;
  expect(updated.dependencyIds).toEqual([second.taskId]); expect(updated.status).toBe('idle'); expect(updated.currentRunId).toBeNull(); expect(updated.revision).toBe(2);
});
