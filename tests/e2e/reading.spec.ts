import { expect, test } from '@playwright/test';
import { openPanel, fakeApiRoot } from './test-state.js';

test('真实书籍从文件导入，切换与刷新读取持久书架', async ({ page, request }, testInfo) => {
  await page.goto('/');
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  await page.getByRole('button', { name: '导入书籍' }).click();
  await page.locator('input[type=file]').setInputFiles({ name: '真实书籍.md', mimeType: 'text/markdown', buffer: Buffer.from('# 第一章\n\n这是从真实文件导入的正文😀。\n\n# 第二章\n\n第二章的内容。') });
  await page.getByLabel('作者', { exact: true }).fill('测试作者');
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await expect(page.locator('.reading-content')).toContainText('这是从真实文件导入的正文😀。');
  const books = await (await request.get(`${fakeApiRoot}/api/reading/books`)).json();
  const book = books.books.find((b: { title: string }) => b.title === '真实书籍');
  expect(book.version).toMatch(/^[a-f0-9]{64}$/u);
  await page.screenshot({ path: testInfo.outputPath('reading-library-desktop.png') });
  await page.reload(); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  await page.getByRole('navigation', { name: '书架' }).getByRole('button', { name: /真实书籍/u }).click();
  await expect(page.locator('.reading-content')).toContainText('第二章的内容。');
  const invalid = await request.post(`${fakeApiRoot}/api/reading/books`, { data: { commandId: 'invalid', format: 'pdf', title: 'pdf', author: '', text: 'data' } });
  expect(invalid.status()).toBe(400);
});
