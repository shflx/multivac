import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';
import { visualPdf } from '../../apps/server/tests/fixtures/pdf-page-visual.js';
import { textPdf } from '../../apps/server/tests/fixtures/binary-books.js';

async function resume(page: Page) {
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
  if (page.viewportSize()!.width <= 760) {
    await page.getByRole('button', { name: '读书', exact: true }).click();
  } else {
    await openPanel(page, 'management');
    await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  }
}
async function openPdf(page: Page, request: APIRequestContext, source = visualPdf()) {
  const title = `原页验证-${crypto.randomUUID()}`;
  const response = await request.post(`${fakeApiRoot}/api/reading/books/upload?${new URLSearchParams({ commandId: crypto.randomUUID(), title, author: '', format: 'pdf' })}`, { headers: { 'content-type': 'application/octet-stream' }, data: source });
  expect(response.ok()).toBe(true);
  const book = await response.json();
  await page.goto('/'); await resume(page);
  await page.getByRole('navigation', { name: '书架' }).getByRole('button', { name: new RegExp(book.title) }).click();
  return book;
}
async function ready(page: Page, text: string) {
  await expect(page.locator('.reading-pdf-text-layer')).toContainText(text);
  await expect(page.getByRole('button', { name: '当前页书签' })).toBeEnabled();
}
async function select(page: Page, text: string) {
  await page.locator('.reading-pdf-text-layer span').filter({ hasText: text }).first().evaluate((element, text) => {
    const node = element.firstChild!; const offset = (node.textContent ?? '').indexOf(text);
    const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + text.length);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, text);
  await expect(page.getByRole('toolbar', { name: '选区操作' })).toContainText(text);
}

test.beforeEach(async ({ request }) => { await resetE2eState(request); });

test('原图、向量图、公式与表格真实绘制；选区复制、划线、页书签、笔记与缩放后恢复', async ({ page, request }, testInfo) => {
  const book = await openPdf(page, request); await ready(page, 'First PDF layout');
  await page.getByRole('button', { name: 'PDF 缩放', exact: true }).click();
  await page.getByRole('button', { name: '适合宽度', exact: true }).click();
  await page.getByRole('button', { name: '关闭阅读设置' }).click();
  await page.getByRole('button', { name: '跳转', exact: true }).click();
  await ready(page, 'First PDF layout');
  expect(await page.locator('.reading-pdf-sheet canvas').evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext('2d')!;
    const chart = [...context.getImageData(Math.floor(canvas.width * 260 / 600), Math.floor(canvas.height * 220 / 800), 1, 1).data];
    const image = [...context.getImageData(Math.floor(canvas.width * 55 / 600), Math.floor(canvas.height * 175 / 800), 1, 1).data];
    return { chartBlue: chart[0]! < 50 && chart[2]! > 150, imageColored: Math.max(...image.slice(0, 3)) - Math.min(...image.slice(0, 3)) > 100 };
  })).toEqual({ chartBlue: true, imageColored: true });
  await expect(page.locator('.reading-pdf-text-layer')).toContainText('Table A');
  await select(page, 'First');
  expect(await page.locator('.reading-pdf-viewport').evaluate(element => {
    const clipboard = new DataTransfer(); const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: clipboard });
    element.dispatchEvent(event); return clipboard.getData('text/plain');
  })).toBe('First');
  await page.getByRole('toolbar', { name: '选区操作' }).getByRole('button', { name: '划线', exact: true }).click();
  await expect(page.locator('.reading-pdf-highlight')).not.toHaveCount(0);
  const normalized = () => page.locator('.reading-pdf-highlight').first().evaluate(element => {
    const mark = element.getBoundingClientRect(), sheet = element.closest('.reading-pdf-sheet')!.getBoundingClientRect();
    return { x: (mark.left - sheet.left) / sheet.width, y: (mark.top - sheet.top) / sheet.height };
  });
  const before = await normalized();
  await page.getByRole('button', { name: '当前页书签' }).click();
  await select(page, 'First');
  await page.getByRole('toolbar', { name: '选区操作' }).getByRole('button', { name: '写笔记', exact: true }).click();
  await page.getByLabel('笔记内容').fill('原页选区笔记'); await page.getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(page.getByLabel('笔记内容')).toHaveCount(0);
  await page.getByRole('button', { name: 'PDF 缩放', exact: true }).click();
  await page.getByLabel('PDF 缩放比例').fill('2');
  await page.getByRole('button', { name: '关闭阅读设置' }).click();
  await ready(page, 'First PDF layout');
  const after = await normalized(); expect(after.x).toBeCloseTo(before.x, 2); expect(after.y).toBeCloseTo(before.y, 2);
  await page.screenshot({ path: testInfo.outputPath('pdf-original-page-zoom.png'), animations: 'disabled' });
  await page.reload(); await resume(page); await ready(page, 'First PDF layout');
  await expect(page.getByRole('button', { name: 'PDF 缩放', exact: true })).toHaveText('200%');
  await expect(page.getByRole('button', { name: '当前页书签' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.reading-pdf-highlight')).not.toHaveCount(0);
  const annotations = await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/annotations`)).json();
  expect(annotations.records.find((r: { kind: string }) => r.kind === 'highlight').reference.text).toBe('First');
  const notes = await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/notes`)).json();
  expect(notes.notes[0].reference.text).toBe('First');
});

