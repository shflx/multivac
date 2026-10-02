import { expect, test } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';
import sharp from 'sharp';

const png = await sharp({ create: { width: 80, height: 48, channels: 3, background: '#e64980' } }).png().toBuffer();

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  const state = await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json() as { revision: number };
  await request.put(`${fakeApiRoot}/api/assistant/page-state`, { data: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: state.revision } });
  await page.goto('/');
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
});

test('图片选择、预览、刷新恢复、纯图片发送与资源保留', async ({ page }) => {
  await page.getByLabel('选择图片文件').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.image-draft-item')).toHaveCount(1);
  await expect(page.getByLabel('发送消息')).toBeEnabled();
  await page.getByRole('button', { name: '预览 pixel.png' }).click();
  await expect(page.getByRole('dialog', { name: '图片预览' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('.image-draft-item')).toHaveCount(1);
  await expect(page.getByLabel('发送消息')).toBeEnabled();
  await page.screenshot({ path: 'test-results/image-composer-desktop.png' });
  await page.getByLabel('发送消息').click();
  await expect(page.locator('.image-draft-item')).toHaveCount(0);
});

test('损坏图片就地失败、重试与移除，超量不创建上传', async ({ page }) => {
  await page.getByLabel('选择图片文件').setInputFiles({ name: 'forged.png', mimeType: 'image/png', buffer: Buffer.from('invalid image') });
  await expect(page.locator('.image-draft-item [role=alert]')).toContainText('图片无效');
  await expect(page.getByLabel('发送消息')).toBeDisabled();
  await page.getByLabel('重试上传').click();
  await expect(page.locator('.image-draft-item [role=alert]')).toBeVisible();
  await page.getByLabel('移除 forged.png').click();
  await page.getByLabel('选择图片文件').setInputFiles(Array.from({ length: 5 }, (_, index) => ({ name: `${index}.png`, mimeType: 'image/png', buffer: png })));
  await expect(page.locator('.image-input [role=alert]')).toContainText('最多 4');
  await expect(page.locator('.image-draft-item')).toHaveCount(0);
});

test('粘贴与拖拽图片，窄屏输入保持可用', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Multivac 草稿').evaluate((element, data) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(data), char => char.charCodeAt(0))], 'paste.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, png.toString('base64'));
  await expect(page.getByLabel('发送消息')).toBeEnabled();
  await page.screenshot({ path: 'test-results/image-composer-mobile.png' });
  await page.getByLabel('移除 paste.png').click();
  await page.locator('.assistant-composer').evaluate((element, data) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(data), char => char.charCodeAt(0))], 'drop.png', { type: 'image/png' }));
    element.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, png.toString('base64'));
  await expect(page.getByLabel('发送消息')).toBeEnabled();
});
