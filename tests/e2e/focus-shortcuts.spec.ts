import { expect, test } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

test.beforeEach(async ({ request }) => {
  await resetE2eState(request);
  expect((await request.post(`${fakeApiRoot}/api/sessions`, {
    data: { sessionId: 'focus-shortcut', title: '焦点快捷键' },
  })).ok()).toBe(true);
});

test('快捷键返回鼠标操作的位置不新增背景描边，键盘导航仍显示提示', async ({ page }) => {
  await page.goto('/');
  const logo = page.locator('.logo-area');
  await logo.click();
  await page.keyboard.press('ControlOrMeta+G');
  await page.keyboard.press('Escape');
  await expect(logo).toBeFocused();
  await expect(logo).toHaveCSS('outline-style', 'none');

  // 图标按钮同样会在快捷键关闭时接回焦点。
  const help = page.getByRole('button', { name: '快捷键', exact: true });
  await help.click();
  await help.click();
  await page.keyboard.press('ControlOrMeta+G');
  await page.keyboard.press('Escape');
  await expect(help).toBeFocused();
  await expect(help).toHaveCSS('outline-style', 'none');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(help).toBeFocused();
  await expect(help).toHaveCSS('outline-style', 'solid');

  await openPanel(page, 'workspace');
  await help.click();
  await help.click();
  await page.keyboard.press('ControlOrMeta+K');
  await page.keyboard.press('Escape');
  await expect(help).toBeFocused();
  await expect(help).toHaveCSS('outline-style', 'none');
  const scroll = page.locator('.conversation-panel.active .message-scroll');
  for (const keys of [['ControlOrMeta+G', 'Escape'], ['ControlOrMeta+K', 'Escape'], ['ControlOrMeta+J', 'ControlOrMeta+J']]) {
    await scroll.click({ position: { x: 5, y: 100 } });
    for (const key of keys) await page.keyboard.press(key);
    await expect(scroll).toBeFocused();
    await expect(scroll).toHaveCSS('outline-style', 'none');
  }
  // 焦点确实回到正文，方向键滚动仍然可用，导航后重新显示正常提示。
  await page.keyboard.press('ArrowUp');
  await expect(scroll).not.toHaveAttribute('data-pointer-focus-return');
  await expect(scroll).toHaveCSS('outline-style', 'solid');
});

test('快捷键恢复原有键盘焦点时保留正常描边', async ({ page }) => {
  await page.goto('/');
  const logo = page.locator('.logo-area');
  await logo.click();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(logo).toBeFocused();
  await expect(logo).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('ControlOrMeta+G');
  await page.keyboard.press('Escape');
  await expect(logo).toBeFocused();
  await expect(logo).toHaveCSS('outline-style', 'solid');

  await openPanel(page, 'workspace');
  const scroll = page.locator('.conversation-panel.active .message-scroll');
  await scroll.click({ position: { x: 5, y: 100 } });
  await page.keyboard.press('ArrowUp');
  await expect(scroll).toHaveCSS('outline-style', 'solid');
  for (const keys of [['ControlOrMeta+G', 'Escape'], ['ControlOrMeta+K', 'Escape'], ['ControlOrMeta+J', 'ControlOrMeta+J']]) {
    for (const key of keys) await page.keyboard.press(key);
    await expect(scroll).toBeFocused();
    await expect(scroll).toHaveCSS('outline-style', 'solid');
  }
  await openPanel(page, 'management');
  await page.keyboard.press('Escape');
  await expect(scroll).toBeFocused();
  await expect(scroll).toHaveCSS('outline-style', 'solid');
});
