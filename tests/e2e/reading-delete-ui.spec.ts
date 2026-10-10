import { expect, test } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

test.beforeEach(async ({ request }) => { await resetE2eState(request); });

test('书架删除确认支持取消、失败重试，删除当前书籍后返回书架并持久化', async ({ page, request }, testInfo) => {
  const book = await (await request.post(`${fakeApiRoot}/api/reading/books`, { data: { commandId: 'delete-ui-book', title: '删除验证', author: '测试作者', format: 'txt', text: '等待删除的书籍正文。' } })).json();
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  const shelf = page.getByRole('navigation', { name: '书架' });
  const row = shelf.locator('.reading-shelf-item').filter({ hasText: '删除验证' });
  const remove = page.getByRole('button', { name: '删除书籍', exact: true });
  await expect(remove).toHaveCount(0);
  await expect(row.getByRole('button', { name: '更多书籍操作', exact: true })).toHaveCount(0);
  await row.getByRole('button', { name: /删除验证/ }).click();
  await expect(page.locator('.reading-toolbar h2')).toHaveText('《删除验证》');
  await page.getByRole('button', { name: '书架', exact: true }).click();
  await expect(row.getByRole('button', { name: /删除验证/ })).toHaveAttribute('aria-current', 'true');
  await expect(remove).toBeEnabled();
  const actions = page.locator('.reading-left-pane .reading-shelf-actions');
  await expect(actions.getByRole('button', { name: '导入书籍', exact: true })).toBeVisible();
  await expect(actions.getByRole('button', { name: '删除书籍', exact: true })).toBeVisible();
  await remove.click();
  const dialog = page.getByRole('dialog', { name: '删除书籍', exact: true });
  await expect(dialog).toContainText('删除验证');
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(remove).toBeFocused();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('shelf-delete-desktop.png') });
  await page.setViewportSize({ width: 390, height: 720 });
  let attempts = 0;
  await page.route(`**/api/reading/books/${book.id}`, async route => {
    if (route.request().method() !== 'DELETE') { await route.continue(); return; }
    if (++attempts === 1) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '删除暂时失败，请重试。' } }) });
    else await route.continue();
  });
  await remove.click();
  await expect(dialog).toContainText('阅读笔记、书伴讨论和已收集内容会保留');
  expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('shelf-delete-mobile.png') });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('删除暂时失败');
  await expect(page.locator('.reading-toolbar h2')).toHaveText('《删除验证》');
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(shelf).toContainText('书架为空');
  await expect(remove).toHaveCount(0);
  await expect(page.getByRole('button', { name: '导入书籍', exact: true })).toBeFocused();
  expect((await request.get(`${fakeApiRoot}/api/reading/books/${book.id}`)).status()).toBe(404);
  expect(await page.evaluate(() => localStorage.getItem('multivac.reading.active'))).toBeNull();
  expect(await page.evaluate(id => localStorage.getItem(`multivac.reading.scene.${id}`), book.id)).toBeNull();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload(); await expect(page.locator('.app-shell')).toBeVisible();
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  await expect(shelf).toContainText('书架为空');
});

test('其他窗口删除当前书籍时，同步退出阅读；重复删除可安全重试', async ({ page, request }) => {
  const book = await (await request.post(`${fakeApiRoot}/api/reading/books`, { data: { commandId: 'delete-sync-book', title: '同步删除', author: '', format: 'txt', text: '其他窗口删除的原文。' } })).json();
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  await page.getByRole('navigation', { name: '书架' }).getByRole('button', { name: /同步删除/ }).click();
  await expect(page.locator('.reading-toolbar h2')).toHaveText('《同步删除》');
  expect((await request.delete(`${fakeApiRoot}/api/reading/books/${book.id}`)).ok()).toBe(true);
  await expect(page.locator('.reading-reader')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '书架' })).toContainText('书架为空');
  expect((await request.delete(`${fakeApiRoot}/api/reading/books/${book.id}`)).ok()).toBe(true);
});
