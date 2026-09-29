import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, openCreationDialog, openModelSettings, openPanel, resetE2eState } from './test-state.js';

/**
 * 窄屏（视口 ≤760px）：只保留 Multivac 首页；工作区与管理显示“请在桌面使用”与“回到 Multivac”。
 * 提示只替换呈现，工作区与管理页保持挂载，回到宽屏后现场原样。
 */

const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 700, height: 900 };

const shell = (page: Page) => page.locator('.app-shell');
const header = (page: Page) => page.locator('.shell-header');
const homeDraft = (page: Page) => page.locator('.work-surface').first().getByLabel('Multivac 草稿');
const workspaceBar = (page: Page) => page.getByRole('toolbar', { name: '工作区' });
const notice = (page: Page, surface: '管理' | '工作区') => page.getByRole('region', { name: `${surface}请在桌面使用` });
const noticeHome = (page: Page, surface: '管理' | '工作区') => notice(page, surface).getByRole('button', { name: '回到 Multivac' });
const panel = (page: Page, title: string) => page.locator('.conversation-panel').filter({
  has: page.getByRole('heading', { name: title, exact: true }),
});

/** 改变视口宽度，并等外壳按新的宽度重新渲染（窄屏判定随 matchMedia 的变化事件异步更新）。 */
async function resize(page: Page, size: typeof WIDE | typeof NARROW): Promise<void> {
  await page.setViewportSize(size);
  if (size === NARROW) await expect(shell(page)).toHaveClass(/narrow/);
  else await expect(shell(page)).not.toHaveClass(/narrow/);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(0);
}

/** 窄屏提示的内容：标题、只写已实现内容的说明与“回到 Multivac”。 */
async function expectNotice(page: Page, surface: '管理' | '工作区'): Promise<void> {
  const region = notice(page, surface);
  await expect(region).toBeVisible();
  await expect(region.getByRole('heading', { level: 2 })).toHaveText(`${surface}请在桌面使用`);
  await expect(region).toContainText('窄屏只保留日常层：和 Multivac 对话。并排、栈式深入和批量管理需要更宽的屏幕。');
  await expect(region).not.toContainText(/Inbox|成果|读书/);
  await expect(noticeHome(page, surface)).toBeVisible();
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  const current = await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json() as { revision: number };
  await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
    data: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: current.revision },
  });
  await page.setViewportSize(WIDE);
  await page.goto('/');
  await expect(homeDraft(page)).toBeEditable();
});

test('700px 下首页照常可用：顶栏只留 Logo，不放“?”，⌘G 不打开面板跳转', async ({ page }) => {
  await resize(page, NARROW);
  expect((await header(page).boundingBox())!.height).toBe(56);
  await expect(header(page).getByRole('button')).toHaveCount(1);
  await expect(header(page).getByRole('button', { name: '回到 Multivac', exact: true })).toBeVisible();
  await expect(header(page).getByRole('button', { name: '快捷键' })).toHaveCount(0);

  await homeDraft(page).fill('窄屏也能写');
  await page.keyboard.press('ControlOrMeta+G');
  await expect(page.getByRole('dialog', { name: '面板跳转' })).toHaveCount(0);
  await expect(homeDraft(page)).toHaveValue('窄屏也能写');
  await expectNoHorizontalOverflow(page);

  // 回到宽屏，顶栏恢复原样。
  await resize(page, WIDE);
  expect((await header(page).boundingBox())!.height).toBe(58);
  await expect(header(page).getByRole('button', { name: '快捷键' })).toBeVisible();
});

