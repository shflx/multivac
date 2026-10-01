import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, openCreationDialog, openPanel, resetE2eState, workspaceRail, currentWorkspaceGroup, ensureWorkspaceRail, setWorkspaceMode, railSessionAction } from './test-state.js';

const workspaceBar = (page: Page) => page.locator('.workspace-page');
const homeDraft = (page: Page) => page.locator('.work-surface').first().getByLabel('Multivac 草稿');

async function enterWorkspace(page: Page): Promise<void> {
  await openPanel(page, 'workspace');
  await expect(workspaceBar(page)).toBeVisible();
}

async function createSession(page: Page, title: string): Promise<void> {
  await openCreationDialog(page);
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await dialog.getByLabel('会话名称').fill(title);
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).toHaveCount(0);
}

function panel(page: Page, title: string) {
  return page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

async function openSessionMenu(page: Page) {
  await ensureWorkspaceRail(page);
  const menu = currentWorkspaceGroup(page);
  await expect(menu).toBeVisible();
  return menu;
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  const current = await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json() as { revision: number };
  await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
    data: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: current.revision },
  });
  await page.goto('/');
  await expect(homeDraft(page)).toBeEditable();
});

test('空状态打开新建对话框：名称输入框保持焦点，取消后焦点回到打开它的按钮', async ({ page }) => {
  await enterWorkspace(page);
  const emptyCreate = page.locator('.workspace-empty').getByRole('button', { name: '新会话' });
  await emptyCreate.click();

  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  const nameInput = dialog.getByLabel('会话名称');
  await expect(nameInput).toBeFocused();
  // 打开后的后续渲染不得把焦点抢回按钮。
  await page.waitForTimeout(600);
  await expect(nameInput).toBeFocused();
  await page.keyboard.type('逐字输入');
  await expect(nameInput).toHaveValue('逐字输入');

  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(emptyCreate).toBeFocused();
});

test('空工作区提供新会话；新建后出现在列表并聚焦，刷新后列表仍在', async ({ page }) => {
  await enterWorkspace(page);
  await expect(page.getByRole('heading', { name: '默认工作区还没有会话' })).toBeVisible();
  await expect(currentWorkspaceGroup(page).locator('.rail-item')).toHaveCount(0);
  // 工作区条不单设新会话按钮，统一从会话列表新建。
  await expect(workspaceRail(page).getByRole('button', { name: '在「默认工作区」新建会话' })).toBeVisible();

  // 空状态里的“新会话”同样可以新建。
  await page.locator('.workspace-empty').getByRole('button', { name: '新会话' }).click();
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await expect(dialog.getByRole('button', { name: '创建' })).toBeDisabled();
  await dialog.getByLabel('会话名称').fill('梳理导航结构');
  await dialog.getByRole('button', { name: '创建' }).click();

  const created = panel(page, '梳理导航结构');
  await expect(created).toBeVisible();
  await expect(created).toHaveClass(/active/);
  await expect(created.getByLabel('Multivac 草稿')).toBeFocused();
  await expect(workspaceRail(page).getByRole('radio', { name: '聚焦：只看当前会话', includeHidden: true })).toHaveAttribute('aria-checked', 'true');

  await createSession(page, '核对接口');
  const menu = await openSessionMenu(page);
  await expect(menu.locator('.rail-item')).toHaveCount(2);
  // 新会话放进第一栏，原来的会话后移；列表标出各自所在的栏。
  await expect(menu.locator('.rail-item').filter({ hasText: '核对接口' }).locator('small')).toHaveText('1');
  await expect(menu.locator('.rail-item').filter({ hasText: '梳理导航结构' }).locator('small')).toHaveText('2');

  await page.reload();
  await enterWorkspace(page);
  const reloaded = await openSessionMenu(page);
  // 列表顺序即工作区现场里的展示顺序，刷新后保持不变。
  await expect(reloaded.locator('.rail-session-open .nav-label')).toHaveText(['核对接口', '梳理导航结构']);
});

