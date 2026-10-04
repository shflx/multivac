import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ToolAuthorizationRequest, WorkspaceSession } from '@multivac/contracts';
import { escapeFromManagement, fakeApiRoot, openCreationDialog, openPanel, resetE2eState, workspaceRail, setWorkspaceMode, ensureWorkspaceRail } from './test-state.js';

/**
 * 记住的授权：授权卡上的“本会话内允许 / 本项目内始终允许”、之后同类操作直接放行（运行轨迹注明依据、不出卡片）、
 * 重启后仍然有效；按归属查看与撤销：会话授权窗口“本会话已允许”、会话标题栏工作目录里的“本会话已允许 N 项”、
 * 项目详情“权限 · 已记住的授权”，以及会话授权窗口按会话列出的“最近的授权请求”。
 * Fake 的越界写入场景每次写入同一目录中的新文件，越界读取场景读取同一目录中的文件。
 */

const workspaceBar = (page: Page) => page.locator('.workspace-page');
const switcherTrigger = (page: Page) => workspaceRail(page).locator('.rail-folder.active .rail-folder-toggle');
const switcherMenu = (page: Page) => workspaceRail(page);
const cards = (scope: Locator) => scope.getByRole('region', { name: /^工具授权：/u });
const card = (scope: Locator, request: ToolAuthorizationRequest) =>
  cards(scope).and(scope.locator(`[data-request-id="${request.requestId}"]`));
const toolRow = (scope: Locator, request: ToolAuthorizationRequest) =>
  scope.locator(`.run-trace-tool[data-tool-call-id="${request.toolCallId}"]`);
const navigation = (page: Page) => page.getByRole('complementary', { name: '管理导航' });
const sessionDetail = (page: Page) => page.getByRole('dialog', { name: /的授权$/ });
async function openAuthorizations(page: Page, title: string) {
  await openPanel(page, 'workspace');
  await panel(page, title).getByRole('button', { name: `「${title}」的更多操作` }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: '授权', exact: true }).click();
}
const projectsPage = (page: Page) => page.getByRole('main', { name: '项目' });
const projectDetail = (page: Page) => projectsPage(page).locator('.project-detail');
const revokeDialog = (page: Page) => page.getByRole('dialog', { name: '撤销这项授权？' });
/** 会话标题栏的工作目录与展开后的说明。 */
const directoryTrigger = (scope: Locator) => scope.getByRole('button', { name: /^工作目录：/u });
const directoryDetail = (page: Page) => page.getByRole('dialog', { name: '本会话的工作目录' });

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
  await openPanel(page, 'workspace');
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
  await expect(current.locator('.authorization-actions').getByRole('button')).toHaveText(['拒绝', '仅这一次', '本会话内允许']);
  await expect(current.getByRole('button', { name: '本会话内允许' })).toHaveClass(/secondary-button/);
  await expect(current.locator('.authorization-remember'))
    .toContainText(`选择记住时，之后修改或写入 ${directory}/ 中的文件（含子目录）不再确认`);
  await expect(current.locator('.authorization-remember')).not.toContainText('本项目内');

  await current.getByRole('button', { name: '本会话内允许' }).click();
  await expect(current).toContainText(`已批准（本会话内）：之后本会话修改或写入 ${directory}/ 中的文件不再确认`);
  await expect(current.locator('.authorization-actions').getByRole('button')).toHaveCount(0);
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

  // 重启后：记住的决定仍然有效（Fake 的消息历史只在内存中，重启前的轮次不再显示），标题栏的工作目录里仍可见。
  await restartServer(request);
  await page.reload();
  await openPanel(page, 'workspace');
  const afterRestart = await sendAndRecord(scope, request, sessionId);
  await expectRemembered(scope, afterRestart, '本会话内');
  await expect(scope.locator('.authorization-card.pending')).toHaveCount(0);
  await directoryTrigger(scope).click();
  await expect(directoryDetail(page).getByRole('button', { name: '本会话已允许 1 项' })).toBeEnabled();
});

