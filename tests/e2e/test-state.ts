import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const fakeApiRoot = `http://127.0.0.1:${process.env.MULTIVAC_E2E_API_PORT ?? '4317'}`;

export async function resetE2eState(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${fakeApiRoot}/api/__e2e/reset`);
  if (!response.ok()) {
    throw new Error(`E2E 状态重置失败：${response.status()}`);
  }
}

/** 面板跳转中的三个面板，按顺序对应数字键 1–3。 */
const PANEL_KEYS = { home: '1', workspace: '2', management: '3' } as const;

/**
 * 经 ⌘G / Ctrl+G 面板跳转切到指定面板（数字键直接跳），与用户的真实操作一致。
 * 从管理跳走等同离开管理：模型页有未保存的更改时会先出现离开确认卡，由调用方处理。
 */
export async function openPanel(page: Page, panel: keyof typeof PANEL_KEYS): Promise<void> {
  await expect(page.locator('.confirm-scrim')).toHaveCount(0);
  const switcher = page.getByRole('dialog', { name: '面板跳转' });
  await page.keyboard.press('ControlOrMeta+G');
  await expect(switcher).toBeVisible();
  await page.keyboard.press(PANEL_KEYS[panel]);
  await expect(switcher).toHaveCount(0);
}

/**
 * 在管理中按 Esc 回到进入前的面板。输入框里的 Esc 只作用于输入框，所以先点一下页面标题，
 * 让焦点回到管理页本身（侧栏开着时第一下 Esc 只收起侧栏，由调用方处理）。
 */
export async function escapeFromManagement(page: Page): Promise<void> {
  await page.locator('main.management-page:visible h1').click();
  await page.keyboard.press('Escape');
}

/** 进入管理并切到模型页：进入管理默认打开归档页（之后回到上次所在的页面）。 */
export async function openModelSettings(page: Page): Promise<void> {
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '模型' }).click();
}

/** 归档统一从管理导航进入，不依赖工作区侧边栏中的入口。 */
export async function openArchivePage(page: Page): Promise<void> {
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '归档', exact: true }).click();
  await expect(page.getByRole('main', { name: '归档' })).toBeVisible();
}

/** 从当前工作区分组打开新建会话；侧栏收起时先展开。 */
export async function openCreationDialog(page: Page): Promise<void> {
  const emptyCreate = page.locator('.workspace-page').getByRole('button', { name: '新会话', exact: true });
  await expect(emptyCreate.or(page.locator('.workspace-page .conversation-panel:visible').first())).toBeVisible();
  if (await emptyCreate.isVisible()) {
    await emptyCreate.click();
    return;
  }
  const rail = page.getByRole('complementary', { name: '工作区会话导航' });
  if (!await rail.isVisible()) await page.keyboard.press('ControlOrMeta+B');
  await expect(rail).toBeVisible();
  await rail.locator('.rail-folder.active').getByRole('button', { name: /新建会话/ }).click();
}

export const workspaceRail = (page: Page) => page.getByRole('complementary', { name: '工作区会话导航', includeHidden: true });
export const currentWorkspaceGroup = (page: Page) => workspaceRail(page).locator('.rail-group').filter({ has: page.locator('.rail-folder.active') });

export async function ensureWorkspaceRail(page: Page): Promise<void> {
  if (!await workspaceRail(page).isVisible()) await page.keyboard.press('ControlOrMeta+B');
  await expect(workspaceRail(page)).toBeVisible();
  const active = workspaceRail(page).locator('.rail-folder.active .rail-folder-toggle');
  if (await active.getAttribute('aria-expanded') === 'false') await active.click();
}

export async function setWorkspaceMode(page: Page, mode: 'parallel' | 'focus'): Promise<void> {
  if (mode === 'parallel') {
    const back = page.locator('.conversation-panel:visible').getByRole('button', { name: '返回并排', exact: true });
    if (await back.count()) await back.first().click();
  } else {
    await ensureWorkspaceRail(page);
    await workspaceRail(page).getByRole('radio', { name: '聚焦：只看当前会话' }).click();
  }
}

export async function selectWorkspaceLayout(page: Page, count: number): Promise<void> {
  await ensureWorkspaceRail(page);
  await workspaceRail(page).getByRole('radio', { name: `并排 ${count} 栏` }).click();
}

export async function selectWorkspace(page: Page, name: string): Promise<void> {
  await ensureWorkspaceRail(page);
  const target = workspaceRail(page).locator('.rail-folder-toggle').filter({ hasText: name });
  await target.click();
  await expect(workspaceRail(page).locator('.rail-folder.active')).toContainText(name);
}

export async function railSessionAction(page: Page, title: string, action: '改名' | '归档' | '归入项目…' | number): Promise<void> {
  await ensureWorkspaceRail(page);
  await currentWorkspaceGroup(page).getByRole('button', { name: `更多「${title}」`, exact: true }).click();
  const menu = page.getByRole('menu', { name: `会话操作：${title}` });
  await menu.getByRole('menuitem', { name: typeof action === 'number' ? `放进第 ${action} 栏` : action, exact: true }).click();
}
