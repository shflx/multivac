import { expect, test } from '@playwright/test';
import { fakeApiRoot, resetE2eState, openPanel, openModelSettings } from './test-state.js';
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
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '添加图片', exact: true }).click();
  const chooser = await choosing;
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.image-draft-item')).toHaveCount(1);
  await expect(page.getByLabel('发送消息')).toBeEnabled();
  await page.getByRole('button', { name: '查看图片 pixel.png' }).click();
  await expect(page.getByRole('dialog', { name: '图片预览' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('.image-draft-item')).toHaveCount(1);
  await expect(page.getByLabel('发送消息')).toBeEnabled();
  await page.screenshot({ path: 'test-results/image-composer-desktop.png' });
  await page.getByLabel('发送消息').click();
  await expect(page.locator('.image-draft-item')).toHaveCount(0);
  await expect(page.locator('.chat-row.user .message-image img')).toHaveCount(1);
  await expect(page.locator('.chat-row.pending')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.chat-row.user .message-image img')).toHaveCount(1);
  await page.getByRole('button', { name: '查看图片 图片 1' }).click();
  await page.getByLabel('放大图片').click();
  await expect(page.getByRole('dialog')).toContainText('150%');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '查看图片 图片 1' })).toBeFocused();
  await page.screenshot({ path: 'test-results/image-history-desktop.png' });
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

test('多图保持顺序、预览切图与失效反馈', async ({ page }) => {
  const blue = await sharp({ create: { width: 40, height: 160, channels: 3, background: '#228be6' } }).png().toBuffer();
  await page.getByLabel('选择图片文件').setInputFiles([{ name: 'wide.png', mimeType: 'image/png', buffer: png }, { name: 'long.png', mimeType: 'image/png', buffer: blue }]);
  await expect(page.getByLabel('发送消息')).toBeEnabled();
  await page.getByLabel('发送消息').click();
  const pictures = page.locator('.chat-row.user .message-image img');
  await expect(pictures).toHaveCount(2);
  await page.getByRole('button', { name: '查看图片 图片 1' }).click();
  await page.getByLabel('下一张图片').click();
  await expect(page.getByRole('dialog')).toContainText('2 / 2');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('dialog')).toContainText('1 / 2');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'test-results/image-multiple-desktop.png' });
  await page.route('**/images/*/content', route => route.fulfill({ status: 404 }));
  await page.reload();
  await expect(page.locator('.chat-row .image-load-error')).toHaveCount(2);
});

test('助手附件与外部图片规则：主动加载、危险来源不可用', async ({ page, request }) => {
  const response = await request.post(`${fakeApiRoot}/api/sessions/global-coordinator/images`, { data: png, headers: { 'content-type': 'image/png' } });
  const image = await response.json() as { id: string };
  const url = `/api/sessions/global-coordinator/images/${image.id}/content`;
  const external = 'https://images.example.test/result.png';
  let externalLoads = 0;
  await page.route(external, route => { externalLoads += 1; return route.fulfill({ contentType: 'image/png', body: png }); });
  await request.post(`${fakeApiRoot}/api/__e2e/assistant/events/late-terminal`, { data: { commandId: 'images-test-reply', outcome: 'succeeded', messageText: `![附件](${url})\n\n![外部](${external})\n\n![危险](javascript:alert(1))` } });
  await page.reload();
  await expect(page.getByRole('button', { name: '查看图片 附件' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '加载外部图片' })).toBeVisible();
  expect(externalLoads).toBe(0);
  await page.getByRole('button', { name: '加载外部图片' }).click();
  await expect(page.getByRole('button', { name: '查看图片 外部' })).toBeEnabled();
  expect(externalLoads).toBe(1);
  await expect(page.locator('.markdown-body').filter({ hasText: '图片来源不可用' })).toBeVisible();
  await page.screenshot({ path: 'test-results/image-assistant-desktop.png' });
});

test('首页与 Multivac 侧栏共享附件草稿和消息', async ({ page }) => {
  await page.getByLabel('选择图片文件').setInputFiles({ name: 'shared.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByLabel('发送消息')).toBeEnabled();
  await openModelSettings(page);
  await page.keyboard.press('ControlOrMeta+J');
  const sidebar = page.locator('.multivac-sidebar');
  await expect(sidebar.locator('.image-draft-item')).toHaveCount(1);
  await sidebar.getByLabel('移除 shared.png').click();
  const choosing = page.waitForEvent('filechooser');
  await sidebar.getByRole('button', { name: '添加图片', exact: true }).click();
  await (await choosing).setFiles({ name: 'sidebar.png', mimeType: 'image/png', buffer: png });
  await expect(sidebar.getByLabel('发送消息')).toBeEnabled();
  await sidebar.getByLabel('发送消息').click();
  await expect(sidebar.locator('.chat-row.user .message-image img')).toHaveCount(1);
  await sidebar.screenshot({ path: 'test-results/image-sidebar.png' });
  await openPanel(page, 'home');
  await expect(page.locator('.work-surface .chat-row.user .message-image img')).toHaveCount(1);
  await expect(page.locator('.work-surface .image-draft-item')).toHaveCount(0);
});