test('700px 下管理显示“管理请在桌面使用”：未保存的修改仍受离开确认保护，回到宽屏后页面原样，“回到 Multivac”回到首页', async ({ page }) => {
  await openModelSettings(page);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('显示名称').fill('窄屏前没保存的名称');

  await resize(page, NARROW);
  await expectNotice(page, '管理');
  // 不显示管理导航与页面；顶栏不写“管理”，也没有页面名。
  await expect(page.getByRole('complementary', { name: '管理导航' })).toHaveCount(0);
  await expect(page.getByRole('main', { name: '模型' })).toBeHidden();
  await expect(page.locator('.logo-copy small')).toHaveCount(0);
  await expect(page.locator('.shell-page-name')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  // 窄屏没有外壳快捷键：Esc 不离开管理。
  await noticeHome(page, '管理').focus();
  await page.keyboard.press('Escape');
  await expect(notice(page, '管理')).toBeVisible();

  // “回到 Multivac”经过同样的离开确认：继续编辑时留下。
  await noticeHome(page, '管理').click();
  const leaveCard = page.getByRole('dialog', { name: '放弃未保存的更改？' });
  await expect(leaveCard).toBeVisible();
  await leaveCard.getByRole('button', { name: '继续编辑' }).click();
  await expect(leaveCard).toHaveCount(0);
  await expect(notice(page, '管理')).toBeVisible();

  // 回到宽屏，页面与未保存的修改都还在。
  await resize(page, WIDE);
  await expect(notice(page, '管理')).toHaveCount(0);
  await expect(page.locator('.shell-page-name')).toHaveText('模型');
  await expect(page.getByLabel('显示名称')).toHaveValue('窄屏前没保存的名称');

  // 再到窄屏，放弃修改后回到首页，首页可用。
  await resize(page, NARROW);
  await noticeHome(page, '管理').click();
  await leaveCard.getByRole('button', { name: '放弃并离开' }).click();
  await expect(notice(page, '管理')).toHaveCount(0);
  await expect(homeDraft(page)).toBeEditable();
  await expect(shell(page)).toHaveClass(/work-mode/);

  // 回到宽屏仍在首页，再进管理回到上次所在的模型页。
  await resize(page, WIDE);
  await expect(homeDraft(page)).toBeVisible();
  await openPanel(page, 'management');
  await expect(page.locator('.shell-page-name')).toHaveText('模型');
});

test('700px 下工作区显示“工作区请在桌面使用”，工作区不卸载：回到宽屏后会话、草稿与焦点原样', async ({ page }) => {
  await openPanel(page, 'workspace');
  await openCreationDialog(page);
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await dialog.getByLabel('会话名称').fill('窄屏现场');
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).toHaveCount(0);
  const draft = panel(page, '窄屏现场').getByLabel('Multivac 草稿');
  await draft.fill('写到一半的草稿');
  // 给工作区的 DOM 打个记号：窄屏前后仍是同一个节点，说明没有被卸载重建。
  await page.locator('.workspace-page').evaluate((element) => { element.setAttribute('data-e2e-probe', 'kept'); });

  await resize(page, NARROW);
  await expectNotice(page, '工作区');
  await expect(workspaceBar(page)).toBeHidden();
  await expect(page.locator('.workspace-page')).toHaveAttribute('data-e2e-probe', 'kept');
  await expectNoHorizontalOverflow(page);

  await resize(page, WIDE);
  await expect(notice(page, '工作区')).toHaveCount(0);
  await expect(workspaceBar(page)).toBeVisible();
  await expect(page.locator('.workspace-page')).toHaveAttribute('data-e2e-probe', 'kept');
  await expect(page.locator('.conversation-panel h2')).toHaveText(['窄屏现场']);
  await expect(draft).toHaveValue('写到一半的草稿');
  await expect(draft).toBeFocused();

  // 窄屏时“回到 Multivac”回到首页；之后回到工作区，现场仍在。
  await resize(page, NARROW);
  await noticeHome(page, '工作区').click();
  await expect(notice(page, '工作区')).toHaveCount(0);
  await expect(homeDraft(page)).toBeEditable();
  await resize(page, WIDE);
  await openPanel(page, 'workspace');
  await expect(page.locator('.workspace-page')).toHaveAttribute('data-e2e-probe', 'kept');
  await expect(draft).toHaveValue('写到一半的草稿');
});