test('本项目内始终允许：在同一项目的另一个会话中生效，不再出卡', async ({ page, request }) => {
  const created = await request.post(`${fakeApiRoot}/api/projects`, { data: { name: '授权项目' } });
  expect(created.status()).toBe(201);
  await page.reload();
  await openPanel(page, 'workspace');
  await ensureWorkspaceRail(page);
  await switcherMenu(page).getByRole('button', { name: /^授权项目/ }).click();
  await expect(switcherTrigger(page)).toContainText('授权项目');

  const firstId = await createSession(page, '项目甲');
  const secondId = await createSession(page, '项目乙');
  await setWorkspaceMode(page, 'parallel');
  await expect(page.locator('.conversation-panel')).toHaveCount(2);
  const first = panel(page, '项目甲');
  const second = panel(page, '项目乙');

  // 并排时非当前会话的输入区折叠，先切到甲。
  await first.getByRole('button', { name: '在「项目甲」中继续' }).click();
  const pending = await sendAndRecord(first, request, firstId);
  const current = card(first, pending);
  await expect(current.locator('.authorization-actions').getByRole('button')).toHaveText(['拒绝', '仅这一次', '本会话内允许', '本项目内始终允许']);
  await expect(current.getByRole('button', { name: '本项目内始终允许' })).toHaveClass(/secondary-button/);
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

/** 撤销一行：确认卡的标题、说明与要点按原型；先取消一次（不撤销），再确认。 */
async function revokeRow(page: Page, row: Locator, subject: string, scopeLabel: string): Promise<void> {
  const button = row.getByRole('button', { name: '撤销' });
  // 普通的小号次要按钮，不用危险色。
  await expect(button).toHaveClass(/secondary-button/);
  await expect(button).toHaveClass(/compact/);
  await expect(button).not.toHaveClass(/danger/);
  await button.click();
  const dialog = revokeDialog(page);
  await expect(dialog.locator('.confirm-card-head p')).toHaveText(`撤销「${subject}」（${scopeLabel}）。`);
  await expect(dialog.locator('.confirm-card-details li')).toHaveText(['撤销后同类操作重新需要你确认。', '已经执行过的操作不受影响。']);
  await expect(dialog.getByRole('button', { name: '撤销', exact: true })).toHaveClass(/primary-button/);
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(1);
  await button.click();
  await dialog.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

/** 在会话中再次越界写入：同类操作重新出卡，拒绝后结束这一轮。 */
async function expectCardAgain(scope: Locator, request: APIRequestContext, sessionId: string): Promise<void> {
  const again = await sendAndRecord(scope, request, sessionId);
  expect(again.status).toBe('pending');
  await expect(card(scope, again).getByRole('button', { name: '本会话内允许' })).toBeVisible();
  await card(scope, again).getByRole('button', { name: '拒绝' }).click();
  await expect(card(scope, again)).toContainText('已拒绝');
}

test('归档授权：“本会话已允许”与按会话的“最近的授权请求”（结果与批准依据）重启后仍可见；撤销后即时生效，同类操作再次出卡', async ({ page, request }) => {
  test.setTimeout(60_000);
  const sessionId = await createSession(page, '撤销授权');
  const scope = panel(page, '撤销授权');
  const first = await sendAndRecord(scope, request, sessionId);
  const directory = dirname(first.targetPath);
  await card(scope, first).getByRole('button', { name: '本会话内允许' }).click();
  await expect(scope.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  const second = await sendAndRecord(scope, request, sessionId);
  await expectRemembered(scope, second, '本会话内');
  // 读取另算：先批准仅这一次，再一次拒绝。
  const readOnce = await sendAndRecord(scope, request, sessionId, '越界读取场景');
  await card(scope, readOnce).getByRole('button', { name: '仅这一次' }).click();
  await expect(card(scope, readOnce)).toContainText('已批准（仅这一次）');
  await expect(scope.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  const readDenied = await sendAndRecord(scope, request, sessionId, '越界读取场景');
  await card(scope, readDenied).getByRole('button', { name: '拒绝' }).click();
  await expect(card(scope, readDenied)).toContainText('已拒绝');

  // 重启后打开设置 · 归档：两节都从服务端读取，仍然可见。
  await restartServer(request);
  expect((await request.post(`${fakeApiRoot}/api/sessions/${sessionId}/archive`)).ok()).toBe(true);
  await page.reload();
  await openPanel(page, 'management');
  const archive = page.getByRole('main', { name: '归档' });
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '归档', exact: true }).click();
  await archive.getByRole('button', { name: '授权', exact: true }).click();

  // 本会话已允许：主题是类别与放行目录（长路径中间截断，完整路径在悬停提示里），说明是“目录 · 范围 · 记住于 …”与最近使用。
  const grants = sessionDetail(page).getByRole('region', { name: '本会话已允许' });
  const row = grants.getByRole('list', { name: '本会话已允许' }).getByRole('listitem');
  await expect(row).toHaveCount(1);
  const subject = row.locator('strong');
  await expect(subject).toHaveAttribute('title', `修改或写入 ${directory}/ 中的文件（含子目录）`);
  await expect(subject).toHaveText(/^修改或写入 .*multivac-outside\/$/u);
  expect(Array.from((await subject.textContent())!.slice('修改或写入 '.length)).length)
    .toBeLessThanOrEqual(40);
  await expect(row.locator('small'))
    .toHaveText(/^目录 · 本会话内允许 · 记住于 \d+\/\d+ \d{2}:\d{2} · 最近使用 \d+\/\d+ \d{2}:\d{2}（共 1 次）$/u);

  // 最近的授权请求：只含本会话的，最近的在前，写明结果与批准依据；只读。
  const history = sessionDetail(page).getByRole('region', { name: '最近的授权请求' });
  await expect(history.locator('.section-title')).toContainText('最近 50 条，只读');
  const requests = history.getByRole('list', { name: '最近的授权请求' }).getByRole('listitem');
  await expect(requests).toHaveCount(4);
  await expect(requests.locator('small')).toHaveText([
    /^已拒绝 · /u,
    /^已批准（仅这一次） · /u,
    /^按已记住的授权放行（本会话内） · /u,
    /^已批准（本会话内） · /u,
  ]);
  await expect(requests.nth(0).locator('strong')).toHaveAttribute('title', `读取 ${readDenied.targetPath}`);
  await expect(requests.nth(2).locator('strong')).toHaveAttribute('title', `写入 ${second.targetPath}`);
  await expect(history.getByRole('button')).toHaveCount(0);

  // 撤销：确认后这一行消失，焦点落在小节上，接口中没有了。
  await revokeRow(page, row, `修改或写入 ${directory}/`, '本会话内允许');
  await expect(grants.getByRole('list')).toHaveCount(0);
  await expect(grants).toContainText('这个会话还没有记住的授权。在授权卡上选“本会话内允许”后会出现在这里，可以随时撤销。');
  await expect(grants).toBeFocused();
  expect((await (await request.get(`${fakeApiRoot}/api/authorization-grants`)).json()).grants).toEqual([]);

  // 回到工作区（重启后从首页进入的管理，Esc 回到首页）：同类操作再次出现授权卡；标题栏的工作目录里同样没有了。
  await sessionDetail(page).getByRole('button', { name: '关闭授权' }).click();
  await archive.getByRole('button', { name: '恢复并打开' }).click();
  await directoryTrigger(scope).click();
  await expect(directoryDetail(page).getByRole('button', { name: '本会话已允许 0 项' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expectCardAgain(scope, request, sessionId);
});

test('标题栏的工作目录：“本会话已允许 N 项”没有时置灰，有时展开查看并撤销；三处同步，同类操作再次出卡', async ({ page, request }) => {
  const sessionId = await createSession(page, '标题栏授权');
  const scope = panel(page, '标题栏授权');
  await directoryTrigger(scope).click();
  const none = directoryDetail(page).getByRole('button', { name: '本会话已允许 0 项' });
  await expect(none).toBeDisabled();
  await expect(none).not.toHaveAttribute('aria-expanded');
  await page.keyboard.press('Escape');

  const first = await sendAndRecord(scope, request, sessionId);
  const directory = dirname(first.targetPath);
  await card(scope, first).getByRole('button', { name: '本会话内允许' }).click();
  await expect(card(scope, first)).toContainText('可在会话标题栏的“授权”或“设置 · 归档”的授权入口中撤销');
  await expect(scope.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();

  // 授权窗口先看到这条授权（应用内授权数据共享，之后在标题栏撤销时一起更新）。
  await openAuthorizations(page, '标题栏授权');
  const grants = sessionDetail(page).getByRole('region', { name: '本会话已允许' });
  await expect(grants.getByRole('listitem')).toHaveCount(1);
  await sessionDetail(page).getByRole('button', { name: '关闭授权' }).click();

  // 打开说明时重新读取：一行计数，点开是可撤销的列表。
  await directoryTrigger(scope).click();
  const detail = directoryDetail(page);
  const toggle = detail.getByRole('button', { name: '本会话已允许 1 项' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const row = detail.getByRole('list', { name: '本会话已允许' }).getByRole('listitem');
  await expect(row).toHaveCount(1);
  await expect(row.locator('strong')).toHaveAttribute('title', `修改或写入 ${directory}/ 中的文件（含子目录）`);
  await expect(row.locator('small')).toHaveText(/^目录 · 本会话内允许 · 记住于 .* · 还没有用过$/u);
  // 说明与列表都不越出本栏。
  const panelBox = (await scope.boundingBox())!;
  const detailBox = (await detail.boundingBox())!;
  expect(detailBox.x + detailBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);

  // 撤销：确认卡上的操作不会收起说明；撤销后计数置灰，焦点留在说明里。
  await revokeRow(page, row, `修改或写入 ${directory}/`, '本会话内允许');
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('button', { name: '本会话已允许 0 项' })).toBeDisabled();
  await expect(detail.getByRole('list')).toHaveCount(0);
  await expect(detail).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);

  // 同一个页面应用里，授权窗口随之更新。
  await openAuthorizations(page, '标题栏授权');
  await expect(grants.getByRole('list')).toHaveCount(0);
  await expect(grants).toContainText('这个会话还没有记住的授权。');
  await sessionDetail(page).getByRole('button', { name: '关闭授权' }).click();
  await expectCardAgain(scope, request, sessionId);
});

test('项目详情：“权限 · 已记住的授权”列出本项目内的授权，撤销后同类操作再次出卡；授权窗口不列项目范围的授权', async ({ page, request }) => {
  const created = await request.post(`${fakeApiRoot}/api/projects`, { data: { name: '撤销项目' } });
  expect(created.status()).toBe(201);
  await page.reload();
  await openPanel(page, 'workspace');
  await ensureWorkspaceRail(page);
  await switcherMenu(page).getByRole('button', { name: /^撤销项目/ }).click();
  await expect(switcherTrigger(page)).toContainText('撤销项目');
  const sessionId = await createSession(page, '项目会话');
  const scope = panel(page, '项目会话');

  const first = await sendAndRecord(scope, request, sessionId);
  const directory = dirname(first.targetPath);
  const current = card(scope, first);
  await expect(current.locator('.authorization-remember')).toContainText(
    '本会话内的可在会话标题栏的“授权”或“设置 · 归档”的授权入口中撤销，本项目内的在“设置 · 项目”的“权限”中撤销。',
  );
  await current.getByRole('button', { name: '本项目内始终允许' }).click();
  await expect(current).toContainText('可在“设置 · 项目”的“权限”中撤销');
  await expect(scope.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();

  // 授权窗口：本会话已允许里没有项目范围的授权；最近的请求写明“本项目内”。
  await openAuthorizations(page, '项目会话');
  const sessionGrants = sessionDetail(page).getByRole('region', { name: '本会话已允许' });
  await expect(sessionGrants).toContainText('这个会话还没有记住的授权。');
  await expect(sessionDetail(page).getByRole('region', { name: '最近的授权请求' }).getByRole('listitem').locator('small'))
    .toHaveText([/^已批准（本项目内） · /u]);

  await sessionDetail(page).getByRole('button', { name: '关闭授权' }).click();
  await openPanel(page, 'management');
  // 设置 · 项目：权限小节只放“已记住的授权”。
  await navigation(page).getByRole('button', { name: '项目' }).click();
  const permissions = projectDetail(page).getByRole('region', { name: '权限' });
  await expect(permissions.getByRole('heading', { level: 4 })).toHaveText(['已记住的授权']);
  const row = permissions.getByRole('list', { name: '已记住的授权' }).getByRole('listitem');
  await expect(row).toHaveCount(1);
  await expect(row.locator('strong')).toHaveAttribute('title', `修改或写入 ${directory}/ 中的文件（含子目录）`);
  await expect(row.locator('small')).toHaveText(/^目录 · 本项目内始终允许 · 记住于 .* · 还没有用过$/u);

  await revokeRow(page, row, `修改或写入 ${directory}/`, '本项目内始终允许');
  await expect(permissions.getByRole('list')).toHaveCount(0);
  await expect(permissions).toContainText('本项目还没有记住的授权。在授权卡上选“本项目内始终允许”后会出现在这里，可以随时撤销。');
  await expect(permissions).toBeFocused();
  expect((await (await request.get(`${fakeApiRoot}/api/authorization-grants`)).json()).grants).toEqual([]);

  // 回到工作区：同类操作再次出现授权卡（项目会话有“本项目内”）。
  await escapeFromManagement(page);
  const again = await sendAndRecord(scope, request, sessionId);
  expect(again.status).toBe('pending');
  await expect(card(scope, again).locator('.authorization-actions').getByRole('button')).toHaveText(['拒绝', '仅这一次', '本会话内允许', '本项目内始终允许']);
  await card(scope, again).getByRole('button', { name: '拒绝' }).click();
  await expect(card(scope, again)).toContainText('已拒绝');
});
