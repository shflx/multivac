import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';

const workspaceBar = (page: Page) => page.getByRole('toolbar', { name: '工作区' });
const homeDraft = (page: Page) => page.locator('.work-surface').first().getByLabel('Multivac 草稿');

async function enterWorkspace(page: Page): Promise<void> {
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(workspaceBar(page)).toBeVisible();
}

async function createSession(page: Page, title: string): Promise<void> {
  await workspaceBar(page).getByRole('button', { name: '新会话' }).click();
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await dialog.getByLabel('会话名称').fill(title);
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).toHaveCount(0);
}

function panel(page: Page, title: string) {
  return page.locator('.workspace-panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

async function openSessionMenu(page: Page) {
  await workspaceBar(page).getByRole('button', { name: /^会话/ }).click();
  const menu = page.getByRole('dialog', { name: '工作区会话' });
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

test('空工作区提供新会话；新建后出现在列表并聚焦，刷新后列表仍在', async ({ page }) => {
  await enterWorkspace(page);
  await expect(page.getByRole('heading', { name: '默认工作区还没有会话' })).toBeVisible();
  await expect(workspaceBar(page).getByRole('button', { name: /^会话/ })).toContainText('0/0');

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
  await expect(workspaceBar(page).getByRole('button', { name: '聚焦' })).toHaveAttribute('aria-pressed', 'true');

  await createSession(page, '核对接口');
  const menu = await openSessionMenu(page);
  await expect(menu.locator('.scene-row')).toHaveCount(2);
  await expect(menu.locator('.scene-row').filter({ hasText: '核对接口' })).toContainText('展示中');
  await expect(menu.locator('.scene-row').filter({ hasText: '梳理导航结构' })).toContainText('未展示');

  await page.reload();
  await enterWorkspace(page);
  const reloaded = await openSessionMenu(page);
  await expect(reloaded.locator('.conversation-menu-name strong')).toHaveText(['梳理导航结构', '核对接口']);
});

test('并排展示两个会话；从列表选择未展示会话时替换较早的一栏并保留当前会话', async ({ page }) => {
  await enterWorkspace(page);
  for (const title of ['会话一', '会话二', '会话三']) await createSession(page, title);

  await workspaceBar(page).getByRole('button', { name: '并排' }).click();
  await expect(page.locator('.workspace-panel')).toHaveCount(2);
  await expect(page.locator('.workspace-panel h2')).toHaveText(['会话三', '会话二']);

  const menu = await openSessionMenu(page);
  await menu.locator('.scene-row').filter({ hasText: '会话一' }).getByRole('button', { name: /会话一/ }).first().click();
  await expect(page.locator('.workspace-panel h2')).toHaveText(['会话三', '会话一']);
  await expect(panel(page, '会话一')).toHaveClass(/active/);
  await expect(workspaceBar(page).getByRole('button', { name: /^会话/ })).toContainText('2/3');
});

test('会话列表中改名与归档，归档后从工作区移除', async ({ page }) => {
  page.on('dialog', (dialog) => void dialog.accept());
  await enterWorkspace(page);
  await createSession(page, '待改名');
  await createSession(page, '待归档');

  let menu = await openSessionMenu(page);
  await menu.getByRole('button', { name: '改名「待改名」' }).click();
  const input = menu.getByLabel('会话名称');
  await input.fill('已改名的会话');
  await input.press('Enter');
  await expect(menu.locator('.conversation-menu-name strong')).toContainText(['已改名的会话']);

  await menu.getByRole('button', { name: '归档「待归档」' }).click();
  await expect(menu.locator('.scene-row')).toHaveCount(1);
  await expect(page.locator('.workspace-panel h2')).toHaveText(['已改名的会话']);

  await page.reload();
  await enterWorkspace(page);
  menu = await openSessionMenu(page);
  await expect(menu.locator('.conversation-menu-name strong')).toHaveText(['已改名的会话']);
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

  await page.getByRole('button', { name: '返回 Multivac' }).click();
  await expect(homeDraft(page)).toBeVisible();
  await expect(homeDraft(page)).toHaveValue('首页草稿');
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(readingTop, 0);

  await enterWorkspace(page);
  await expect(sessionDraft).toHaveValue('工作会话草稿');

  // Cmd/Ctrl+\ 隐藏与恢复工作区条；首页不响应该快捷键。
  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect(workspaceBar(page)).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect(workspaceBar(page)).toBeVisible();
  await page.getByRole('button', { name: '返回 Multivac' }).click();
  await page.keyboard.press('ControlOrMeta+Backslash');
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(workspaceBar(page)).toBeVisible();
});
