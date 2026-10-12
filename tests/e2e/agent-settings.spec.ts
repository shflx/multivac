import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

interface ListedAgent {
  agentId: string;
  name: string;
  description: string;
  modelProfileId: string | null;
  thinkingLevel: string | null;
  instructions: string;
  revision: number;
}

const agentsPage = (page: Page) => page.getByRole('main', { name: '智能体' });
const agentList = (page: Page) => agentsPage(page).getByRole('list', { name: '智能体列表' });
const detail = (page: Page) => agentsPage(page).locator('.agent-detail');

async function listAgents(request: APIRequestContext): Promise<ListedAgent[]> {
  const response = await request.get(`${fakeApiRoot}/api/agents`);
  expect(response.ok()).toBe(true);
  return (await response.json() as { agents: ListedAgent[] }).agents;
}

async function openAgentSettings(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.shell-header')).toBeVisible();
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '智能体', exact: true }).click();
  await expect(agentsPage(page)).toBeVisible();
}

test('智能体页列出预置记录，协调者只读：没有编辑、删除、模型与指令入口', async ({ page, request }) => {
  await resetE2eState(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAgentSettings(page);

  // 页头只有标题与“新建智能体”。
  await expect(agentsPage(page).locator('.management-page-header')).toHaveText('智能体新建智能体');
  await expect(agentList(page).getByRole('listitem')).toHaveCount(2);
  const coordinator = agentList(page).locator('[data-agent-id="coordinator"]');
  await expect(coordinator.locator('small')).toHaveText('固定配置');
  // 默认打开通用执行。
  await expect(agentList(page).locator('[data-agent-id="general"]')).toHaveAttribute('aria-current', 'true');
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('通用执行');
  // 通用执行可以编辑，但不能删除。
  await expect(detail(page).getByRole('button', { name: '编辑' })).toBeEnabled();
  await expect(detail(page).getByRole('button', { name: '删除' })).toBeDisabled();
  await expect(detail(page).getByRole('button', { name: '通用执行 的模型与推理等级' })).toBeVisible();

  await coordinator.click();
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('Multivac（协调）');
  await expect(detail(page)).toContainText('固定配置');
  await expect(detail(page).getByRole('button', { name: '编辑' })).toHaveCount(0);
  await expect(detail(page).getByRole('button', { name: '删除' })).toHaveCount(0);
  await expect(detail(page).locator('textarea')).toHaveCount(0);
  await expect(detail(page).locator('.model-selector')).toHaveCount(0);
  // v1 不放未实现的区块。
  for (const label of ['常用 Skill', '需要的服务', '效果上限', '实际可用']) await expect(agentsPage(page).getByText(label)).toHaveCount(0);
});

test('新建 → 编辑模型与指令（保存 / 还原）→ 删除确认的闭环', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAgentSettings(page);

  // 新建：页内表单，名称必填。
  await agentsPage(page).getByRole('button', { name: '新建智能体' }).click();
  const form = agentsPage(page).locator('.agent-new-form');
  await expect(form.getByRole('button', { name: '创建' })).toBeDisabled();
  await form.getByRole('textbox', { name: '名称' }).fill('代码审查');
  await form.getByRole('textbox', { name: '用途' }).fill('审查代码改动，先列风险');
  const newModel = form.getByRole('button', { name: '新智能体的模型与推理等级' });
  await expect(newModel).toContainText('跟随默认（GPT Fixture）');
  await newModel.click();
  await form.locator('.model-option').filter({ hasText: 'Claude Fixture' }).getByRole('button').click();
  await expect(newModel).toContainText('Claude Fixture');
  await page.keyboard.press('Escape');
  await form.getByRole('textbox', { name: '指令' }).fill('先列风险，再给修改建议。');
  await page.screenshot({ path: testInfo.outputPath('agent-new-1440.png'), animations: 'disabled' });
  await form.getByRole('button', { name: '创建' }).click();

  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('代码审查');
  let created = (await listAgents(request)).find((agent) => agent.name === '代码审查')!;
  expect(created).toMatchObject({ description: '审查代码改动，先列风险', modelProfileId: 'fixture-anthropic', thinkingLevel: null, instructions: '先列风险，再给修改建议。' });
  const row = agentList(page).locator(`[data-agent-id="${created.agentId}"]`);
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(row.locator('small')).toHaveText('审查代码改动，先列风险');

  // 最近任务：按智能体查询，点击进入任务详情。
  await expect(detail(page).getByText('还没有用它执行的任务。')).toBeVisible();
  const task = (await (await request.post(`${fakeApiRoot}/api/tasks`, {
    data: { commandId: crypto.randomUUID(), title: '审查登录改动', goal: '审查登录改动', agentId: created.agentId },
  })).json()).task;
  await expect(detail(page).getByRole('list', { name: '最近任务' }).getByRole('button')).toHaveText(['未开始审查登录改动']);

  // 模型：选择即保存；不可用的模型不能选，引用保持不变。
  const picker = detail(page).getByRole('button', { name: '代码审查 的模型与推理等级' });
  await picker.click();
  const menu = detail(page).locator('.model-selector-menu');
  await menu.locator('.model-option').filter({ hasText: '未认证 Fixture' }).getByRole('button').click();
  await expect(menu.getByRole('alert')).toContainText('这个模型当前不可用');
  await menu.locator('.model-option').filter({ hasText: 'GPT Fixture' }).getByRole('button').click();
  await expect(detail(page).locator('.section-title').filter({ hasText: '模型与推理' }).getByText('已保存')).toBeVisible();
  await expect(picker).toContainText('GPT Fixture');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  created = (await listAgents(request)).find((agent) => agent.agentId === created.agentId)!;
  expect(created.modelProfileId).toBe('fixture-openai');

  // 指令：改完点保存才生效；还原回到上次保存的值。
  const instructions = detail(page).getByRole('textbox', { name: '代码审查 的指令' });
  const save = detail(page).locator('.project-constraints-actions').getByRole('button', { name: '保存' });
  const revert = detail(page).getByRole('button', { name: '还原' });
  await expect(save).toBeDisabled();
  await instructions.fill('只看安全问题。');
  await revert.click();
  await expect(instructions).toHaveValue('先列风险，再给修改建议。');
  await expect(save).toBeDisabled();
  expect((await listAgents(request)).find((agent) => agent.agentId === created.agentId)!.instructions).toBe('先列风险，再给修改建议。');
  await instructions.fill('  只看安全问题。  ');
  await save.click();
  await expect(detail(page).locator('.project-constraints-actions').getByText('已保存')).toBeVisible();
  await expect(instructions).toHaveValue('只看安全问题。');
  expect((await listAgents(request)).find((agent) => agent.agentId === created.agentId)!.instructions).toBe('只看安全问题。');

  // 名称与用途：原地编辑后保存，列表随之更新。
  await detail(page).getByRole('button', { name: '编辑' }).click();
  await detail(page).getByRole('textbox', { name: '智能体名称' }).fill('安全审查');
  await detail(page).getByRole('button', { name: '保存' }).first().click();
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('安全审查');
  await expect(row.locator('strong')).toHaveText('安全审查');
  await page.screenshot({ path: testInfo.outputPath('agent-detail-1440.png'), animations: 'disabled' });

  // 删除：仍有未结束的任务在用它时被拒绝，原因留在确认卡上。
  await detail(page).getByRole('button', { name: '删除' }).click();
  const card = page.getByRole('dialog', { name: '删除智能体「安全审查」' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: '取消' })).toBeFocused();
  await card.getByRole('button', { name: '删除' }).click();
  await expect(card.getByRole('alert')).toContainText('仍有未完成的任务使用这个智能体');
  await card.getByRole('button', { name: '取消' }).click();
  await expect(card).toHaveCount(0);

  // 任务结束后才能删除；取消确认不删除，确认后回到通用执行。
  await request.patch(`${fakeApiRoot}/api/tasks/${task.taskId}`, {
    data: { commandId: crypto.randomUUID(), revision: task.revision, patch: { agentId: 'general' } },
  });
  await detail(page).getByRole('button', { name: '删除' }).click();
  await card.getByRole('button', { name: '取消' }).click();
  expect((await listAgents(request)).some((agent) => agent.agentId === created.agentId)).toBe(true);
  await detail(page).getByRole('button', { name: '删除' }).click();
  await card.getByRole('button', { name: '删除' }).click();
  await expect(card).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('通用执行');
  expect((await listAgents(request)).some((agent) => agent.agentId === created.agentId)).toBe(false);
});

test('有未保存的指令时切换智能体先经确认卡，取消后保留输入', async ({ page, request }) => {
  await resetE2eState(request);
  await openAgentSettings(page);
  const instructions = detail(page).getByRole('textbox', { name: '通用执行 的指令' });
  await instructions.fill('先写结论。');
  await agentList(page).locator('[data-agent-id="coordinator"]').click();
  const card = page.getByRole('dialog', { name: '放弃未保存的修改？' });
  await card.getByRole('button', { name: '继续编辑' }).click();
  await expect(instructions).toHaveValue('先写结论。');
  await agentList(page).locator('[data-agent-id="coordinator"]').click();
  await card.getByRole('button', { name: '放弃修改' }).click();
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('Multivac（协调）');
});
