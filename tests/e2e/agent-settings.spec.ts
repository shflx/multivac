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
  const modelSelect = form.getByRole('button', { name: /^模型：/ });
  await expect(modelSelect).toBeEnabled();
  // 共用选择菜单：展示模型信息，键盘跳过不可用项，Escape 只关闭菜单。
  await expect(form.getByRole('button', { name: /^推理等级：/ })).toBeDisabled();
  await modelSelect.click();
  const modelMenu = form.getByRole('listbox', { name: '模型', exact: true });
  await expect(modelMenu.getByRole('option', { name: /^GPT Fixture/ })).toContainText('fixture / gpt-fixture');
  await expect(modelMenu.getByRole('option', { name: /不可用/ }).first()).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('agent-model-menu-1440.png'), animations: 'disabled' });
  await page.keyboard.press('End');
  await expect(modelMenu.locator('[role="option"]:not(:disabled)').last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(modelMenu).toHaveCount(0);
  await expect(form).toBeVisible();
  await expect(modelSelect).toBeFocused();
  await modelSelect.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(modelMenu.getByRole('option', { name: /^GPT Fixture/ })).toBeFocused();
  await page.keyboard.press('Enter');
  const thinkingSelect = form.getByRole('button', { name: /^推理等级：/ });
  await expect(thinkingSelect).toBeEnabled();
  await thinkingSelect.click();
  await form.getByRole('listbox', { name: '推理等级', exact: true }).getByRole('option', { name: '高', exact: true }).click();
  await form.getByRole('textbox', { name: '指令' }).fill('先列风险，再给结论。');
  await form.getByRole('button', { name: '创建' }).click();
  await expect(form).toHaveCount(0);
  await expect(agentList(page).getByRole('button', { name: /代码审查/ })).toHaveAttribute('aria-current', 'true');
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('代码审查');
  let created = (await listAgents(request)).find((agent) => agent.name === '代码审查')!;
  expect(created).toMatchObject({ description: '审查代码改动', modelProfileId: 'fixture-openai', thinkingLevel: 'high', instructions: '先列风险，再给结论。' });

  // 直接聚焦文字即可输入，保持文字宽度与模型区位置；Esc 撤销，Enter 保存，失败时保留草稿。
  const modelBeforeEdit = (await detail(page).locator('.agent-model-section').boundingBox())!;
  const titleBeforeEdit = (await detail(page).getByRole('heading', { level: 2 }).boundingBox())!;
  await expect(detail(page).getByRole('button', { name: '编辑', exact: true })).toHaveCount(0);
  const identityForm = detail(page).getByRole('form', { name: '名称与用途', exact: true });
  const nameEditor = identityForm.getByRole('textbox', { name: '名称', exact: true });
  await nameEditor.click();
  await expect(nameEditor).toBeFocused();
  await expect(identityForm.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  const nameBounds = (await nameEditor.boundingBox())!;
  expect(Math.abs(nameBounds.x - titleBeforeEdit.x)).toBeLessThanOrEqual(1);
  expect(nameBounds.width).toBeLessThan(260);
  expect(Math.abs((await detail(page).locator('.agent-model-section').boundingBox())!.y - modelBeforeEdit.y)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('agent-inline-edit-1440.png'), animations: 'disabled' });
  await nameEditor.fill('随手改的');
  await page.keyboard.press('Escape');
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('代码审查');
  await expect(nameEditor).toHaveValue('代码审查');
  await expect(nameEditor).toBeFocused();
  await nameEditor.fill('');
  await nameEditor.press('Enter');
  await expect(identityForm.getByRole('alert')).toHaveText('名称不能为空。');
  await expect(nameEditor).toBeFocused();
  await nameEditor.fill('通用执行');
  await identityForm.getByRole('textbox', { name: '用途', exact: true }).fill('未保存的用途');
  await nameEditor.press('Enter');
  await expect(identityForm.getByRole('alert')).toContainText('已有名为');
  await expect(nameEditor).toHaveValue('通用执行');
  await expect(identityForm.getByRole('textbox', { name: '用途', exact: true })).toHaveValue('未保存的用途');
  await nameEditor.fill('安全审查');
  await identityForm.getByRole('textbox', { name: '用途', exact: true }).fill('审查代码改动');
  await identityForm.getByRole('textbox', { name: '用途', exact: true }).press('Enter');
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('安全审查');
  await expect(agentList(page).getByRole('button', { name: /安全审查/ })).toBeVisible();

  // 模型选择即改即存：改回跟随全局默认后推理等级不可选。
  await detail(page).getByRole('button', { name: /^模型：/ }).click();
  await detail(page).getByRole('listbox', { name: '模型', exact: true }).getByRole('option', { name: /^跟随全局默认/ }).click();
  await expect(detail(page).getByRole('button', { name: /^推理等级：/ })).toBeDisabled();
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

  // 窄容器里控件堆叠，菜单留在视口内；点击其他字段关闭菜单。
  await page.setViewportSize({ width: 900, height: 820 });
  await detail(page).getByRole('button', { name: /^模型：/ }).click();
  const narrowMenu = detail(page).getByRole('listbox', { name: '模型', exact: true });
  const bounds = (await narrowMenu.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(900);
  await page.screenshot({ path: testInfo.outputPath('agent-model-menu-900.png'), animations: 'disabled' });
  await instructions.click();
  await expect(narrowMenu).toHaveCount(0);
  const descriptionEditor = identityForm.getByRole('textbox', { name: '用途', exact: true });
  await descriptionEditor.click();
  await expect(descriptionEditor).toBeFocused();
  const longDescription = '审查代码改动，检查边界条件、可维护性与潜在风险，并结合上下文给出具体的改进建议。';
  await descriptionEditor.fill(longDescription);
  await descriptionEditor.press('Shift+Enter');
  await page.keyboard.insertText('先列证据，再给结论。');
  await expect(descriptionEditor).toHaveValue(`${longDescription}\n先列证据，再给结论。`);
  expect((await descriptionEditor.boundingBox())!.height).toBeGreaterThan(40);
  expect(await descriptionEditor.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('agent-inline-edit-900.png'), animations: 'disabled' });
  await identityForm.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(descriptionEditor).toHaveValue('审查代码改动');
  await expect(identityForm.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });

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

test('详情不展示最近任务，仍有未完成任务的智能体不能删除', async ({ page, request }) => {
  await resetE2eState(request);
  const agent = (await (await request.post(`${fakeApiRoot}/api/agents`, { data: { commandId: crypto.randomUUID(), name: '周报整理' } })).json()).agent as ListedAgent;
  await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: crypto.randomUUID(), title: '整理本周周报', goal: '整理本周周报', agentId: agent.agentId } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAgentsPage(page);
  await agentList(page).getByRole('button', { name: /周报整理/ }).click();
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('周报整理');
  await expect(detail(page).getByRole('heading', { name: '最近任务', exact: true })).toHaveCount(0);
  await expect(detail(page).getByRole('list', { name: '最近任务' })).toHaveCount(0);

  await detail(page).getByRole('button', { name: '删除' }).click();
  const dialog = page.getByRole('dialog', { name: '删除智能体「周报整理」' });
  await dialog.getByRole('button', { name: '删除' }).click();
  await expect(dialog.getByRole('alert')).toContainText('仍有未完成的任务使用这个智能体');
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(agentList(page).getByRole('button', { name: /周报整理/ })).toBeVisible();
});
