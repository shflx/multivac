import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

const selectionRoot = `${fakeApiRoot}/api/assistant/model-selection`;
const agentsPage = (page: Page) => page.getByRole('main', { name: '智能体' });
const detail = (page: Page) => agentsPage(page).locator('.agent-detail');

async function selectCoordinatorModel(request: APIRequestContext, profileId: string): Promise<void> {
  const snapshot = await (await request.get(selectionRoot)).json();
  const response = await request.post(`${selectionRoot}/model`, { data: {
    commandId: randomUUID(), sessionId: 'global-coordinator', revision: snapshot.selection.revision, profileId,
  } });
  expect(response.ok()).toBe(true);
}

test('协调者详情说明固定原因、跟随对话所选模型，并按分组列出实际注册的内部工具', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  await selectCoordinatorModel(request, 'fixture-openai');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '智能体', exact: true }).click();
  await agentsPage(page).getByRole('list', { name: '智能体列表' }).getByRole('button', { name: /Multivac（协调）/ }).click();

  await expect(detail(page).getByRole('heading', { level: 3 })).toHaveText(['为什么不能配置', '所用模型', '内部工具']);
  await expect(detail(page).getByRole('button')).toHaveCount(0);
  await expect(detail(page).locator('textarea, select, input')).toHaveCount(0);

  // 模型不在这里配置，而是跟随 Multivac 对话的选模，对话里切换后这里同步变化。
  const model = detail(page).getByTestId('coordinator-model');
  await expect(model).toHaveText(/^GPT Fixture · 推理 /);
  await selectCoordinatorModel(request, 'fixture-anthropic');
  await expect(model).toHaveText(/^Claude Fixture · 推理 /);

  // 工具清单取自服务端实际注册的内部工具；空分组不展示，e2e 专用的示例工具落入“其他”。
  const groups = detail(page).locator('.coordinator-tools > li');
  await expect(groups.locator('strong')).toHaveText(['任务', '运行', 'Inbox', '成果', '工作区与会话', '项目', '阅读', '其他']);
  await expect(groups.filter({ hasText: /^任务/ }).locator('.coordinator-tool-names')).toContainText('新建任务');
  await expect(groups.filter({ hasText: /^其他/ }).locator('.coordinator-tool-names')).not.toBeEmpty();

  await page.screenshot({ path: testInfo.outputPath('agent-coordinator-1440.png'), fullPage: true });
});
