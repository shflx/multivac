import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

const sentence = 'you can outsource your thinking, but you cannot outsource your understanding.';
const quote = (page: Page) => page.locator('.shell-daily-quote');
async function openPreferences(page: Page) {
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '偏好', exact: true }).click();
}

test.beforeEach(async ({ request }) => { await resetE2eState(request); });

test('每日一句固定居中单行显示，不增加顶栏高度或点击行为，窄屏隐藏', async ({ page, request }, testInfo) => {
  expect((await request.patch(`${fakeApiRoot}/api/preferences`, { data: { showDailyQuote: true } })).ok()).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(quote(page)).toHaveText(sentence);
  await expect(quote(page)).toBeVisible();
  await expect(quote(page)).toHaveCSS('white-space', 'nowrap');
  await expect(quote(page)).toHaveCSS('pointer-events', 'none');
  const header = page.locator('.shell-header');
  const headerBox = (await header.boundingBox())!;
  const quoteBox = (await quote(page).boundingBox())!;
  expect(headerBox.height).toBe(58);
  expect(quoteBox.x + quoteBox.width / 2).toBeCloseTo(720, 0);
  expect(Math.abs(quoteBox.y + quoteBox.height / 2 - (headerBox.y + headerBox.height / 2))).toBeLessThanOrEqual(1);
  expect(quoteBox.x).toBeGreaterThan(196);
  const actions = (await page.locator('.shell-actions').boundingBox())!;
  expect(quoteBox.x + quoteBox.width).toBeLessThan(actions.x);
  await expect(quote(page).locator('button, a, [tabindex]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('daily-quote-desktop.png') });
  await openPreferences(page);
  await expect(quote(page)).toHaveText(sentence);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(quote(page)).toBeVisible();
  expect(await quote(page).evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(await quote(page).evaluate(element => element.clientWidth));
  const laptopQuote = (await quote(page).boundingBox())!;
  expect(laptopQuote.x + laptopQuote.width / 2).toBeCloseTo(640, 0);
  expect(laptopQuote.x + laptopQuote.width).toBeLessThan((await page.locator('.shell-actions').boundingBox())!.x);
  await page.setViewportSize({ width: 1440, height: 900 });
  const title = (await page.locator('.shell-page-name').boundingBox())!;
  expect((await quote(page).boundingBox())!.x).toBeGreaterThan(title.x + title.width);
  await page.screenshot({ path: testInfo.outputPath('daily-quote-preferences.png') });
  await page.getByRole('button', { name: '回到 Multivac', exact: true }).click();
  await page.reload();
  await expect(quote(page)).toHaveText(sentence);
  for (const width of [1100, 760, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(quote(page)).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await page.screenshot({ path: testInfo.outputPath('daily-quote-narrow.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(quote(page)).toBeVisible();
  await expect(quote(page)).toHaveText(sentence);
});

test('每日一句默认关闭，开启后即时保存并跨窗口同步，关闭后刷新不闪现', async ({ page, context, request }) => {
  await page.goto('/');
  const other = await context.newPage();
  await other.goto('/');
  await openPreferences(page);
  const toggle = page.getByRole('switch', { name: '显示每日一句' });
  await expect(toggle).not.toBeChecked();
  await expect(quote(page)).toHaveCount(0);
  await expect(quote(other)).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(quote(page)).toBeVisible();
  await expect(quote(other)).toBeVisible();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole('region', { name: '界面', exact: true }).getByRole('status')).toHaveText('已保存');
  await expect(quote(page)).toHaveCount(0);
  await expect(quote(other)).toHaveCount(0);
  expect((await (await request.get(`${fakeApiRoot}/api/preferences`)).json()).preferences.showDailyQuote).toBe(false);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await other.route('**/api/preferences', async route => { await held; await route.continue(); });
  await other.reload();
  await expect(other.getByLabel('Multivac 草稿')).toBeEditable();
  await expect(quote(other)).toHaveCount(0);
  release(); await other.unrouteAll({ behavior: 'wait' });
  await openPreferences(other);
  await expect(other.getByRole('switch', { name: '显示每日一句' })).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(quote(page)).toHaveText(sentence);
  await expect(quote(other)).toBeVisible();
  await expect(other.getByRole('switch', { name: '显示每日一句' })).toBeChecked();
  await other.close();
});

test('每日一句保存失败保留显示与原开关值，并显示行内错误', async ({ page, request }) => {
  await page.goto('/');
  await openPreferences(page);
  const toggle = page.getByRole('switch', { name: '显示每日一句' });
  await toggle.click();
  await expect(quote(page)).toBeVisible();
  await page.route('**/api/preferences', route => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '每日一句偏好保存失败。' } }) })
    : route.continue());
  await toggle.click();
  await expect(page.getByRole('region', { name: '界面', exact: true }).getByRole('alert')).toHaveText('每日一句偏好保存失败。');
  await expect(toggle).toBeChecked();
  await expect(toggle).toHaveAttribute('aria-invalid', 'true');
  await expect(quote(page)).toHaveText(sentence);
  expect((await (await request.get(`${fakeApiRoot}/api/preferences`)).json()).preferences.showDailyQuote).toBe(true);
});
