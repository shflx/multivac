import { test, expect } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';

test('任务确认卡默认通用执行，可改选执行智能体；模型待核对的智能体不能确认；确认后任务绑定所选智能体并保留', async ({ page, request }) => {
  await resetE2eState(request);
  // 本用例会让 Claude 配置失效；先为协调者选用可用模型，不依赖前一个用例留下的选模。
  const selectionRoot = `${fakeApiRoot}/api/assistant/model-selection`;
  const snapshot = await (await request.get(selectionRoot)).json();
  expect((await request.post(`${selectionRoot}/model`, { data: {
    commandId: crypto.randomUUID(), sessionId: 'global-coordinator', revision: snapshot.selection.revision, profileId: 'fixture-openai',
  } })).ok()).toBe(true);
  const createAgent = async (name: string, modelProfileId: string) =>
    (await (await request.post(`${fakeApiRoot}/api/agents`, { data: { commandId: crypto.randomUUID(), name, modelProfileId, thinkingLevel: null, instructions: '' } })).json()).agent;
  const writer = await createAgent('写作', 'fixture-openai');
  await createAgent('失效', 'fixture-anthropic');
  // 让“失效”引用的模型变为未认证：智能体保留引用，模型状态变为待核对。
  const settings = await (await request.get(`${fakeApiRoot}/api/model-settings`)).json();
  const anthropic = settings.profiles.find((profile: { profileId: string }) => profile.profileId === 'fixture-anthropic');
  const missing = settings.profiles.find((profile: { profileId: string }) => profile.profileId === 'fixture-missing-auth');
  delete anthropic.capabilities;
  expect((await request.post(`${fakeApiRoot}/api/model-settings/profiles`, { data: { commandId: crypto.randomUUID(), revision: settings.revision,
    profile: { ...anthropic, provider: missing.provider, protocol: missing.protocol, endpoint: missing.endpoint } } })).ok()).toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const composer = page.locator('.work-surface').first().getByLabel('Multivac 草稿');
  const title = '写一篇发布说明';
  await composer.fill(`内部工具：propose_create_task#card-agent ${JSON.stringify({ title, goal: '整理本次发布的变化' })}`);
  await composer.press('Enter');
  const card = page.locator('.proposal-card').filter({ hasText: title });
  const picker = card.getByRole('combobox', { name: '执行智能体' });
  const confirm = card.getByRole('button', { name: '创建任务', exact: true });

  // 默认通用执行，跟随全局默认模型；选项里不出现固定的协调者。
  await expect(picker).toHaveValue('general');
  await expect(card.locator('.receipt-agent-summary')).toHaveText('跟随全局默认模型 · 推理：模型默认');
  await expect(picker.locator('option')).toHaveText(['通用执行', '写作', '失效']);
  await expect(confirm).toBeEnabled();

  // 改选模型待核对的智能体：写明原因，确认按钮不可用。
  await picker.focus();
  await expect(picker).toBeFocused();
  await picker.selectOption({ label: '失效' });
  await expect(card.locator('.receipt-agent-summary')).toContainText('模型待核对');
  await expect(card.locator('.move-warning')).toHaveText('执行智能体「失效」的模型待核对，不能以它执行，请改选或到设置 · 智能体修复。');
  await expect(confirm).toBeDisabled();
  await card.screenshot({ path: test.info().outputPath('task-card-agent-review.png') });

  // 改选“写作”后确认：任务绑定所选智能体，尚未启动。
  await picker.selectOption({ label: '写作' });
  await expect(card.locator('.receipt-agent-summary')).toHaveText('GPT Fixture · 推理：模型默认');
  await expect(confirm).toBeEnabled();
  await card.screenshot({ path: test.info().outputPath('task-card-agent.png') });
  await confirm.click();
  const receipt = page.locator('.proposal-card.executed').filter({ hasText: title });
  await expect(receipt).toContainText('执行智能体「写作」');
  const listed = (await (await request.get(`${fakeApiRoot}/api/tasks?query=${title}`)).json()).tasks;
  expect(listed).toHaveLength(1);
  expect(listed[0].agentId).toBe(writer.agentId);
  expect(listed[0].currentRunId).toBeNull();

  // 刷新后回执与绑定保持。
  await page.reload();
  await expect(page.locator('.proposal-card.executed').filter({ hasText: title })).toContainText('执行智能体「写作」');
  expect((await (await request.get(`${fakeApiRoot}/api/tasks/${listed[0].taskId}`)).json()).task.agentId).toBe(writer.agentId);
});