test('会话列表指定每一栏展示哪个会话：替换该栏、已在另一栏时互换，点会话名聚焦查看', async ({ page }) => {
  await enterWorkspace(page);
  for (const title of ['会话一', '会话二', '会话三']) await createSession(page, title);

  await setWorkspaceMode(page, 'parallel');
  await expect(page.locator('.conversation-panel')).toHaveCount(2);
  await expect(page.locator('.conversation-panel h2')).toHaveText(['会话三', '会话二']);
  await expect(page.locator('.conversation-panel .slot-tag')).toHaveText(['第 1 栏', '第 2 栏']);

  let menu = await openSessionMenu(page);
  await expect(workspaceRail(page).getByRole('radio', { name: '并排 2 栏', includeHidden: true })).toHaveAttribute('aria-checked', 'true');
  const row = (title: string) => menu.locator('.rail-item').filter({ hasText: title });
  await expect(row('会话一').locator('small')).toHaveCount(0);
  await expect(row('会话一').getByRole('button', { name: '更多「会话一」' })).toBeVisible();
  await railSessionAction(page, '会话一', 2);
  await expect(menu).toBeVisible();
  await expect(page.locator('.conversation-panel h2')).toHaveText(['会话三', '会话一']);
  await expect(panel(page, '会话一')).toHaveClass(/active/);
  await expect(currentWorkspaceGroup(page).locator('.rail-item')).toHaveCount(3);

  // 已在另一栏的会话放进第 1 栏：两栏互换。
  menu = await openSessionMenu(page);
  await expect(row('会话一').locator('small')).toHaveText('2');
  await expect(row('会话二').locator('small')).toHaveCount(0);
  await railSessionAction(page, '会话一', 1);
  await expect(page.locator('.conversation-panel h2')).toHaveText(['会话一', '会话三']);

  // 点会话名聚焦查看，栏位不变；聚焦中选栏会切回并排。
  menu = await openSessionMenu(page);
  await row('会话二').locator('.rail-session-open').click();
  await expect(workspaceRail(page).getByRole('radio', { name: '聚焦：只看当前会话', includeHidden: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.conversation-panel h2')).toHaveText(['会话二']);
  await expect(page.locator('.conversation-panel .slot-tag')).toHaveCount(0);
  menu = await openSessionMenu(page);
  await expect(row('会话二')).toHaveClass(/selected/);
  await railSessionAction(page, '会话二', 2);
  await expect(workspaceRail(page).getByRole('radio', { name: '并排 2 栏', includeHidden: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.conversation-panel h2')).toHaveText(['会话一', '会话二']);
  await expect(panel(page, '会话二')).toHaveClass(/active/);

  // 栏位随现场保存，刷新后恢复。
  await expect.poll(async () => (await (await page.request.get(`${fakeApiRoot}/api/workspaces/default/scene`)).json()).scene.slots.length)
    .toBe(2);
  await page.reload();
  await enterWorkspace(page);
  await expect(page.locator('.conversation-panel h2')).toHaveText(['会话一', '会话二']);
});

test('会话列表中改名与归档，归档后从工作区移除', async ({ page }) => {
  await enterWorkspace(page);
  await createSession(page, '待改名');
  await createSession(page, '待归档');

  let menu = await openSessionMenu(page);
  await railSessionAction(page, '待改名', '改名');
  const input = menu.getByLabel('会话名称');
  await input.fill('已改名的会话');
  await input.press('Enter');
  await expect(menu.locator('.rail-session-open .nav-label')).toContainText(['已改名的会话']);

  await railSessionAction(page, '待归档', '归档');
  await page.getByRole('dialog', { name: '归档「待归档」' }).getByRole('button', { name: '归档', exact: true }).click();
  await expect(menu.locator('.rail-item')).toHaveCount(1);
  await expect(page.locator('.conversation-panel h2')).toHaveText(['已改名的会话']);

  await page.reload();
  await enterWorkspace(page);
  menu = await openSessionMenu(page);
  await expect(menu.locator('.rail-session-open .nav-label')).toHaveText(['已改名的会话']);
});

test('工作区与 Multivac 首页来回切换，两边草稿与阅读位置保留；快捷键切换工作区条', async ({ page }) => {
  const scroll = page.locator('.work-surface').first().locator('.message-scroll');
  await scroll.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 300);
    element.dispatchEvent(new Event('scroll'));
  });
  const readingTop = await scroll.evaluate((element) => element.scrollTop);
  await homeDraft(page).fill('首页草稿');

  await enterWorkspace(page);
  await createSession(page, '切换会话');
  const sessionDraft = panel(page, '切换会话').getByLabel('Multivac 草稿');
  await sessionDraft.fill('工作会话草稿');

  await openPanel(page, 'home');
  await expect(homeDraft(page)).toBeVisible();
  await expect(homeDraft(page)).toHaveValue('首页草稿');
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(readingTop, 0);

  await enterWorkspace(page);
  await expect(sessionDraft).toHaveValue('工作会话草稿');

  // Cmd/Ctrl+\ 隐藏与恢复工作区条；首页不响应该快捷键。
  await page.keyboard.press('ControlOrMeta+B');
  await expect(workspaceRail(page)).toBeHidden();
  await page.keyboard.press('ControlOrMeta+B');
  await expect(workspaceBar(page)).toBeVisible();
  await openPanel(page, 'home');
  await page.keyboard.press('ControlOrMeta+B');
  await openPanel(page, 'workspace');
  await expect(workspaceBar(page)).toBeVisible();
});
