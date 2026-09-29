import { expect, test, type Locator, type Page } from '@playwright/test';
import { fakeApiRoot, openCreationDialog, openPanel, resetE2eState } from './test-state.js';

/**
 * 全局 Multivac 的内部工具：Fake 按消息中的脚本（“内部工具：<名称>[#<toolCallId>] [JSON 参数]”）调用，
 * 走真实的注册表、目录边界与项目 / 会话服务。全局 Multivac 可以调用，轨迹按“动作 + 对象”写工具行并附上
 * 公开的结果摘要；工作会话中没有内部工具，同名调用不可用。
 */

const home = (page: Page) => page.locator('.work-surface').first();
const toolRowSelector = (toolCallId: string) => `.run-trace-tool[data-tool-call-id="${toolCallId}"]`;
const toolRow = (scope: Locator, toolCallId: string) => scope.locator(toolRowSelector(toolCallId));
const traceOf = (scope: Locator, toolCallId: string) =>
  scope.locator('.run-trace').filter({ has: scope.page().locator(toolRowSelector(toolCallId)) });

async function send(scope: Locator, text: string): Promise<void> {
  const draft = scope.getByLabel('Multivac 草稿');
  await draft.fill(text);
  await draft.press('Enter');
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

test('全局 Multivac 调用示例内部工具：轨迹写明“列出工作区”与结果摘要，回复来自真实数据，刷新后一致', async ({ page, request }) => {
  expect((await request.post(`${fakeApiRoot}/api/projects`, { data: { name: '内部工具项目' } })).status()).toBe(201);
  const toolCallId = `e2e-list-${Date.now()}`;
  await send(home(page), `有哪些工作区？\n内部工具：list_workspaces#${toolCallId}`);

  const reply = home(page).locator('article.chat-row.assistant').filter({ hasText: '共 2 个工作区：' });
  await expect(reply).toHaveCount(1);
  await expect(reply).toContainText('「内部工具项目」');
  await expect(reply).toContainText('「默认工作区」');

  const expectTrace = async () => {
    const trace = traceOf(home(page), toolCallId);
    // 有回复后轨迹自动收起；展开查看工具行。
    if (await trace.getAttribute('open') === null) await trace.locator('summary').click();
    await expect(trace.locator('summary')).toContainText('1 个工具');
    await expect(toolRow(home(page), toolCallId).locator('span')).toHaveText('列出工作区');
    await expect(toolRow(home(page), toolCallId).locator('em')).toHaveText('已完成 · 共 2 个工作区');
    await expect(toolRow(home(page), toolCallId)).toHaveClass(/succeeded/);
  };
  await expectTrace();
  // 内部工具不产生目录授权请求。
  await expect(home(page).getByRole('region', { name: /^工具授权：/u })).toHaveCount(0);

  // 刷新：工具行与结果摘要从服务端的工具记录恢复。
  await page.reload();
  await expect(reply).toHaveCount(1);
  await expectTrace();
});

test('工作会话中没有内部工具：同名调用不可用，工具行失败，回复说明找不到', async ({ page }) => {
  await openPanel(page, 'workspace');
  await openCreationDialog(page);
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await dialog.getByLabel('会话名称').fill('内部工具不可见');
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).toHaveCount(0);
  const panel = page.locator('.conversation-panel')
    .filter({ has: page.getByRole('heading', { name: '内部工具不可见', exact: true }) });
  await expect(panel.getByLabel('Multivac 草稿')).toBeEditable();

  const toolCallId = `e2e-work-${Date.now()}`;
  await send(panel, `内部工具：list_workspaces#${toolCallId}`);
  await expect(panel.locator('article.chat-row.assistant')).toContainText('Tool list_workspaces not found');
  const trace = traceOf(panel, toolCallId);
  if (await trace.getAttribute('open') === null) await trace.locator('summary').click();
  await expect(toolRow(panel, toolCallId).locator('span')).toHaveText('列出工作区');
  await expect(toolRow(panel, toolCallId).locator('em')).toHaveText('失败');
});
