import type { APIRequestContext, Page } from '@playwright/test';

export const fakeApiRoot = `http://127.0.0.1:${process.env.MULTIVAC_E2E_API_PORT ?? '4317'}`;

export async function resetE2eState(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${fakeApiRoot}/api/__e2e/reset`);
  if (!response.ok()) {
    throw new Error(`E2E 状态重置失败：${response.status()}`);
  }
}

/** 进入管理并切到模型页：进入管理默认打开会话页（之后回到上次所在的页面）。 */
export async function openModelSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: '打开管理' }).click();
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '模型' }).click();
}

/** 从工作区条的会话列表打开“创建新会话”对话框（工作区条不单设新会话按钮）。 */
export async function openCreationDialog(page: Page): Promise<void> {
  const trigger = page.getByRole('toolbar', { name: '工作区' }).getByRole('button', { name: /^会话/ });
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  await page.getByRole('dialog', { name: '工作区会话' }).getByRole('button', { name: '新会话' }).click();
}
