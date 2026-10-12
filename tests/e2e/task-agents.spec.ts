import { test, expect } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

test('任务看板、详情与任务会话显示执行智能体，缺省为通用执行', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  const agent = (await (await request.post(`${fakeApiRoot}/api/agents`, { data: { commandId: crypto.randomUUID(), name: '代码审查', modelProfileId: 'fixture-openai', instructions: '先列风险。' } })).json()).agent;
  const create = async (title: string, fields = {}) => (await (await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: crypto.randomUUID(), title, goal: title, ...fields } })).json()).task;
  const reviewed = await create('审查登录改动', { agentId: agent.agentId });
  const plain = await create('整理周报');
  expect(reviewed.agentId).toBe(agent.agentId);
  expect(plain.agentId).toBe('general');
  const coordinator = await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: crypto.randomUUID(), title: '协调', goal: '协调', agentId: 'coordinator' } });
  expect(coordinator.status()).toBe(400);
  await request.post(`${fakeApiRoot}/api/tasks/${reviewed.taskId}/control`, { data: { commandId: crypto.randomUUID(), revision: reviewed.revision, action: 'start' } });
  // 运行记录保存启动时选定的智能体。
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${reviewed.taskId}`)).json()).runs?.[0]?.agentId).toBe(agent.agentId);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '快捷键', exact: true })).toBeVisible();
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
  const reviewedCard = page.locator(`.task-board-card[data-task-id="${reviewed.taskId}"]`);
  await expect(reviewedCard.locator('.task-card-agent')).toHaveText('代码审查');
  // 默认的通用执行不在卡片上重复标注，保持看板简洁。
  await expect(page.locator(`.task-board-card[data-task-id="${plain.taskId}"] .task-card-agent`)).toHaveCount(0);

  await page.getByRole('button', { name: `查看任务：${plain.title}`, exact: true }).click();
  const inspector = page.getByRole('complementary', { name: '任务详情' });
  await expect(inspector.locator('.task-inspector-agent')).toHaveText('通用执行');
  await reviewedCard.getByRole('button', { name: `查看任务：${reviewed.title}`, exact: true }).click();
  await expect(inspector.locator('.task-inspector-agent')).toHaveText('代码审查');

  // 改名经工作台事件同步到已打开的详情。
  await request.patch(`${fakeApiRoot}/api/agents/${agent.agentId}`, { data: { commandId: crypto.randomUUID(), revision: agent.revision, patch: { name: '安全审查' } } });
  await expect(inspector.locator('.task-inspector-agent')).toHaveText('安全审查');
  await expect(reviewedCard.locator('.task-card-agent')).toHaveText('安全审查');
  await page.screenshot({ path: testInfo.outputPath('task-agent-1440.png'), animations: 'disabled' });

  await inspector.getByRole('button', { name: `打开任务会话：${reviewed.title}` }).click();
  await expect(page.locator('.session-task-link').filter({ hasText: reviewed.title }).locator('.session-task-agent')).toHaveText('执行智能体：安全审查');
});
