import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { epub, illustratedEpubFiles } from '../../apps/server/tests/fixtures/binary-books.js';
import { fakeApiRoot, openPanel } from './test-state.js';

for (const narrow of [false, true]) test(`EPUB 图文顺序、字号、资源失败与刷新恢复${narrow ? '（窄屏）' : ''}`, async ({ page, request }, testInfo) => {
  const files = illustratedEpubFiles();
  files['OPS/Images/cover.png'] = await sharp({ create: { width: 200, height: 300, channels: 4, background: '#445577' } }).png().toBuffer();
  files['OPS/Images/chart one.png'] = await sharp({ create: { width: 300, height: 120, channels: 4, background: '#aaccee' } }).png().toBuffer();
  const response = await request.post(`${fakeApiRoot}/api/reading/books`, { data: { commandId: crypto.randomUUID(), title: `图文验收${narrow ? '窄屏' : '桌面'}`, author: '', format: 'epub', dataBase64: epub(files).toString('base64') } });
  expect(response.ok()).toBeTruthy();
  const book = await response.json();
  await page.setViewportSize({ width: narrow ? 390 : 1280, height: 800 });
  await page.goto('/');
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
  if (narrow) await page.getByRole('button', { name: '读书', exact: true }).click();
  else {
    await openPanel(page, 'management');
    await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  }
  await page.getByRole('navigation', { name: '书架' }).getByRole('button', { name: new RegExp(book.title) }).click();
  await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeEnabled();
  // 书架仅保留导入与删除，顶栏可切换；窄屏仍能返回正文。
  await page.getByRole('button', { name: '书架', exact: true }).click();
  const navigation = page.getByRole('complementary', { name: '阅读导航', exact: true });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole('button', { name: /补建图文|收起导航/ })).toHaveCount(0);
  if (narrow) await navigation.getByRole('button', { name: '返回正文', exact: true }).click();
  else await page.getByRole('button', { name: '书架', exact: true }).click();
  await expect(navigation).toBeHidden();
  const resource = await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/index`);
  const index = await resource.json();
  for (const id of index.imageResources) {
    const png = await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/images/${id}`);
    expect(png.ok()).toBeTruthy(); expect(png.headers()['content-type']).toBe('image/png'); expect(png.headers()['x-content-type-options']).toBe('nosniff');
    expect(png.headers()['cache-control']).toBe('private, max-age=31536000, immutable');
  }
  const visible = () => page.locator('.reading-page-viewport').evaluate(viewport => {
    const frame = viewport.getBoundingClientRect();
    return [...viewport.querySelectorAll<HTMLElement>('[data-reading-image]')].filter(image => {
      const rect = image.getBoundingClientRect();
      return rect.right > frame.left + 1 && rect.left < frame.right - 1 && rect.top < frame.bottom && rect.bottom > frame.top;
    }).map(image => image.dataset.readingImage!);
  });
  // 每页按浏览器可见矩形收集图片，完整遍历后必须与源顺序一致且不重复。
  const expected = book.chapters.flatMap((chapter: any) => chapter.paragraphs.flatMap((p: any) => (p.images ?? []).map((image: any) => image.id)));
  const seen: string[] = [];
  const count = Number((await page.locator('.reading-pagination form > span').textContent())!.match(/\d+/)![0]);
  for (let n = 0; n < count; n++) {
    seen.push(...await visible());
    if (n + 1 < count) await page.getByRole('button', { name: '下一页', exact: true }).click();
  }
  expect(seen).toEqual(expected);
  await page.getByLabel('页码', { exact: true }).fill('1'); await page.getByRole('button', { name: '跳转', exact: true }).click();
  const before = await visible(); expect(before).toHaveLength(1);
  await page.getByRole('button', { name: '字号', exact: true }).click(); await page.getByRole('slider').press('Home');
  for (let n = 0; n < 7; n++) await page.getByRole('slider').press('ArrowRight');
  await page.getByRole('button', { name: '关闭字号设置' }).click();
  await expect.poll(visible).toEqual(before);
  await expect(page.getByRole('button', { name: '当前页书签' })).toBeEnabled();
  await page.getByRole('button', { name: '当前页书签' }).click();
  await expect(page.getByRole('button', { name: '当前页书签' })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath('epub-cover.png'), animations: 'disabled' });
  await page.reload();
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
  if (narrow) await page.getByRole('button', { name: '读书', exact: true }).click();
  else {
    await openPanel(page, 'management');
    await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  }
  await expect.poll(visible).toEqual(before);
  await expect(page.getByRole('button', { name: '当前页书签' })).toHaveAttribute('aria-pressed', 'true');
  // 页面上下文只带正在显示的封面，不混入后续图文；此处拦截模型请求供证据核对。
  let payload: any;
  await page.route('**/api/sessions/*/turns', route => {
    payload = route.request().postDataJSON();
    return route.fulfill({ status: 400, json: { error: { code: 'INVALID_REQUEST', message: '测试固定本轮上下文' } } });
  });
  await page.getByRole('button', { name: '书伴', exact: true }).click();
  const companion = page.getByRole('complementary', { name: '书伴', exact: true });
  await expect(companion).toContainText('暂不理解图像内容');
  await companion.getByLabel('向书伴提问').fill('说明当前页。');
  await companion.getByRole('button', { name: '发送给书伴' }).click();
  await expect.poll(() => payload?.contextRefs[0]?.pageReference.imageIds).toEqual(before);
  expect(payload.contextRefs[0].pageReference.text).not.toMatch(/前文|后文|矢量图表|整页图表/);
});

test('下载失败显示明确反馈；重试保持相同页面和图片几何', async ({ page, request }) => {
  const files = illustratedEpubFiles();
  files['OPS/Images/cover.png'] = await sharp({ create: { width: 200, height: 300, channels: 4, background: '#445577' } }).png().toBuffer();
  const book = await (await request.post(`${fakeApiRoot}/api/reading/books`, { data: { commandId: crypto.randomUUID(), title: '图片下载重试', author: '', format: 'epub', dataBase64: epub(files).toString('base64') } })).json();
  await page.route('**/api/reading/books/*/images/*', route => route.abort());
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  await page.getByRole('navigation', { name: '书架' }).getByRole('button', { name: new RegExp(book.title) }).click();
  await expect(page.locator('.reading-image-feedback').first()).toContainText('资源加载失败');
  const image = page.locator('.reading-image').first(), before = await image.boundingBox();
  const pageNumber = await page.getByLabel('页码', { exact: true }).inputValue();
  await page.unroute('**/api/reading/books/*/images/*');
  await image.getByRole('button', { name: '重试图片' }).click();
  await expect(image.locator('.reading-image-feedback')).toHaveCount(0);
  expect(await image.boundingBox()).toEqual(before);
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue(pageNumber);
});
