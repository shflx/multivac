import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

interface ListedAgent { agentId: string; name: string; description: string; modelProfileId: string | null; thinkingLevel: string | null; instructions: string; revision: number }

const agentsPage = (page: Page) => page.getByRole('main', { name: '智能体' });
const agentList = (page: Page) => agentsPage(page).getByRole('list', { name: '智能体列表' });
const detail = (page: Page) => agentsPage(page).locator('.agent-detail');

async function listAgents(request: APIRequestContext): Promise<ListedAgent[]> {
  const response = await request.get(`${fakeApiRoot}/api/agents`);
  expect(response.ok()).toBe(true);
  return (await response.json() as { agents: ListedAgent[] }).agents;
}

async function openAgentsPage(page: Page): Promise<void> {
  await page.goto('/');
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '智能体', exact: true }).click();
  await expect(agentList(page)).toBeVisible();
}

test('智能体列表显示通用执行与固定的协调者，协调者只读', async ({ page, request }) => {
  await resetE2eState(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAgentsPage(page);

  await expect(agentList(page).getByRole('button')).toHaveText([/^Multivac（协调）固定配置$/, /^通用执行/]);
  // 进入页面默认选中通用执行；它可以改配置但不能删除。
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('通用执行');
  await expect(detail(page).getByRole('button', { name: '删除' })).toBeDisabled();

  await agentList(page).getByRole('button', { name: /Multivac（协调）/ }).click();
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('Multivac（协调）');
  await expect(detail(page).locator('.agent-fixed-badge')).toHaveText('固定配置');
  await expect(detail(page).getByRole('button')).toHaveCount(0);
  await expect(detail(page).locator('textarea, select, input')).toHaveCount(0);
});

test('页内新建、编辑、改模型、指令保存与还原、确认后删除', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAgentsPage(page);

  // 新建：名称必填，Esc 取消回到详情。
  await agentsPage(page).getByRole('button', { name: '新建智能体' }).click();
  const form = agentsPage(page).locator('.agent-new-form');
  await expect(form.getByRole('textbox', { name: '名称' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(form).toHaveCount(0);
  await expect(agentsPage(page).getByRole('button', { name: '新建智能体' })).toBeFocused();

  await agentsPage(page).getByRole('button', { name: '新建智能体' }).click();
  await form.getByRole('button', { name: '创建' }).click();
  await expect(form.getByRole('alert')).toHaveText('名称不能为空。');
  await form.getByRole('textbox', { name: '名称' }).fill('代码审查');
  await form.getByRole('textbox', { name: '用途' }).fill('审查代码改动');
  const modelSelect = form.getByRole('combobox', { name: '模型' });
  await expect(modelSelect).toBeEnabled();
  // 推理等级要先选模型，跟随全局默认时不可选。
  await expect(form.getByRole('combobox', { name: '推理等级' })).toBeDisabled();
  await modelSelect.selectOption('fixture-openai');
  await form.getByRole('textbox', { name: '指令' }).fill('先列风险，再给结论。');
  await form.getByRole('button', { name: '创建' }).click();
  await expect(form).toHaveCount(0);
  await expect(agentList(page).getByRole('button', { name: /代码审查/ })).toHaveAttribute('aria-current', 'true');
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('代码审查');
  let created = (await listAgents(request)).find((agent) => agent.name === '代码审查')!;
  expect(created).toMatchObject({ description: '审查代码改动', modelProfileId: 'fixture-openai', instructions: '先列风险，再给结论。' });

  // 编辑名称与用途，Esc 放弃，保存后列表同步。
  await detail(page).getByRole('button', { name: '编辑' }).click();
  await detail(page).getByRole('textbox', { name: '名称' }).fill('随手改的');
  await page.keyboard.press('Escape');
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('代码审查');
  await detail(page).getByRole('button', { name: '编辑' }).click();
  await detail(page).getByRole('textbox', { name: '名称' }).fill('安全审查');
  await detail(page).getByRole('form', { name: '编辑名称与用途' }).getByRole('button', { name: '保存' }).click();
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('安全审查');
  await expect(agentList(page).getByRole('button', { name: /安全审查/ })).toBeVisible();

  // 模型选择即改即存：改回跟随全局默认后推理等级不可选。
  await detail(page).getByRole('combobox', { name: '模型' }).selectOption('');
  await expect(detail(page).getByRole('combobox', { name: '推理等级' })).toBeDisabled();
  await expect.poll(async () => (await listAgents(request)).find((agent) => agent.agentId === created.agentId)?.modelProfileId).toBeNull();

  // 指令：改动后才能保存或还原，还原回到已保存的内容，保存后才生效。
  const instructions = detail(page).getByRole('textbox', { name: '安全审查 的指令' });
  const save = detail(page).getByRole('button', { name: '保存指令' });
  const restore = detail(page).getByRole('button', { name: '还原指令' });
  await expect(instructions).toHaveValue('先列风险，再给结论。');
  await expect(save).toBeDisabled();
  await instructions.fill('只看安全相关改动。');
  await expect(restore).toBeEnabled();
  await restore.click();
  await expect(instructions).toHaveValue('先列风险，再给结论。');
  await expect(instructions).toBeFocused();
  await expect(save).toBeDisabled();
  await instructions.fill('只看安全相关改动。');
  await save.click();
  await expect(save).toBeDisabled();
  await expect.poll(async () => (await listAgents(request)).find((agent) => agent.agentId === created.agentId)?.instructions).toBe('只看安全相关改动。');
  await page.screenshot({ path: testInfo.outputPath('agent-settings-1440.png'), animations: 'disabled' });

  // 删除要确认：取消保留，确认后回到通用执行。
  created = (await listAgents(request)).find((agent) => agent.agentId === created.agentId)!;
  await detail(page).getByRole('button', { name: '删除' }).click();
  const dialog = page.getByRole('dialog', { name: '删除智能体「安全审查」' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(agentList(page).getByRole('button', { name: /安全审查/ })).toBeVisible();
  await detail(page).getByRole('button', { name: '删除' }).click();
  await dialog.getByRole('button', { name: '删除' }).click();
  await expect(agentList(page).getByRole('button', { name: /安全审查/ })).toHaveCount(0);
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('通用执行');
  expect((await listAgents(request)).map((agent) => agent.agentId)).not.toContain(created.agentId);
});

test('仍有未完成任务的智能体不能删除，详情列出最近任务', async ({ page, request }) => {
  await resetE2eState(request);
  const agent = (await (await request.post(`${fakeApiRoot}/api/agents`, { data: { commandId: crypto.randomUUID(), name: '周报整理' } })).json()).agent as ListedAgent;
  await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: crypto.randomUUID(), title: '整理本周周报', goal: '整理本周周报', agentId: agent.agentId } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAgentsPage(page);
  await agentList(page).getByRole('button', { name: /周报整理/ }).click();
  await expect(detail(page).getByRole('list', { name: '最近任务' }).getByRole('button')).toHaveText(['整理本周周报']);

  await detail(page).getByRole('button', { name: '删除' }).click();
  const dialog = page.getByRole('dialog', { name: '删除智能体「周报整理」' });
  await dialog.getByRole('button', { name: '删除' }).click();
  await expect(dialog.getByRole('alert')).toContainText('仍有未完成的任务使用这个智能体');
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(agentList(page).getByRole('button', { name: /周报整理/ })).toBeVisible();
});
