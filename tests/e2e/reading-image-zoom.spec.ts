import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { Book, BookIndex } from '@multivac/contracts';
import { epub, epubFiles } from '../../apps/server/tests/fixtures/binary-books.js';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

async function imageBook(request: APIRequestContext, large = false): Promise<Book> {
  const files: Record<string, string | Uint8Array> = epubFiles();
  const chapters = {
    cover: '<img src="large.png" alt="封面细节"/>',
    mixed: '<p>前文<img src="small.png" alt="图文中的插图"/>后文与图注。</p>',
    multiple: '<p><img src="small.png" alt="上图"/><img src="small.png" alt="下图"/></p>',
    text: Array.from({ length: large ? 140 : 1 }, (_, i) => `<p>第${i}段：文字页用于验证阅读位置。</p>`).join(''),
    spanning: `<p>${'图前长段落。'.repeat(150)}<img src="large.png" alt="跨页段落的整页图片"/>${'图后长段落。'.repeat(150)}</p>`,
  };
  const order = large ? ['text', 'cover', 'mixed', 'multiple', 'spanning'] : Object.keys(chapters);
  files['OPS/book.opf'] = `<package version="3.0"><manifest>${order.map(id => `<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${order.map(id => `<itemref idref="${id}"/>`).join('')}</spine></package>`;
  for (const [id, body] of Object.entries(chapters)) files[`OPS/${id}.xhtml`] = `<html><head><title>${id}</title></head><body>${body}</body></html>`;
  files['OPS/large.png'] = await sharp(Buffer.from('<svg width="700" height="1000"><rect width="700" height="1000" fill="#edf2f7"/><path d="M 0 0 L 700 1000 M 700 0 L 0 1000" stroke="#33424f" stroke-width="8"/><text x="80" y="150" font-size="40">Image page details</text><rect x="80" y="300" width="540" height="400" fill="#aeb9c5"/></svg>')).png().toBuffer();
  files['OPS/small.png'] = await sharp({ create: { width: 200, height: 90, channels: 4, background: '#78889a' } }).png().toBuffer();
  const response = await request.post(`${fakeApiRoot}/api/reading/books`, { data: { commandId: crypto.randomUUID(), title: `${large ? '跨块图片缩放' : '图片页缩放'}-${crypto.randomUUID().slice(0, 8)}`, author: '', format: 'epub', dataBase64: epub(files).toString('base64') } });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function continuousImageBook(request: APIRequestContext, count = 3): Promise<Book> {
  const files: Record<string, string | Uint8Array> = epubFiles();
  const chapters = Array.from({ length: count }, (_, i) => `image-${i + 1}`).concat('mixed', 'text');
  files['OPS/book.opf'] = `<package version="3.0"><manifest>${chapters.map(id => `<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${chapters.map(id => `<itemref idref="${id}"/>`).join('')}</spine></package>`;
  for (let i = 0; i < count; i++) {
    const body = count === 3 && i === 2 ? '<p><img src="small.png" alt="上图"/><img src="small.png" alt="下图"/></p>' : `<p><img src="${i % 2 ? 'landscape' : 'portrait'}.png" alt="连续图片${i + 1}"/></p>`;
    files[`OPS/image-${i + 1}.xhtml`] = `<html><head><title>图片${i + 1}</title></head><body>${body}</body></html>`;
  }
  files['OPS/mixed.xhtml'] = '<html><head><title>混排页</title></head><body><p>前文<img src="small.png" alt="含正文图注的图片"/>正文图注。</p></body></html>';
  files['OPS/text.xhtml'] = '<html><head><title>文字页</title></head><body><p>纯文字正文。</p></body></html>';
  for (const [name, width, height] of [['portrait', 700, 1000], ['landscape', 1400, 1000], ['small', 200, 90]] as const) files[`OPS/${name}.png`] = await sharp({ create: { width, height, channels: 4, background: '#78889a' } }).png().toBuffer();
  const response = await request.post(`${fakeApiRoot}/api/reading/books`, { data: { commandId: crypto.randomUUID(), title: `连续图片翻页-${crypto.randomUUID().slice(0, 8)}`, author: '', format: 'epub', dataBase64: epub(files).toString('base64') } });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function zoomView(page: Page) {
  return page.getByRole('region', { name: '放大的图片页' }).evaluate(element => {
    const viewport = element.getBoundingClientRect();
    const boxes = [...element.querySelectorAll('.reading-image-zoom-frame')].map(frame => frame.getBoundingClientRect());
    const left = Math.min(...boxes.map(box => box.left)), top = Math.min(...boxes.map(box => box.top));
    const width = Math.max(...boxes.map(box => box.right)) - left, height = Math.max(...boxes.map(box => box.bottom)) - top;
    const originX = viewport.left + element.clientLeft, originY = viewport.top + element.clientTop;
    return { x: (originX + element.clientWidth / 2 - left) / width, y: (originY + element.clientHeight / 2 - top) / height,
      left: element.scrollLeft, top: element.scrollTop, maxLeft: element.scrollWidth - element.clientWidth, maxTop: element.scrollHeight - element.clientHeight,
      boundLeft: left - originX + element.scrollLeft, boundTop: top - originY + element.scrollTop, width, height, viewportWidth: element.clientWidth, viewportHeight: element.clientHeight };
  });
}

async function expectCarriedView(page: Page, previous: Awaited<ReturnType<typeof zoomView>>) {
  await expect(page.getByLabel('图片页缩放比例')).toHaveText('300%');
  await expect(page.getByRole('region', { name: '放大的图片页' }).locator('.reading-image-feedback')).toHaveCount(0);
  const next = await zoomView(page);
  expect(next.left).toBeCloseTo(Math.max(0, Math.min(next.maxLeft, next.boundLeft + previous.x * next.width - next.viewportWidth / 2)), 0);
  expect(next.top).toBeCloseTo(Math.max(0, Math.min(next.maxTop, next.boundTop + previous.y * next.height - next.viewportHeight / 2)), 0);
}

async function clearWindows(page: Page, book: Book) {
  await page.evaluate(async id => {
    const path = '/src/features/reading/reading-window-cache.ts';
    const { clearBookWindows } = await import(path);
    clearBookWindows(id);
  }, book.id);
}

async function openBook(page: Page, book: Book) {
  await page.goto('/');
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
  if (page.viewportSize()!.width <= 760) await page.getByRole('button', { name: '读书', exact: true }).click();
  else {
    await openPanel(page, 'management');
    await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  }
  await page.getByRole('navigation', { name: '书架' }).getByRole('button', { name: new RegExp(book.title) }).click();
  await expect(page.getByLabel('页码', { exact: true })).toBeEnabled();
}

async function measuredPages(page: Page, book: Book) {
  return page.evaluate(async id => {
    const scene = JSON.parse(localStorage.getItem(`multivac.reading.scene.${id}`)!);
    const index = await (await fetch(`/api/reading/books/${id}/index`)).json();
    const block = index.chapters.find((c: any) => c.id === scene.position.chapterId).paragraphs.find((p: any) => p.id === scene.position.paragraphId).block;
    const window = await (await fetch(`/api/reading/books/${id}/content?block=${block}`)).json();
    const path = '/src/features/reading/reading-layout.ts';
    const { measureReadingPages } = await import(path);
    const viewport = document.querySelector('.reading-page-viewport') as HTMLElement;
    return measureReadingPages(window.book, document.querySelector('.reading-flow'), viewport.clientWidth);
  }, book.id);
}

const sceneOf = (page: Page, book: Book) => page.evaluate(id => JSON.parse(localStorage.getItem(`multivac.reading.scene.${id}`)!), book.id);
async function jump(page: Page, n: number) {
  await page.getByLabel('页码', { exact: true }).fill(String(n));
  await page.getByRole('button', { name: '跳转', exact: true }).click();
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue(String(n));
}

test.beforeEach(async ({ request }) => { await resetE2eState(request); });

for (const narrow of [false, true]) test(`纯图片页页内缩放、移动与适配保持分页和原文锚点${narrow ? '（窄屏）' : ''}`, async ({ page, request }, testInfo) => {
  const book = await imageBook(request);
  await page.setViewportSize({ width: narrow ? 390 : 1440, height: 900 });
  await openBook(page, book);
  const controls = page.getByRole('group', { name: '图片页缩放' });
  const enlarge = controls.getByRole('button', { name: '放大图片页' });
  const stage = page.getByRole('region', { name: '放大的图片页' });
  const original = page.locator('.reading-flow .reading-image').first();
  await expect(enlarge).toBeEnabled();
  await expect(controls.getByRole('button', { name: '缩小图片页' })).toBeDisabled();
  const before = await measuredPages(page, book);
  const originalScene = await sceneOf(page, book);
  const box = (await original.boundingBox())!;
  const pageTotal = await page.locator('.reading-pagination form > span').textContent();
  await enlarge.click(); await enlarge.click();
  await expect(controls.getByLabel('图片页缩放比例')).toHaveText('200%');
  await expect(stage).toBeVisible();
  await expect(stage.locator('.reading-image-feedback')).toHaveCount(0);
  const enlarged = (await stage.locator('.reading-image').first().boundingBox())!;
  expect(enlarged.width).toBeCloseTo(box.width * 2, 0);
  expect(enlarged.height).toBeCloseTo(box.height * 2, 0);
  expect((await measuredPages(page, book)).map(p => p.reference)).toEqual(before.map(p => p.reference));
  expect((await sceneOf(page, book)).position).toEqual(originalScene.position);
  expect((await sceneOf(page, book)).imageId).toBe(originalScene.imageId);
  await expect(page.locator('.reading-pagination form > span')).toHaveText(pageTotal!);

  await stage.focus();
  const scrollBefore = await stage.evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop }));
  await stage.press('ArrowRight');
  await expect.poll(() => stage.evaluate(el => el.scrollLeft)).toBeGreaterThan(scrollBefore.left);
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('1');
  const stageBox = (await stage.boundingBox())!;
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(stageBox.x + stageBox.width / 2 - 40, stageBox.y + stageBox.height / 2 - 60, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => stage.evaluate(el => el.scrollTop)).toBeGreaterThan(scrollBefore.top);
  await page.screenshot({ path: testInfo.outputPath('image-page-zoom.png') });

  await controls.getByRole('button', { name: '适配图片页' }).click();
  await expect(stage).toHaveCount(0);
  expect((await original.boundingBox())!.width).toBeCloseTo(box.width, 0);
  await enlarge.click();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(controls).toHaveCount(0); // 图文混排页不提供缩放。
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(controls.getByLabel('图片页缩放比例')).toHaveText('100%');
  for (let n = 0; n < 6; n++) await enlarge.click();
  await expect(controls.getByLabel('图片页缩放比例')).toHaveText('400%');
  await expect(enlarge).toBeDisabled();
  await controls.getByRole('button', { name: '缩小图片页' }).click();
  await expect(controls.getByLabel('图片页缩放比例')).toHaveText('350%');
  await stage.press('Escape');
  await expect(stage).toHaveCount(0);
  await expect(page.locator('.reading-reader')).toBeVisible();
  await enlarge.click();
  await page.setViewportSize({ width: narrow ? 420 : 1280, height: 800 });
  await expect(controls.getByLabel('图片页缩放比例')).toHaveText('100%');
  expect((await sceneOf(page, book)).position).toEqual(originalScene.position);
});

