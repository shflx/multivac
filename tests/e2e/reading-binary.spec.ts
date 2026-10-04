import { expect, test } from '@playwright/test';
import { openPanel, fakeApiRoot } from './test-state.js';
import { textPdf, epub } from '../../apps/server/tests/fixtures/binary-books.js';

for (const format of ['pdf', 'epub'] as const) {
  test(`${format} 文件导入后可翻页、标注、记笔记并刷新恢复`, async ({ page, request }) => {
    await page.goto('/'); await openPanel(page, 'management');
    await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
    await page.getByRole('button', { name: '导入书籍' }).click();
    await page.locator('input[type=file]').setInputFiles({ name: `格式验证.${format}`, mimeType: format === 'pdf' ? 'application/pdf' : 'application/epub+zip', buffer: format === 'pdf' ? textPdf() : epub() });
    await page.getByRole('button', { name: '导入', exact: true }).click();
    await expect(page.locator('.reading-toolbar h2')).toHaveText('《格式验证》');
    const firstText = format === 'pdf' ? 'First PDF page.' : '第一章真实正文😀 & 引用。';
    await expect(page.getByLabel('书籍正文')).toContainText(firstText);
    await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(page.getByLabel('页码', { exact: true })).toHaveValue('2');
    await page.getByRole('button', { name: '上一页', exact: true }).click();
    await page.getByRole('button', { name: '当前页书签' }).click();
    await expect(page.getByRole('button', { name: '当前页书签' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '为当前页写笔记' }).click();
    await page.getByLabel('笔记内容').fill(`${format} 阅读笔记`);
    await expect(page.getByRole('button', { name: '保存笔记', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '保存笔记', exact: true }).click();
    await expect(page.getByLabel('笔记内容')).toHaveCount(0);
    const books = await (await request.get(`${fakeApiRoot}/api/reading/books`)).json();
    const book = books.books.find((entry: { title: string; format: string }) => entry.title === '格式验证' && entry.format === format);
    expect(book).toBeTruthy();
    const notes = await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/notes`)).json();
    expect(notes.notes[0].reference.bookId).toBe(book.id);
    expect(notes.notes[0].reference.text).toContain(firstText);
    await page.reload(); await openPanel(page, 'management');
    await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
    await expect(page.locator('.reading-toolbar h2')).toHaveText('《格式验证》');
    await expect(page.getByRole('button', { name: '当前页书签' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '阅读笔记', exact: true }).click();
    await expect(page.locator('.reading-note-preview')).toHaveText(`${format} 阅读笔记`);
  });
}

test('扫描 PDF 与损坏 EPUB 显示可理解的错误，不创建空书', async ({ page }) => {
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  await page.getByRole('button', { name: '导入书籍' }).click();
  await page.locator('input[type=file]').setInputFiles({ name: '扫描.pdf', mimeType: 'application/pdf', buffer: textPdf(['']) });
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('扫描版暂不支持 OCR');
  await page.locator('input[type=file]').setInputFiles({ name: '损坏.epub', mimeType: 'application/epub+zip', buffer: Buffer.from('not an epub') });
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('EPUB 文件损坏');
  await expect(page.locator('.reading-toolbar')).toHaveCount(0);
});
