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

test('书签备注与跨段划线持久化，重新分页后可定位原文', async ({ page, request }, testInfo) => {
  const book = await (await request.post(`${fakeApiRoot}/api/reading/books`, { data: { commandId: 'annotation-book', title: '标注验证', author: '', format: 'md', text: '# 章节\n\n第一段😀正文。\n\n第二段的正文。\n\n# 后文\n\n另一章。' } })).json();
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  await page.getByRole('navigation', { name: '书架' }).getByRole('button', { name: /标注验证/u }).click();
  await page.getByRole('button', { name: '当前页书签' }).click();
  await expect(page.getByRole('button', { name: '当前页书签' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '阅读记录', exact: true }).click();
  await page.getByLabel('书签备注').fill('重读这里'); await page.getByRole('button', { name: '保存备注' }).click();
  await expect(page.getByRole('button', { name: '保存备注' })).toBeDisabled();
  await page.evaluate(() => {
    const paragraphs = document.querySelectorAll('.reading-flow p');
    const a = paragraphs[0]!.firstChild!, b = paragraphs[1]!.firstChild!;
    const range = document.createRange(); range.setStart(a.firstChild!, 0); range.setEnd(b.firstChild!, 3);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.getByRole('toolbar', { name: '选区操作' }).getByRole('button', { name: '划线', exact: true }).click();
  await expect(page.locator('.reading-flow mark').first()).toBeVisible();
  await page.getByRole('tab', { name: '划线', exact: true }).click();
  await expect(page.locator('.reading-record-panel blockquote')).toHaveText('第一段😀正文。\n第二段');
  await page.screenshot({ path: testInfo.outputPath('reading-annotations-desktop.png') });
  await page.reload(); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  await expect(page.locator('.reading-flow mark').first()).toBeVisible();
  const records = await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/annotations`)).json();
  expect(records.records.find((r: { kind: string }) => r.kind === 'bookmark').remark).toBe('重读这里');
  await page.getByRole('button', { name: '阅读记录', exact: true }).click();
  await page.getByRole('tab', { name: '划线', exact: true }).click();
  await page.getByRole('button', { name: '定位原文', exact: true }).click();
  await expect(page.getByRole('button', { name: '返回阅读处' })).toBeVisible();
  await page.getByRole('button', { name: '移除划线' }).click();
  await expect(page.locator('.reading-flow mark')).toHaveCount(0);
});

test('原生分页无丢字或重叠，字号和宽度变化保留原文锚点', async ({ page, request }, testInfo) => {
  const text = '# 起点\n\n' + '长段落中的文字😀和组合字符e\u0301。'.repeat(300) + '\n\n下一段原文。\n\n# 终点\n\n最后一段。';
  const book = await (await request.post(`${fakeApiRoot}/api/reading/books`, { data: { commandId: 'pagination-book', title: '分页验证', author: '', format: 'md', text } })).json();
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  await page.getByRole('navigation', { name: '书架' }).getByRole('button', { name: /分页验证/u }).click();
  await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeEnabled();
  const readScene = () => page.evaluate(id => JSON.parse(localStorage.getItem(`multivac.reading.scene.${id}`)!), book.id);
  await page.getByLabel('页码', { exact: true }).fill('3'); await page.getByRole('button', { name: '跳转', exact: true }).click();
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('3');
  const original = (await readScene()).position;
  await page.getByRole('button', { name: '字号', exact: true }).click();
  await page.getByRole('slider').fill('26');
  await expect.poll(async () => (await readScene()).fontSize).toBe(26);
  expect((await readScene()).position).toEqual(original);
  await page.getByRole('slider').press('Escape');
  await page.setViewportSize({ width: 1120, height: 760 });
  await expect(page.locator('.reading-flow')).toBeVisible();
  expect((await readScene()).position).toEqual(original);
  const ranges = await page.evaluate(async bookId => {
    const book = await (await fetch(`/api/reading/books/${bookId}`)).json();
    // 在真实 DOM 上调用同一原生布局读取器，验证稳定段落被完整覆盖。
    const modulePath = '/src/features/reading/reading-layout.ts';
    const { measureReadingPages } = await import(modulePath);
    const viewport = document.querySelector('.reading-page-viewport') as HTMLElement;
    return measureReadingPages(book, document.querySelector('.reading-flow'), viewport.clientWidth);
  }, book.id);
  const ps = book.chapters.flatMap((c: { id: string; paragraphs: { id: string; text: string }[] }) => c.paragraphs.map(p => ({ ...p, chapterId: c.id })));
  for (const p of ps) {
    const covered = ranges.filter((r: { start: { paragraphId: string }; end: { paragraphId: string } }) => {
      const a = ps.findIndex((item: { id: string }) => item.id === r.start.paragraphId), b = ps.findIndex((item: { id: string }) => item.id === r.end.paragraphId), i = ps.indexOf(p);
      return a <= i && b >= i;
    }).map((r: { start: { paragraphId: string; offset: number }; end: { paragraphId: string; offset: number } }) => p.text.slice(r.start.paragraphId === p.id ? r.start.offset : 0, r.end.paragraphId === p.id ? r.end.offset : p.text.length)).join('');
    expect(covered).toBe(p.text);
  }
  await page.screenshot({ path: testInfo.outputPath('reading-pagination-desktop.png') });
  await page.reload(); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  await expect(page.locator('.reading-toolbar h2')).toHaveText('分页验证');
  expect((await readScene()).position).toEqual(original);
  await page.getByRole('button', { name: '目录', exact: true }).click();
  await page.getByRole('navigation', { name: '目录' }).getByRole('button', { name: '终点', exact: true }).click();
  await expect(page.locator('.reading-chapter-title')).toContainText('终点');
  await page.getByRole('button', { name: '返回阅读处', exact: true }).click();
  expect((await readScene()).position).toEqual(original);
});
