import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ToolAuthorizationRequest, WorkspaceSession } from '@multivac/contracts';
import { fakeApiRoot, resetE2eState, openCreationDialog } from './test-state.js';

/**
 * 记住的授权：授权卡上的“本会话内允许 / 本项目内始终允许”、之后同类操作直接放行（运行轨迹注明依据、不出卡片）、
 * 重启后仍然有效。Fake 的越界写入场景每次写入同一目录中的新文件，越界读取场景读取同一目录中的文件。
 */

const workspaceBar = (page: Page) => page.getByRole('toolbar', { name: '工作区' });
const switcherTrigger = (page: Page) => workspaceBar(page).getByRole('button', { name: /^工作区/ });
const switcherMenu = (page: Page) => page.getByRole('dialog', { name: '切换工作区' });
const cards = (scope: Locator) => scope.getByRole('region', { name: /^工具授权：/u });
const card = (scope: Locator, request: ToolAuthorizationRequest) =>
  cards(scope).and(scope.locator(`[data-request-id="${request.requestId}"]`));
const toolRow = (scope: Locator, request: ToolAuthorizationRequest) =>
  scope.locator(`.run-trace-tool[data-tool-call-id="${request.toolCallId}"]`);
const recordsPage = (page: Page) => page.getByRole('main', { name: '授权记录' });
const grantList = (page: Page) => recordsPage(page).getByRole('list', { name: '记住的授权' });
const historyList = (page: Page) => recordsPage(page).getByRole('list', { name: '最近的授权请求' });

