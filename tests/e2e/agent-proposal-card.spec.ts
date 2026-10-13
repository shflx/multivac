import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';

/**
 * 对话里提议新建智能体：Fake 按消息脚本调用 `propose_create_agent`，走真实的注册表、提议服务与
 * 智能体服务。卡上写全配置与提议时的模型名，确认前什么也不建；确认后登记，能在设置 · 智能体中
 * 看到，回执带“打开设置 · 智能体”；模型不可用的卡写明原因、不能确认。
 */

const home = (page: Page) => page.locator('.work-surface').first();
const agentsPage = (page: Page) => page.getByRole('main', { name: '智能体' });
const agentList = (page: Page) => agentsPage(page).getByRole('list', { name: '智能体列表' });
const card = (scope: Locator, toolCallId: string) => scope.locator(`.proposal-card[data-tool-call-id="${toolCallId}"]`);

interface ListedAgent { agentId: string; name: string; modelProfileId: string | null; thinkingLevel: string | null; instructions: string }

async function listAgents(request: APIRequestContext): Promise<ListedAgent[]> {
  const response = await request.get(`${fakeApiRoot}/api/agents`);
  expect(response.ok()).toBe(true);
  return (await response.json() as { agents: ListedAgent[] }).agents;
}

async function send(scope: Locator, text: string): Promise<void> {
  const replies = scope.locator('article.chat-row.assistant');
  const before = await replies.count();
  const draft = scope.getByLabel('Multivac 草稿');
  await draft.fill(text);
  await draft.press('Enter');
  await expect.poll(() => replies.count()).toBeGreaterThan(before);
  await expect(scope.getByRole('button', { name: '取消当前处理' })).toHaveCount(0);
}

/** 让 Multivac 提议新建智能体；返回工具调用 id（卡片据此定位）。 */
async function propose(scope: Locator, args: Record<string, unknown>): Promise<string> {
  const toolCallId = `e2e-agent-proposal-${crypto.randomUUID()}`;
  await send(scope, `帮我建一个智能体\n内部工具：propose_create_agent#${toolCallId} ${JSON.stringify(args)}`);
  await expect(card(scope, toolCallId)).toHaveCount(1);
  return toolCallId;
}

async function openAgentsPage(page: Page): Promise<void> {
  await expect(agentList(page)).toBeVisible();
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  const current = await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json() as { revision: number };
  await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
    data: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: current.revision },
  });
  await page.goto('/');
  await expect(home(page).getByLabel('Multivac 草稿')).toBeEditable();
});

test('提议新建智能体：卡上写全配置，确认前不登记；确认后出现在设置 · 智能体，回执打开该页', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const toolCallId = await propose(home(page), {
    name: '资料整理', description: '调研与资料整理', modelProfileId: 'fixture-anthropic', thinkingLevel: 'high', instructions: '保留来源。',
  });

  const pending = card(home(page), toolCallId);
  await expect(pending).toHaveAttribute('data-status', 'pending');
  await expect(pending).toHaveAccessibleName('待确认：新建智能体「资料整理」');
  await expect(pending.locator('.receipt-title')).toContainText('确认后登记为智能体，可在新建任务时选用');
  await expect(pending.locator('dl')).toContainText('名称资料整理');
  await expect(pending.locator('dl')).toContainText('说明调研与资料整理');
  // 模型写法与设置 · 智能体一致：显示模型名与推理等级，而不是配置 id。
  await expect(pending.locator('dl')).toContainText('模型Claude Fixture · 推理 高');
  await expect(pending.locator('dl')).toContainText('指令保留来源。');
  await expect(pending.locator('dl')).toContainText('边界智能体是执行配置，不改变权限边界。');
  await expect(pending.getByRole('button', { name: '取消' })).toBeEnabled();
  await expect(pending.getByRole('button', { name: '创建智能体' })).toBeEnabled();
  expect((await listAgents(request)).map((agent) => agent.name)).toEqual(['Multivac（协调）', '通用执行']);
  await page.screenshot({ path: testInfo.outputPath('agent-proposal-card.png'), fullPage: true });

  // 确认：登记为智能体，回执写明结果与入口；刷新后状态一致。
  await pending.getByRole('button', { name: '创建智能体' }).click();
  await expect(pending).toHaveAttribute('data-status', 'executed');
  await expect(pending).toHaveAccessibleName('已创建智能体「资料整理」');
  await expect(pending).toContainText('已创建智能体「资料整理」');
  await expect(pending).toContainText('模型：Claude Fixture · high；可在新建任务时选用，修改或删除请到设置 · 智能体');
  const agents = await listAgents(request);
  expect(agents.find((agent) => agent.name === '资料整理')).toMatchObject({
    modelProfileId: 'fixture-anthropic', thinkingLevel: 'high', instructions: '保留来源。',
  });

  await page.reload();
  await expect(card(home(page), toolCallId)).toHaveAttribute('data-status', 'executed');

  // 回执上的入口直接到设置 · 智能体，新智能体在列表里。
  await card(home(page), toolCallId).getByRole('button', { name: '打开设置 · 智能体' }).click();
  await openAgentsPage(page);
  await expect(agentList(page)).toContainText('资料整理');
});

test('不适用的提议：模型不可用的卡写明原因、确认按钮不可用；取消后什么也不建', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const blocked = card(home(page), await propose(home(page), { name: '临时助手', modelProfileId: 'fixture-missing-auth' }));
  await expect(blocked).toHaveAttribute('data-status', 'pending');
  await expect(blocked).toContainText('不能保存为智能体的模型：');
  await expect(blocked.getByRole('button', { name: '创建智能体' })).toBeDisabled();

  // 取消：卡原地变为已取消，服务端与列表里都没有新智能体。
  const cancelledToolCallId = await propose(home(page), { name: '不要的助手', modelProfileId: 'fixture-openai' });
  const cancelled = card(home(page), cancelledToolCallId);
  await cancelled.getByRole('button', { name: '取消' }).click();
  await expect(cancelled).toHaveAttribute('data-status', 'cancelled');
  await expect(cancelled).toHaveAccessibleName('已取消：新建智能体「不要的助手」');
  await expect(cancelled).toContainText('没有做任何改动。');
  expect((await listAgents(request)).map((agent) => agent.name)).toEqual(['Multivac（协调）', '通用执行']);
  await page.reload();
  await expect(card(home(page), cancelledToolCallId)).toHaveAttribute('data-status', 'cancelled');

  // 取消后不能靠接口再确认：服务端报冲突，仍没有新智能体。
  const proposal = (await (await request.get(`${fakeApiRoot}/api/assistant/proposals`)).json() as {
    proposals: Array<{ proposalId: string; title: string; status: string }>;
  }).proposals.find((item) => item.title === '新建智能体「不要的助手」')!;
  expect(proposal.status).toBe('cancelled');
  const decision = await request.post(`${fakeApiRoot}/api/assistant/proposals/${proposal.proposalId}/decision`, { data: { decision: 'confirm' } });
  expect(decision.status()).toBe(409);
  expect((await listAgents(request)).map((agent) => agent.name)).toEqual(['Multivac（协调）', '通用执行']);
});
