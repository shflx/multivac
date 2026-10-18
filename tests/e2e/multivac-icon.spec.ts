import { expect, test, type Locator } from '@playwright/test';
import { openPanel, resetE2eState } from './test-state.js';

async function expectPainted(icon: Locator) {
  await expect(icon).toBeVisible();
  // SVG 容器有尺寸不代表轮廓已绘制；外部 use 加载失败时 getBBox 仍为空。
  const bounds = await icon.evaluate((element) => {
    const { width, height } = (element as SVGSVGElement).getBBox();
    return { width, height };
  });
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
}

test('外部 SVG 不可用时，对话头像与反复打开的面板跳转图标仍可绘制', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  await page.route('**/multivac.svg', (route) => route.abort());
  await page.goto('/');
  const draft = page.getByLabel('Multivac 草稿');
  await expect(draft).toBeEditable();
  await draft.fill('验证助手头像');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const avatar = page.locator('.chat-row.assistant .avatar svg').first();
  await expectPainted(avatar);

  const switcher = page.getByRole('dialog', { name: '面板跳转' });
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.keyboard.press('ControlOrMeta+G');
    await expect(switcher).toBeVisible();
    await expectPainted(switcher.getByRole('option', { name: /Multivac/ }).locator('svg'));
    if (attempt === 0) await switcher.screenshot({ path: testInfo.outputPath('panel-switcher-icon.png') });
    await page.keyboard.press('Escape');
    await expect(switcher).toHaveCount(0);
  }

  await openPanel(page, 'workspace');
  await openPanel(page, 'home');
  await expectPainted(avatar);
});
