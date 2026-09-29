import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, openModelSettings, openPanel, resetE2eState } from './test-state.js';

const shell = (page: Page) => page.locator('.app-shell');
const homeDraft = (page: Page) => page.locator('.work-surface').first().getByLabel('Multivac 草稿');
const workspaceBar = (page: Page) => page.getByRole('toolbar', { name: '工作区' });
const switcher = (page: Page) => page.getByRole('dialog', { name: '面板跳转' });
const option = (page: Page, name: string) => switcher(page).getByRole('option', { name: new RegExp(`^${name}`) });
const helpButton = (page: Page) => page.getByRole('button', { name: '快捷键' });
const helpMenu = (page: Page) => page.getByRole('dialog', { name: '快捷键' });

/** 当前所在的面板：管理 / 工作区 / 首页。 */
async function expectPanel(page: Page, panel: 'home' | 'workspace' | 'management'): Promise<void> {
  if (panel === 'management') {
    await expect(shell(page)).toHaveClass(/management-mode/);
    return;
  }
  await expect(shell(page)).toHaveClass(/work-mode/);
  if (panel === 'home') {
    await expect(homeDraft(page)).toBeVisible();
    await expect(workspaceBar(page)).toBeHidden();
  } else {
    await expect(workspaceBar(page)).toBeVisible();
    await expect(homeDraft(page)).toBeHidden();
  }
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  const current = await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json() as { revision: number };
  await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
    data: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: current.revision },
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(homeDraft(page)).toBeEditable();
});

