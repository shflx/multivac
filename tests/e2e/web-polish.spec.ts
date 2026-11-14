import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { resetE2eState, fakeApiRoot } from './test-state.js';

const png = await sharp({ create: { width: 160, height: 96, channels: 3, background: 'white' } }).png().toBuffer();

test.beforeEach(async ({ request }) => { await resetE2eState(request); });

test('消息末尾链接的底部仍打开链接，不误触复制', async ({ page, request }, info) => {
  // 固定助手回复作为前置数据，实际验证点击后的链接行为。
  await request.post(`${fakeApiRoot}/api/__e2e/assistant/events/late-terminal`, {
    data: { commandId: crypto.randomUUID(), outcome: 'succeeded', messageText: '[检查末尾链接](https://polish.invalid/end)' },
  });
  await page.context().route('https://polish.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<title>链接已打开</title>' }));
  await page.goto('/');
  const link = page.getByRole('link', { name: '检查末尾链接', exact: true });
  await expect(link).toBeVisible(); await link.scrollIntoViewIfNeeded();
  const box = (await link.boundingBox())!;
  const popup = page.waitForEvent('popup');
  await page.mouse.click(box.x + 8, box.y + box.height - 2);
  const opened = await popup;
  await expect(opened).toHaveURL('https://polish.invalid/end');
  await opened.close();
  await expect(link.locator('xpath=ancestor::article').getByRole('button', { name: '复制消息' })).toHaveAttribute('data-state', 'idle');
  await page.screenshot({ path: info.outputPath('message-link-edge.png') });
});

test('缩略图的可见预览区域不会误触移除，移除图标仍可用', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
  await page.getByLabel('选择图片文件').setInputFiles({ name: 'preview.png', mimeType: 'image/png', buffer: png });
  const preview = page.getByRole('button', { name: '查看图片 preview.png', exact: true });
  await expect(preview).toBeEnabled();
  const box = (await preview.boundingBox())!;
  await page.mouse.click(box.x + 65, box.y + 30);
  const dialog = page.getByRole('dialog', { name: '图片预览' });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: info.outputPath('image-preview-edge.png') });
  await dialog.getByRole('button', { name: '关闭图片预览' }).click();
  const remove = page.getByRole('button', { name: '移除 preview.png', exact: true });
  await expect(remove).toBeVisible(); await remove.click();
  await expect(preview).toHaveCount(0);
});