test('按实际页面分类，支持多图片页，含文字与图注的页面不启用缩放', async ({ page, request }) => {
  const book = await imageBook(request);
  await openBook(page, book);
  const pages = await measuredPages(page, book);
  const multiple = pages.findIndex(p => p.imageOnly && p.imageIds?.length === 2);
  expect(multiple).toBeGreaterThan(0);
  await jump(page, multiple + 1);
  await page.getByRole('button', { name: '放大图片页' }).click();
  const stage = page.getByRole('region', { name: '放大的图片页' });
  await expect(stage.locator('img')).toHaveCount(2);
  await expect(stage.locator('.reading-image-feedback')).toHaveCount(0);
  await expect(stage.locator('img').first()).toHaveAttribute('alt', '上图');
  await expect(stage.locator('img').last()).toHaveAttribute('alt', '下图');
  const text = pages.findIndex(p => !p.imageIds?.length);
  await jump(page, text + 1);
  await expect(page.getByRole('group', { name: '图片页缩放' })).toHaveCount(0);
  const spanning = pages.findIndex(p => p.imageOnly && p.imageIds?.some(id => id.startsWith('c5:')));
  expect(spanning).toBeGreaterThan(0); // 原段落前后都有文字，但中间的实际排版页只有图片。
  await jump(page, spanning + 1);
  await expect(page.getByRole('button', { name: '放大图片页' })).toBeEnabled();
  await page.getByRole('button', { name: '放大图片页' }).click();
  await stage.press('PageDown');
  await expect(stage).toHaveCount(0);
  await expect(page.getByRole('group', { name: '图片页缩放' })).toHaveCount(0);
  await expect(page.getByLabel('书籍正文', { exact: true })).toBeFocused();
  await page.keyboard.press('PageUp');
  await expect(page.getByLabel('图片页缩放比例')).toHaveText('100%');
});