test('旧选区与当前原页分别固定，翻页后书伴来源只含实际可见页', async ({ page, request }) => {
  await openPdf(page, request); await ready(page, 'First PDF layout'); await select(page, 'First');
  await page.getByRole('toolbar', { name: '选区操作' }).getByRole('button', { name: '问书伴', exact: true }).click();
  await page.getByRole('button', { name: '下一页', exact: true }).click(); await ready(page, 'Second PDF layout');
  const bodies: any[] = [];
  await page.route('**/api/sessions/*/turns', async route => { bodies.push(route.request().postDataJSON()); await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INVALID_REQUEST', message: '已捕获验收请求' } }) }); });
  await page.getByLabel('向书伴提问').fill('解释选区与本页。'); await page.getByRole('button', { name: '发送给书伴' }).click();
  await expect.poll(() => bodies.length).toBe(1);
  const ref = bodies[0].contextRefs[0]; expect(ref.referenceKind).toBe('selection'); expect(ref.reference.text).toBe('First');
  expect(ref.pageReference.start.chapterId).toBe('c2'); expect(ref.pageReference.end.chapterId).toBe('c2');
  expect(ref.pageReference.text).toContain('Second PDF layout'); expect(ref.pageReference.text).not.toContain('First PDF layout');
});

test('原文件失败保留书籍与记录，重试恢复原页', async ({ page, request }) => {
  await page.route('**/pdf/source', route => route.abort('failed'));
  await openPdf(page, request);
  await expect(page.locator('.reading-pdf-feedback[role=alert]')).toContainText('加载失败');
  await expect(page.getByRole('button', { name: '当前页书签' })).toBeDisabled();
  await page.unroute('**/pdf/source'); await page.getByRole('button', { name: '重试原页加载' }).click(); await ready(page, 'First PDF layout');
});

test('当前页正文失败时禁用书伴与标注，重试不沿用前页来源', async ({ page, request }) => {
  await openPdf(page, request); await ready(page, 'First PDF layout');
  await page.getByRole('button', { name: '书伴', exact: true }).click();
  await expect(page.getByLabel('向书伴提问')).toBeEditable();
  await page.route('**/pdf/pages/2', route => route.abort('failed'));
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.reading-pdf-feedback[role=alert]')).toContainText('加载失败');
  await page.getByLabel('向书伴提问').fill('不能使用前页来源。');
  await expect(page.getByRole('button', { name: '发送给书伴' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '当前页书签' })).toBeDisabled();
  await page.unroute('**/pdf/pages/2'); await page.getByRole('button', { name: '重试原页加载' }).click();
  await ready(page, 'Second PDF layout'); await expect(page.getByRole('button', { name: '发送给书伴' })).toBeEnabled();
});

test('Worker 资源失败提供明确错误和重试入口', async ({ page, request }) => {
  const worker = /pdf\.worker.*\.mjs(?:\?import)?$/u;
  await page.route(worker, route => route.abort('failed'));
  await openPdf(page, request);
  await expect(page.locator('.reading-pdf-feedback[role=alert]')).toContainText('加载失败');
  await expect(page.getByRole('button', { name: '当前页书签' })).toBeDisabled();
  await page.unroute(worker); await page.getByRole('button', { name: '重试原页加载' }).click();
  await ready(page, 'First PDF layout');
});

test('大文件采用范围读取，窄屏缩放、翻页、页码和刷新恢复可用', async ({ page, request }, testInfo) => {
  test.setTimeout(120000);
  const ranges: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/pdf/source') && request.headers().range) ranges.push(request.headers().range!); });
  await page.setViewportSize({ width: 390, height: 740 });
  await openPdf(page, request, textPdf(['Large page one.', 'Large page two.'], 21 * 1024 * 1024)); await ready(page, 'Large page one.');
  await expect.poll(() => ranges.length).toBeGreaterThan(0);
  await expect(page.locator('.reading-pdf-sheet canvas')).toBeVisible();
  await page.getByRole('button', { name: '下一页', exact: true }).click(); await ready(page, 'Large page two.');
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('2');
  await page.getByRole('button', { name: 'PDF 缩放', exact: true }).click(); await page.getByLabel('PDF 缩放比例').fill('2');
  await page.getByRole('button', { name: '关闭阅读设置' }).click(); await ready(page, 'Large page two.');
  await page.screenshot({ path: testInfo.outputPath('pdf-narrow.png'), animations: 'disabled' });
  await page.reload(); await resume(page); await ready(page, 'Large page two.');
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('2');
});