test('⌘G 打开面板跳转：默认选中下一个面板，标出当前面板，Esc 关闭并把焦点还给原处，按键不落到输入框', async ({ page }) => {
  await homeDraft(page).fill('写了一半');
  await expect(homeDraft(page)).toBeFocused();

  // 输入框聚焦时同样响应。
  await page.keyboard.press('ControlOrMeta+G');
  await expect(switcher(page)).toBeVisible();
  await expect(switcher(page)).toContainText('面板跳转');
  await expect(switcher(page)).toContainText('下一个 · 回车确认 · 1–3 直接跳');
  const list = switcher(page).getByRole('listbox', { name: '面板' });
  await expect(list).toBeFocused();
  await expect(switcher(page).getByRole('option')).toHaveCount(3);
  await expect(option(page, 'Multivac')).toContainText('当前');
  await expect(option(page, 'Multivac')).toContainText('和 Multivac 对话，交代与安排工作');
  await expect(option(page, '工作区')).toHaveAttribute('aria-selected', 'true');
  await expect(option(page, '工作区')).toContainText('2');
  // “管理”的说明只写已实现的页面。
  await expect(option(page, '管理')).toContainText('会话与设置');

  // 方向键与 ⌘G（⇧⌘G 反向）循环移动选中项。
  await page.keyboard.press('ArrowDown');
  await expect(option(page, '管理')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ControlOrMeta+G');
  await expect(option(page, 'Multivac')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ControlOrMeta+Shift+G');
  await expect(option(page, '管理')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(option(page, '工作区')).toHaveAttribute('aria-selected', 'true');

  // Esc 关闭，焦点回到草稿，草稿未被按键改写，仍在首页。
  await page.keyboard.press('Escape');
  await expect(switcher(page)).toHaveCount(0);
  await expect(homeDraft(page)).toBeFocused();
  await expect(homeDraft(page)).toHaveValue('写了一半');
  await expectPanel(page, 'home');

  // 点遮罩同样关闭。
  await page.keyboard.press('ControlOrMeta+G');
  await expect(switcher(page)).toBeVisible();
  await page.mouse.click(40, 860);
  await expect(switcher(page)).toHaveCount(0);
  await expectPanel(page, 'home');

  // ⌘G 后直接回车切到下一个面板；数字键不会写进输入框。
  await page.keyboard.press('ControlOrMeta+G');
  await page.keyboard.press('Enter');
  await expect(switcher(page)).toHaveCount(0);
  await expectPanel(page, 'workspace');
  await openPanel(page, 'home');
  await expect(homeDraft(page)).toHaveValue('写了一半');
});

test('三个面板经 ⌘G 互相切换，去管理保留原来的现场，离开管理回到它', async ({ page }) => {
  await openPanel(page, 'workspace');
  await expectPanel(page, 'workspace');
  await openPanel(page, 'management');
  await expectPanel(page, 'management');
  await expect(page.locator('.shell-page-name')).toHaveText('会话');

  // 管理中打开面板跳转，默认选中下一个（Multivac）。
  await page.keyboard.press('ControlOrMeta+G');
  await expect(option(page, '管理')).toContainText('当前');
  await expect(option(page, 'Multivac')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(switcher(page)).toHaveCount(0);
  // 面板跳转里的 Esc 只关闭它，不离开管理。
  await expectPanel(page, 'management');

  await openPanel(page, 'home');
  await expectPanel(page, 'home');
  await openPanel(page, 'management');
  await expectPanel(page, 'management');
  await openPanel(page, 'workspace');
  await expectPanel(page, 'workspace');
  await openPanel(page, 'home');
  await expectPanel(page, 'home');

  // 用鼠标点选同样可以。
  await page.keyboard.press('ControlOrMeta+G');
  await option(page, '管理').click();
  await expectPanel(page, 'management');

  // 从首页进入管理，Esc 回到首页；从工作区进入，Esc 回到工作区。
  await page.keyboard.press('Escape');
  await expectPanel(page, 'home');
  await openPanel(page, 'workspace');
  await openPanel(page, 'management');
  await page.keyboard.press('Escape');
  await expectPanel(page, 'workspace');
});

test('“?”菜单列出两组快捷键与 Esc 的用法，条目可以直接点', async ({ page }) => {
  await helpButton(page).click();
  await expect(helpButton(page)).toHaveAttribute('aria-expanded', 'true');
  const menu = helpMenu(page);
  await expect(menu.getByRole('button')).toHaveCount(2);
  const panelItem = menu.getByRole('button', { name: /面板跳转/ });
  const sidebarItem = menu.getByRole('button', { name: /Multivac 侧栏/ });
  await expect(panelItem).toContainText('在 Multivac、工作区、管理之间切换');
  await expect(panelItem.locator('kbd')).toHaveText([/^(⌘|Ctrl)$/, 'G']);
  // 首页本身就是 Multivac 对话：侧栏条目不可用。
  await expect(sidebarItem).toContainText('显示 Multivac 侧栏');
  await expect(sidebarItem).toContainText('首页本身就是 Multivac 对话');
  await expect(sidebarItem.locator('kbd')).toHaveText([/^(⌘|Ctrl)$/, 'J']);
  await expect(sidebarItem).toBeDisabled();
  await expect(menu).toContainText('在管理中按 Esc 回到原来的面板');

  // 点别处收起。
  await page.mouse.click(700, 400);
  await expect(menu).toHaveCount(0);

  // 点“面板跳转”打开面板跳转，Esc 关闭后焦点回到“?”。
  await helpButton(page).click();
  await panelItem.click();
  await expect(menu).toHaveCount(0);
  await expect(switcher(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(helpButton(page)).toBeFocused();

  // 经“?”在三个面板间切换。
  for (const [target, panel] of [['工作区', 'workspace'], ['管理', 'management'], ['Multivac', 'home']] as const) {
    await helpButton(page).click();
    await helpMenu(page).getByRole('button', { name: /面板跳转/ }).click();
    await option(page, target).click();
    await expectPanel(page, panel);
  }

  // 工作区里：侧栏条目可用，点它叫出侧栏，条目随之改写为收起。
  await helpButton(page).click();
  await helpMenu(page).getByRole('button', { name: /面板跳转/ }).click();
  await option(page, '工作区').click();
  const workspaceSidebar = page.locator('.multivac-sidebar');
  await expect(workspaceSidebar).toBeHidden();
  await helpButton(page).click();
  await expect(sidebarItem).toBeEnabled();
  await expect(sidebarItem).toContainText('在工作区与管理中叫出，与首页是同一个对话');
  await sidebarItem.click();
  await expect(workspaceSidebar).toBeVisible();
  await helpButton(page).click();
  await expect(sidebarItem).toContainText('收起 Multivac 侧栏');
  await sidebarItem.click();
  await expect(workspaceSidebar).toBeHidden();

  // ⌘J 在工作区照常可用。
  await page.keyboard.press('ControlOrMeta+J');
  await expect(workspaceSidebar).toBeVisible();
});

test('管理中 Esc：输入框与面板跳转里的 Esc 只作用于自身，其他位置回到进入前的工作区并保留现场', async ({ page }) => {
  await openPanel(page, 'workspace');
  await expect(workspaceBar(page)).toBeVisible();
  await openPanel(page, 'management');

  // 搜索框里的 Esc 只作用于搜索框（浏览器按原生行为清空），不离开管理。
  const search = page.getByRole('searchbox', { name: '按标题搜索' });
  await search.fill('导航');
  await page.keyboard.press('Escape');
  await expectPanel(page, 'management');
  await expect(search).toBeFocused();
  await search.fill('导航');

  // 离开输入框后，Esc 回到工作区；再进入管理，搜索条件仍在（页面保持挂载）。
  await page.locator('main.management-page:visible h1').click();
  await page.keyboard.press('Escape');
  await expectPanel(page, 'workspace');
  await openPanel(page, 'management');
  await expect(search).toHaveValue('导航');
});

test('模型页有未保存的修改时，经 ⌘G 离开管理先确认：继续编辑留在管理，放弃后才跳走', async ({ page }) => {
  await openPanel(page, 'workspace');
  await openModelSettings(page);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const name = page.getByLabel('显示名称');
  await name.fill('尚未保存的名称');

  const leaveCard = page.getByRole('dialog', { name: '放弃未保存的更改？' });
  await page.keyboard.press('ControlOrMeta+G');
  await page.keyboard.press('1');
  await expect(leaveCard).toBeVisible();
  // 确认卡打开时 ⌘G 不再打开面板跳转。
  await page.keyboard.press('ControlOrMeta+G');
  await expect(switcher(page)).toHaveCount(0);
  await leaveCard.getByRole('button', { name: '继续编辑' }).click();
  await expect(leaveCard).toHaveCount(0);
  await expectPanel(page, 'management');
  await expect(name).toHaveValue('尚未保存的名称');
  // 焦点回到打开面板跳转前的输入框。
  await expect(name).toBeFocused();

  // 跳到工作区：放弃并离开后回到工作区，草稿被丢弃。
  await page.keyboard.press('ControlOrMeta+G');
  await page.keyboard.press('2');
  await leaveCard.getByRole('button', { name: '放弃并离开' }).click();
  await expectPanel(page, 'workspace');
  await openPanel(page, 'management');
  await expect(page.getByLabel('显示名称')).toHaveCount(0);

  // 面板跳转里选“管理”（当前面板）什么也不做。
  await page.keyboard.press('ControlOrMeta+G');
  await page.keyboard.press('3');
  await expect(switcher(page)).toHaveCount(0);
  await expectPanel(page, 'management');
});