test('缩放后的书签和书伴仍使用同一当前页引用，刷新恢复阅读处和适配比例', async ({ page, request }) => {
  const book = await imageBook(request);
  await openBook(page, book);
  const reference = (await measuredPages(page, book))[0]!.reference;
  await page.getByRole('button', { name: '放大图片页' }).click();
  await page.getByRole('button', { name: '当前页书签' }).click();
  await expect(page.getByRole('button', { name: '当前页书签' })).toHaveAttribute('aria-pressed', 'true');
  const records = await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/annotations`)).json();
  expect(records.records[0].reference).toEqual(reference);
  await page.getByRole('button', { name: '书伴', exact: true }).click();
  await expect(page.getByRole('button', { name: '放大图片页' })).toBeEnabled();
  await page.getByRole('button', { name: '放大图片页' }).click();
  await expect(page.getByRole('region', { name: '放大的图片页' })).toBeVisible();
  let payload: any;
  await page.route('**/api/sessions/*/turns', route => {
    payload = route.request().postDataJSON();
    return route.fulfill({ status: 400, json: { error: { code: 'INVALID_REQUEST', message: '核对本轮当前页来源' } } });
  });
  const companion = page.getByRole('complementary', { name: '书伴', exact: true });
  await companion.getByLabel('向书伴提问').fill('描述当前图片页的说明。');
  await companion.getByRole('button', { name: '发送给书伴' }).click();
  await expect.poll(() => payload?.contextRefs[0]?.pageReference).toEqual(reference);
  await page.reload(); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  await expect(page.getByLabel('图片页缩放比例')).toHaveText('100%');
  await expect(page.getByRole('button', { name: '当前页书签' })).toHaveAttribute('aria-pressed', 'true');
  expect((await measuredPages(page, book))[0]!.reference).toEqual(reference);
});

test('图片加载失败时禁用缩放，重试成功后恢复入口且不改变分页', async ({ page, request }) => {
  const book = await imageBook(request);
  await page.route('**/api/reading/books/*/images/*', route => route.abort());
  await openBook(page, book);
  await expect(page.locator('.reading-image-feedback').first()).toContainText('资源加载失败');
  const enlarge = page.getByRole('button', { name: '放大图片页' });
  await expect(enlarge).toBeDisabled();
  const before = await measuredPages(page, book);
  await page.unroute('**/api/reading/books/*/images/*');
  await page.locator('.reading-image-feedback').first().getByRole('button', { name: '重试图片' }).click();
  await expect(enlarge).toBeEnabled();
  await enlarge.click();
  await expect(page.getByRole('region', { name: '放大的图片页' })).toBeVisible();
  expect((await measuredPages(page, book)).map(p => p.reference)).toEqual(before.map(p => p.reference));
});

test('全书分页缓存与跨块跳转后的纯图片页缩放，翻页后恢复适配', async ({ page, request }) => {
  const book = await imageBook(request, true);
  const index = await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/index`)).json() as BookIndex;
  expect(index.blockCount).toBeGreaterThan(1);
  await openBook(page, book);
  await page.getByRole('button', { name: '目录', exact: true }).click();
  await page.getByRole('navigation', { name: '目录' }).getByRole('button', { name: 'cover', exact: true }).click();
  await expect(page.getByRole('button', { name: '放大图片页' })).toBeEnabled();
  const number = Number(await page.getByLabel('页码', { exact: true }).inputValue());
  const total = await page.locator('.reading-pagination form > span').textContent();
  const reference = (await measuredPages(page, book)).find(p => p.imageOnly)!.reference;
  await page.getByRole('button', { name: '放大图片页' }).click();
  await expect(page.getByRole('region', { name: '放大的图片页' })).toBeVisible();
  await expect(page.locator('.reading-pagination form > span')).toHaveText(total!);
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(page.getByRole('group', { name: '图片页缩放' })).toHaveCount(0);
  await jump(page, number);
  await expect(page.getByLabel('图片页缩放比例')).toHaveText('100%');
  expect((await measuredPages(page, book)).find(p => p.imageOnly)!.reference).toEqual(reference);
});

