import type { BookIndex } from '@multivac/contracts';
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { epub, epubFiles } from '../../apps/server/tests/fixtures/binary-books.js';
import { fakeApiRoot, openPanel } from './test-state.js';

async function openLargeBook(page: Page, request: APIRequestContext, id: string, prepare?: (bookId: string) => Promise<void>) {
  const files = epubFiles();
  files['OPS/first.xhtml'] = '<html><body><h1>长章节</h1>' + Array.from({ length: 180 }, (_, n) => `<p>第${n}段：${'用于验证正文按需读取和原文位置稳定。'.repeat(60)}</p>`).join('') + '</body></html>';
  const response = await request.post(`${fakeApiRoot}/api/reading/books/upload?${new URLSearchParams({ commandId: id, title: id, author: '', format: 'epub' })}`, { headers: { 'content-type': 'application/octet-stream' }, data: epub(files) });
  expect(response.ok()).toBe(true);
  const book = await response.json();
  if (prepare) await prepare(book.id);
  const loaded: string[] = [];
  page.on('request', req => { if (req.method() === 'GET' && req.url().includes(`/books/${book.id}`)) loaded.push(req.url()); });
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  await page.getByRole('navigation', { name: '书架' }).getByRole('button', { name: new RegExp(id) }).click();
  if (!prepare) await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeEnabled();
  const index = await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/index`)).json();
  return { book, index, loaded };
}
async function lastPage(page: Page, index: BookIndex, request: APIRequestContext) {
  const window = await (await request.get(`${fakeApiRoot}/api/reading/books/${index.id}/content?block=0`)).json();
  const last = await page.evaluate(async book => {
    const path = '/src/features/reading/reading-layout.ts';
    const { measureReadingPages } = await import(path);
    const viewport = document.querySelector('.reading-page-viewport') as HTMLElement;
    return measureReadingPages(book, document.querySelector('.reading-flow'), viewport.clientWidth).length;
  }, window.book);
  await page.getByLabel('页码', { exact: true }).fill(String(last));
  await page.getByRole('button', { name: '跳转', exact: true }).click();
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue(String(last));
  return last;
}

test('大书完成全书分页后显示真实总页数，跨块翻页与全书跳转保持原文位置', async ({ page, request }) => {
  const { book, index, loaded } = await openLargeBook(page, request, 'stream-navigation');
  expect(index.blockCount).toBeGreaterThan(2);
  expect(new Set(loaded.filter(url => url.includes('/content?')).map(url => new URL(url).searchParams.get('block'))).size).toBe(index.blockCount);
  expect(loaded.some(url => url.endsWith(`/books/${book.id}`))).toBe(false);
  expect((await page.locator('.reading-flow').textContent())!.length).toBeLessThanOrEqual(65536);
  await page.getByRole('button', { name: '当前页书签' }).click();
  await expect(page.getByRole('button', { name: '当前页书签' })).toHaveAttribute('aria-pressed', 'true');
  const last = await lastPage(page, index, request);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect.poll(() => loaded.filter(url => url.includes('/content?block=1')).length).toBe(1);
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue(String(last + 1));
  await expect(page.locator('.reading-flow')).not.toContainText('第0段：');
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue(String(last));
  await expect(page.locator('.reading-flow')).toContainText('第0段：');
  await page.getByRole('button', { name: '目录', exact: true }).click();
  await page.getByRole('navigation', { name: '目录' }).getByRole('button', { name: '第二章', exact: true }).click();
  await expect(page.locator('.reading-chapter-title')).toContainText('第二章');
  await expect(page.locator('.reading-flow')).not.toContainText('第0段：');
  await page.getByRole('button', { name: '关闭返回提示', exact: true }).click();
  await page.getByRole('button', { name: '书签导航', exact: true }).click();
  await page.getByRole('button', { name: '定位原文', exact: true }).click();
  await expect(page.locator('.reading-chapter-title')).toContainText('长章节');
  await page.getByRole('button', { name: '返回阅读处', exact: true }).click();
  await expect(page.locator('.reading-chapter-title')).toContainText('第二章');
  await page.getByRole('button', { name: '为当前页写笔记' }).click();
  await page.getByLabel('笔记内容').fill('跨块定位后的笔记');
  await expect(page.getByRole('button', { name: '保存笔记', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(page.getByLabel('笔记内容')).toHaveCount(0);
  loaded.length = 0;
  await page.reload(); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  await expect(page.locator('.reading-chapter-title')).toContainText('第二章');
  await expect(page.getByLabel('页码', { exact: true })).toBeEnabled();
  expect(new Set(loaded.filter(url => url.includes('/content?')).map(url => new URL(url).searchParams.get('block'))).size).toBe(index.blockCount);
  const label = await page.locator('.reading-pagination form').textContent();
  const total = Number(label!.match(/\/ (\d+) 页/u)![1]);
  expect(total).toBeGreaterThan(last);
  await page.getByLabel('页码', { exact: true }).fill(String(total));
  await page.getByRole('button', { name: '跳转', exact: true }).click();
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue(String(total));
  await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  await page.getByLabel('页码', { exact: true }).fill('1');
  await page.getByRole('button', { name: '跳转', exact: true }).click();
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('1');
  await expect(page.getByRole('button', { name: '上一页', exact: true })).toBeDisabled();
  const totalPages = async () => Number((await page.locator('.reading-pagination form').textContent())?.match(/\/ (\d+) 页/u)?.[1] ?? 0);
  await page.getByRole('button', { name: '字号', exact: true }).click();
  await page.getByRole('slider').press('ArrowRight');
  await expect.poll(totalPages).toBeGreaterThan(total);
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('1');
  await page.getByRole('slider').press('ArrowLeft');
  await expect.poll(totalPages).toBe(total);
  await page.keyboard.press('Escape');
});

test('全书排版失败不显示局部总页数，重试后完成分页', async ({ page, request }) => {
  let fail = true;
  await openLargeBook(page, request, 'stream-retry', async bookId => {
    await page.route(`**/books/${bookId}/content?block=1`, route => fail ? route.abort() : route.continue());
  });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('页码', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  fail = false;
  await page.getByRole('button', { name: '重试排版' }).click();
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('1');
  await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
