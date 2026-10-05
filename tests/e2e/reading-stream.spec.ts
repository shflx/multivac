import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { epub, epubFiles } from '../../apps/server/tests/fixtures/binary-books.js';
import { fakeApiRoot, openPanel } from './test-state.js';

async function openLargeBook(page: Page, request: APIRequestContext, id: string) {
  const files = epubFiles();
  files['OPS/first.xhtml'] = '<html><body><h1>长章节</h1>' + Array.from({ length: 180 }, (_, n) => `<p>第${n}段：${'用于验证正文按需读取和原文位置稳定。'.repeat(60)}</p>`).join('') + '</body></html>';
  const response = await request.post(`${fakeApiRoot}/api/reading/books/upload?${new URLSearchParams({ commandId: id, title: id, author: '', format: 'epub' })}`, { headers: { 'content-type': 'application/octet-stream' }, data: epub(files) });
  expect(response.ok()).toBe(true);
  const book = await response.json();
  const loaded: string[] = [];
  page.on('request', req => { if (req.method() === 'GET' && req.url().includes(`/books/${book.id}`)) loaded.push(req.url()); });
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  await page.getByRole('navigation', { name: '书架' }).getByRole('button', { name: new RegExp(id) }).click();
  await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeEnabled();
  const index = await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/index`)).json();
  return { book, index, loaded };
}
async function lastPage(page: Page) {
  const label = await page.locator('.reading-pagination form').textContent();
  const last = Number(label!.match(/\/ (\d+) 页/u)![1]);
  await page.getByLabel('页码', { exact: true }).fill(String(last));
  await page.getByRole('button', { name: '跳转', exact: true }).click();
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue(String(last));
  return last;
}

test('大书只加载当前位置正文，跨块翻页、目录、书签返回和刷新保持原文位置', async ({ page, request }) => {
  const { book, index, loaded } = await openLargeBook(page, request, 'stream-navigation');
  expect(index.blockCount).toBeGreaterThan(2);
  expect(loaded.filter(url => url.includes('/content?'))).toHaveLength(1);
  expect(loaded.some(url => url.endsWith(`/books/${book.id}`))).toBe(false);
  expect((await page.locator('.reading-flow').textContent())!.length).toBeLessThanOrEqual(65536);
  await page.getByRole('button', { name: '当前页书签' }).click();
  await expect(page.getByRole('button', { name: '当前页书签' })).toHaveAttribute('aria-pressed', 'true');
  const last = await lastPage(page);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect.poll(() => loaded.filter(url => url.includes('/content?block=1')).length).toBe(1);
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('1');
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
  expect(loaded.filter(url => url.includes('/content?'))).toHaveLength(1);
  expect(loaded.some(url => url.endsWith('/content?block=0'))).toBe(false);
});

test('下一段读取失败保留原页，重试成功后才移动阅读位置', async ({ page, request }) => {
  const { book } = await openLargeBook(page, request, 'stream-retry');
  const last = await lastPage(page);
  let fail = true;
  await page.route(`**/books/${book.id}/content?block=1`, route => fail ? route.abort() : route.continue());
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue(String(last));
  await expect(page.locator('.reading-flow')).toContainText('第0段：');
  fail = false;
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('1');
  await expect(page.locator('.reading-flow')).not.toContainText('第0段：');
});