test('当前页图片请求挂起时提示加载较慢并可重试，旧请求迟到不覆盖重试结果', async ({ page, request }) => {
  const book = await imageBook(request);
  const resourceId = book.chapters[0]!.paragraphs[0]!.images![0]!.resourceId!;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/reading/books/${book.id}/images/${resourceId}*`, async route => {
    if (!route.request().url().includes('?retry=')) await gate;
    // 重试替换 img 节点后，浏览器可能已经取消原请求。
    await route.continue().catch(() => undefined);
  });
  await page.clock.install();
  try {
    await openBook(page, book);
    const image = page.locator('.reading-flow .reading-image').first();
    await expect(image.locator('.reading-image-feedback')).toContainText('正在加载图片');
    await page.clock.fastForward(31_000);
    await expect(image.locator('.reading-image-feedback')).toContainText('图片加载较慢');
    await expect(image.locator('.reading-image-feedback')).not.toContainText('图片不可用');
    await expect(page.getByRole('button', { name: '放大图片页' })).toBeDisabled();
    await image.getByRole('button', { name: '重试图片' }).click();
    await expect(image.locator('.reading-image-feedback')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '放大图片页' })).toBeEnabled();
    release();
    await expect(image.locator('img')).toHaveAttribute('src', /\?retry=1$/);
    await expect(image.locator('.reading-image-feedback')).toHaveCount(0);
  } finally { release(); }
});

test('图片已经下载和解码但 load 事件漏发时，正文和缩放层都退出加载状态', async ({ page, request }) => {
  const book = await imageBook(request);
  // 模拟浏览器完成图片请求，却没有把 load 事件交给组件的情况。
  await page.addInitScript(() => document.addEventListener('load', event => {
    if (event.target instanceof HTMLImageElement && event.target.closest('.reading-image')) event.stopImmediatePropagation();
  }, true));
  await openBook(page, book);
  const original = page.locator('.reading-flow .reading-image').first();
  await expect.poll(() => original.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(original.locator('.reading-image-feedback')).toHaveCount(0);
  const enlarge = page.getByRole('button', { name: '放大图片页' });
  await expect(enlarge).toBeEnabled();
  for (let attempt = 0; attempt < 3; attempt++) {
    await enlarge.click();
    const stage = page.getByRole('region', { name: '放大的图片页' });
    await expect(stage.locator('.reading-image-feedback')).toHaveCount(0);
    await expect.poll(() => stage.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await page.getByRole('button', { name: '适配图片页' }).click();
  }
});

for (const narrow of [false, true]) test(`连续纯图片页保留倍率和相对位置，混排与文字页清除状态${narrow ? '（窄屏）' : ''}`, async ({ page, request }) => {
  const book = await continuousImageBook(request);
  await page.setViewportSize({ width: narrow ? 390 : 1440, height: 900 });
  await openBook(page, book);
  const before = (await measuredPages(page, book)).map(p => p.reference);
  const stage = page.getByRole('region', { name: '放大的图片页' });
  for (let n = 0; n < 4; n++) await page.getByRole('button', { name: '放大图片页' }).click();
  await stage.evaluate(element => { element.scrollLeft = element.scrollWidth * .3; element.scrollTop = element.scrollHeight * .1; });
  let view = await zoomView(page);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('2');
  await expectCarriedView(page, view);
  await expect(stage.locator('img')).toHaveAttribute('alt', '连续图片2');
  await page.getByRole('button', { name: '当前页书签' }).click();
  await expect(page.getByRole('button', { name: '当前页书签' })).toHaveAttribute('aria-pressed', 'true');
  const annotations = await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/annotations`)).json();
  expect(annotations.records[0].reference).toEqual(before[1]);
  view = await zoomView(page);
  await stage.press('PageDown');
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('3');
  await expectCarriedView(page, view);
  await expect(stage).toBeFocused();
  await expect(stage.locator('img')).toHaveCount(2);
  for (const number of ['2', '1']) {
    view = await zoomView(page);
    await stage.press('PageUp');
    await expect(page.getByLabel('页码', { exact: true })).toHaveValue(number);
    await expectCarriedView(page, view);
    await expect(stage).toBeFocused();
  }
  view = await zoomView(page);
  await stage.press('PageUp');
  await expectCarriedView(page, view); // 已在书首时不翻页，也不重置倍率。
  expect((await measuredPages(page, book)).map(p => p.reference)).toEqual(before);
  await jump(page, 3);
  await expect(page.getByLabel('图片页缩放比例')).toHaveText('100%');
  for (let n = 0; n < 4; n++) await page.getByRole('button', { name: '放大图片页' }).click();
  await stage.press('PageDown');
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('4');
  await expect(page.getByRole('group', { name: '图片页缩放' })).toHaveCount(0);
  await expect(page.getByLabel('书籍正文', { exact: true })).toBeFocused();
  await page.keyboard.press('PageDown');
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('5');
  await expect(stage).toHaveCount(0);
  await page.keyboard.press('PageUp'); await page.keyboard.press('PageUp');
  await expect(page.getByLabel('图片页缩放比例')).toHaveText('100%');
  await expect(stage).toHaveCount(0);
  await page.getByRole('button', { name: '放大图片页' }).click();
  await page.getByRole('button', { name: '字号', exact: true }).click();
  await page.getByRole('slider', { name: '字号', exact: true }).press('ArrowRight');
  await expect(page.getByLabel('图片页缩放比例')).toHaveText('100%');
});

