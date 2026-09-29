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

/** 进入管理并切到模型页：进入管理默认打开会话页（之后回到上次所在的页面）。 */
export async function openModelSettings(page: Page): Promise<void> {
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '模型' }).click();
}

/** 从工作区条的会话列表打开“创建新会话”对话框（工作区条不单设新会话按钮）。 */
export async function openCreationDialog(page: Page): Promise<void> {
  const trigger = page.getByRole('toolbar', { name: '工作区' }).getByRole('button', { name: /^会话/ });
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  await page.getByRole('dialog', { name: '工作区会话' }).getByRole('button', { name: '新会话' }).click();
}