function panel(page: Page, title: string): Locator {
  return page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

async function authorizations(request: APIRequestContext, sessionId: string): Promise<ToolAuthorizationRequest[]> {
  const response = await request.get(`${fakeApiRoot}/api/sessions/${sessionId}/authorizations`);
  expect(response.status()).toBe(200);
  return (await response.json() as { requests: ToolAuthorizationRequest[] }).requests;
}

/** 在会话中发送一条消息，等到服务端多出一条授权记录（待授权或按记住的授权放行）；返回这条记录。 */
async function sendAndRecord(
  scope: Locator,
  request: APIRequestContext,
  sessionId: string,
  text = '越界写入场景',
): Promise<ToolAuthorizationRequest> {
  const before = (await authorizations(request, sessionId)).length;
  const draft = scope.getByLabel('Multivac 草稿');
  await draft.fill(text);
  await draft.press('Enter');
  await expect.poll(async () => (await authorizations(request, sessionId)).length).toBe(before + 1);
  return (await authorizations(request, sessionId)).at(-1)!;
}

async function createSession(page: Page, title: string): Promise<string> {
  await openCreationDialog(page);
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await dialog.getByLabel('会话名称').fill(title);
  const created = page.waitForResponse((response) =>
    response.url().endsWith('/api/sessions') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).toHaveCount(0);
  return (await (await created).json() as WorkspaceSession).sessionId;
}

/** 真实重启服务：旧进程返回 202 后退出，等到新进程可以提供页面状态。 */
async function restartServer(request: APIRequestContext): Promise<void> {
  expect((await request.post(`${fakeApiRoot}/api/__e2e/restart`)).status()).toBe(202);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await expect.poll(async () => {
    try {
      return (await request.get(`${fakeApiRoot}/api/assistant/page-state`, { timeout: 1_000 })).status();
    } catch {
      return 0;
    }
  }, { timeout: 30_000 }).toBe(200);
}

/** 按已记住的授权放行的一轮：没有授权卡，写入完成，工具行注明放行依据。 */
async function expectRemembered(scope: Locator, record: ToolAuthorizationRequest, scopeLabel: '本会话内' | '本项目内') {
  expect(record.status).toBe('approved');
  expect(record.approval?.source).toBe('grant');
  await expect(scope.locator('article.chat-row.assistant').last()).toContainText(`已写入 ${record.targetPath}`);
  await expect(card(scope, record)).toHaveCount(0);
  await expect(toolRow(scope, record).locator('em')).toHaveText(`已完成 · 按已记住的授权放行（${scopeLabel}）`);
  await expect(scope.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  expect(readFileSync(record.targetPath, 'utf8')).toBe('Fake 越界写入');
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  await page.goto('/');
  await page.getByRole('button', { name: '进入工作区' }).click();
});

test('本会话内允许：卡片写明记住的范围；之后同类写入不再出卡，读取仍需确认；重启后仍然有效', async ({ page, request }) => {
  test.setTimeout(60_000);
  const sessionId = await createSession(page, '记住授权');
  const scope = panel(page, '记住授权');

  const first = await sendAndRecord(scope, request, sessionId);
  expect(first.status).toBe('pending');
  const directory = dirname(first.targetPath);
  expect(first.remember).toEqual({ directory, projectId: null });
  const current = card(scope, first);
  // 不属于项目的会话没有“本项目内”，最宽的“本会话内允许”是主按钮。
  await expect(current.getByRole('button')).toHaveText(['拒绝', '仅这一次', '本会话内允许']);
  await expect(current.getByRole('button', { name: '本会话内允许' })).toHaveClass(/primary-button/);
  await expect(current.locator('.authorization-remember'))
    .toContainText(`选择记住时，之后修改或写入 ${directory}/ 中的文件（含子目录）不再确认`);
  await expect(current.locator('.authorization-remember')).not.toContainText('本项目内');

  await current.getByRole('button', { name: '本会话内允许' }).click();
  await expect(current).toContainText(`已批准（本会话内）：之后本会话修改或写入 ${directory}/ 中的文件不再确认`);
  await expect(current.getByRole('button')).toHaveCount(0);
  await expect(toolRow(scope, first).locator('em')).toHaveText('已完成 · 已批准（本会话内）');
  await expect(scope.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();

  // 同类操作：直接放行，不出卡片，状态条不出现“等待你的授权”。
  const second = await sendAndRecord(scope, request, sessionId);
  await expectRemembered(scope, second, '本会话内');
  await expect(cards(scope)).toHaveCount(1);

  // 读取是另一类，仍需确认。
  const read = await sendAndRecord(scope, request, sessionId, '越界读取场景');
  expect(read.status).toBe('pending');
  await expect(card(scope, read)).toContainText(`选择记住时，之后读取 ${directory}/ 中的文件`);
  await card(scope, read).getByRole('button', { name: '拒绝' }).click();
  await expect(card(scope, read)).toContainText('已拒绝');

  // 重启后：记住的决定仍然有效（Fake 的消息历史只在内存中，重启前的轮次不再显示）。
  await restartServer(request);
  await page.reload();
  await page.getByRole('button', { name: '进入工作区' }).click();
  const afterRestart = await sendAndRecord(scope, request, sessionId);
  await expectRemembered(scope, afterRestart, '本会话内');
  await expect(scope.locator('.authorization-card.pending')).toHaveCount(0);
});

test('本项目内始终允许：在同一项目的另一个会话中生效，不再出卡', async ({ page, request }) => {
  const created = await request.post(`${fakeApiRoot}/api/projects`, { data: { name: '授权项目' } });
  expect(created.status()).toBe(201);
  await page.reload();
  await page.getByRole('button', { name: '进入工作区' }).click();
  await switcherTrigger(page).click();
  await switcherMenu(page).getByRole('button', { name: /^授权项目/ }).click();
  await expect(switcherTrigger(page)).toContainText('授权项目');

  const firstId = await createSession(page, '项目甲');
  const secondId = await createSession(page, '项目乙');
  await workspaceBar(page).getByRole('button', { name: '并排', exact: true }).click();
  await expect(page.locator('.conversation-panel')).toHaveCount(2);
  const first = panel(page, '项目甲');
  const second = panel(page, '项目乙');

  // 并排时非当前会话的输入区折叠，先切到甲。
  await first.getByRole('button', { name: '在「项目甲」中继续' }).click();
  const pending = await sendAndRecord(first, request, firstId);
  const current = card(first, pending);
  await expect(current.getByRole('button')).toHaveText(['拒绝', '仅这一次', '本会话内允许', '本项目内始终允许']);
  await expect(current.getByRole('button', { name: '本项目内始终允许' })).toHaveClass(/primary-button/);
  await expect(current.getByRole('button', { name: '本会话内允许' })).toHaveClass(/secondary-button/);
  await expect(current.locator('.authorization-remember')).toContainText('“本项目内始终允许”作用于项目「授权项目」中的全部会话');
  await current.getByRole('button', { name: '本项目内始终允许' }).click();
  await expect(current).toContainText('已批准（本项目内始终）：之后项目中的会话修改或写入');
  await expect(toolRow(first, pending).locator('em')).toHaveText('已完成 · 已批准（本项目内）');

  // 同一项目的另一个会话：直接放行，不出卡片。
  await second.getByRole('button', { name: '在「项目乙」中继续' }).click();
  const sibling = await sendAndRecord(second, request, secondId);
  await expectRemembered(second, sibling, '本项目内');
  await expect(cards(second)).toHaveCount(0);
});

test('授权记录：列出记住的决定与最近的请求；经确认卡撤销后即时生效，同类操作再次出卡', async ({ page, request }) => {
  const sessionId = await createSession(page, '撤销授权');
  const scope = panel(page, '撤销授权');
  const first = await sendAndRecord(scope, request, sessionId);
  const directory = dirname(first.targetPath);
  await card(scope, first).getByRole('button', { name: '本会话内允许' }).click();
  await expect(scope.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  const second = await sendAndRecord(scope, request, sessionId);
  await expectRemembered(scope, second, '本会话内');

  // 管理 · 设置 · 授权记录：范围、类型、目录、作用的会话、记住时间与最近一次使用。
  await page.getByRole('button', { name: '打开管理' }).click();
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '授权记录' }).click();
  await expect(recordsPage(page).locator('.management-page-header span')).toHaveText('管理 · 设置');
  const row = grantList(page).getByRole('listitem');
  await expect(row).toHaveCount(1);
  await expect(row.locator('strong')).toHaveText(`修改或写入 ${directory}/ 中的文件`);
  await expect(row).toContainText('本会话内允许 · 会话「撤销授权」');
  await expect(row).toContainText(/记住于 \d+\/\d+ \d{2}:\d{2} · 最近使用 \d+\/\d+ \d{2}:\d{2}（共 1 次）/u);
  // 最近的授权请求（只读）：最近的在前，按记住的授权放行的一条注明依据。
  const history = historyList(page).getByRole('listitem');
  await expect(history.first()).toContainText(`写入 ${second.targetPath}`);
  await expect(history.first()).toContainText('按已记住的授权放行（本会话内） · 会话「撤销授权」');
  await expect(history.nth(1)).toContainText('已批准（本会话内）');
  await expect(historyList(page).getByRole('button')).toHaveCount(0);

  // 撤销经确认卡：取消不撤销；确认后这一行消失，焦点落在分组上。
  await row.getByRole('button', { name: '撤销' }).click();
  const dialog = page.getByRole('dialog', { name: '撤销这条记住的授权？' });
  await expect(dialog).toContainText(`本会话内允许 · 会话「撤销授权」：修改或写入 ${directory}/ 中的文件。`);
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: '撤销' }).click();
  await dialog.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(grantList(page)).toHaveCount(0);
  await expect(recordsPage(page)).toContainText('还没有记住的授权。');
  await expect(recordsPage(page).getByRole('region', { name: '记住的授权' })).toBeFocused();
  expect((await (await request.get(`${fakeApiRoot}/api/authorization-grants`)).json()).grants).toEqual([]);

  // 回到工作区：同类操作再次出现授权卡。
  await page.getByRole('button', { name: '返回工作模式' }).first().click();
  const again = await sendAndRecord(scope, request, sessionId);
  expect(again.status).toBe('pending');
  await expect(card(scope, again).getByRole('button', { name: '本会话内允许' })).toBeVisible();
  await card(scope, again).getByRole('button', { name: '拒绝' }).click();
  await expect(card(scope, again)).toContainText('已拒绝');
});