test('跨块连续图片页在加载失败与延迟恢复后保留倍率、位置和键盘焦点', async ({ page, request }) => {
  const book = await continuousImageBook(request, 66);
  const index = await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/index`)).json() as BookIndex;
  expect(index.chapters[63]!.paragraphs[0]!.block).toBe(0);
  expect(index.chapters[64]!.paragraphs[0]!.block).toBe(1);
  await openBook(page, book);
  await jump(page, 64);
  const stage = page.getByRole('region', { name: '放大的图片页' });
  for (let n = 0; n < 4; n++) await page.getByRole('button', { name: '放大图片页' }).click();
  await stage.evaluate(element => { element.scrollLeft = element.scrollWidth * .3; element.scrollTop = element.scrollHeight * .1; });
  const original = await zoomView(page);
  await clearWindows(page, book);
  let fail = true;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/reading/books/${book.id}/content?block=1`, async route => {
    if (fail) { fail = false; await route.fulfill({ status: 503, json: { error: { code: 'INVALID_REQUEST', message: '目标页正文暂时不可用' } } }); return; }
    await gate; await route.continue();
  });
  try {
    await stage.press('PageDown');
    await expect(page.getByRole('alert')).toContainText('目标页正文暂时不可用');
    await expect(page.getByLabel('页码', { exact: true })).toHaveValue('64');
    await expectCarriedView(page, original);
    await expect(stage).toBeFocused();
    await stage.press('PageDown');
    await expect(page.locator('.reading-status')).toContainText('正在读取正文');
    await expect(stage).toHaveCount(0);
    release();
    await expect(page.getByLabel('页码', { exact: true })).toHaveValue('65');
    await expectCarriedView(page, original);
    await expect(stage).toBeFocused();
    for (const [key, number] of [['PageDown', '66'], ['PageUp', '65'], ['PageUp', '64']] as const) {
      const view = await zoomView(page);
      await stage.press(key);
      await expect(page.getByLabel('页码', { exact: true })).toHaveValue(number);
      await expectCarriedView(page, view);
      await expect(stage).toBeFocused();
    }
  } finally { release(); }
});

test('跨块遇到含图片的混排页直接恢复默认，回到纯图片页也不恢复旧状态', async ({ page, request }) => {
  const book = await continuousImageBook(request, 64);
  await openBook(page, book); await jump(page, 64);
  for (let n = 0; n < 4; n++) await page.getByRole('button', { name: '放大图片页' }).click();
  await page.getByRole('region', { name: '放大的图片页' }).press('PageDown');
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('65');
  await expect(page.getByRole('group', { name: '图片页缩放' })).toHaveCount(0);
  await expect(page.getByLabel('书籍正文', { exact: true })).toBeFocused();
  await page.keyboard.press('PageUp');
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('64');
  await expect(page.getByLabel('图片页缩放比例')).toHaveText('100%');
  await expect(page.getByRole('region', { name: '放大的图片页' })).toHaveCount(0);
});

test('跨块加载途中窗口重新排版会清除待恢复的图片缩放状态', async ({ page, request }) => {
  const book = await continuousImageBook(request, 66);
  await openBook(page, book); await jump(page, 64);
  for (let n = 0; n < 4; n++) await page.getByRole('button', { name: '放大图片页' }).click();
  await clearWindows(page, book);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/reading/books/${book.id}/content?block=1`, async route => { await gate; await route.continue(); });
  try {
    await page.getByRole('region', { name: '放大的图片页' }).press('PageDown');
    await expect(page.locator('.reading-status')).toContainText('正在读取正文');
    await page.setViewportSize({ width: 1280, height: 800 });
    release();
    await expect(page.getByLabel('页码', { exact: true })).toHaveValue('65');
    await expect(page.getByLabel('图片页缩放比例')).toHaveText('100%');
    await expect(page.getByRole('region', { name: '放大的图片页' })).toHaveCount(0);
  } finally { release(); }
});
