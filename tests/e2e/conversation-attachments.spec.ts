import sharp from 'sharp';
import { test, expect } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';

// Fake 只固定工具选择；浏览器、上传、消息、任务创建及下载均走真实服务。
test('全局附上两个文件，失败重试后发送并创建任务，刷新保留归属与下载，窄屏可读', async ({ page, request }, info) => {
  await resetE2eState(request);
  await page.goto('/');
  const home = page.locator('.work-surface').first();
  await expect(home.getByLabel('Multivac 草稿')).toBeEditable();
  await home.getByRole('button', { name: '添加图片或文件' }).click();
  await expect(home.getByRole('menuitem', { name: /添加文件/ })).toBeVisible();
  let fail = true, draftId = '';
  const uploads: string[] = [];
  await page.route('**/attachment-drafts/**', async route => {
    if (route.request().method() === 'PUT') {
      uploads.push(route.request().url());
      draftId = /attachment-drafts\/([^/]+)/.exec(route.request().url())![1]!;
      if (fail) { fail = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '模拟上传失败' } }) }); return; }
    }
    await route.continue();
  });
  const text = '# 需求\n浏览器原文=7391😀';
  await home.getByLabel('选择附件文件').setInputFiles([
    { name: '需求.md', mimeType: 'text/markdown', buffer: Buffer.from(text) },
    { name: '补充说明-很长的中文文件名用于窄屏换行展示.md', mimeType: 'text/plain', buffer: Buffer.from('第二份输入') },
  ]);
  await home.getByLabel('Multivac 草稿').fill('请根据需求创建任务');
  const pending = home.getByLabel('待发送文件');
  await expect(pending).toContainText('模拟上传失败');
  await expect(home.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await pending.getByRole('button', { name: '重试上传' }).click();
  await expect(pending.getByText(/已上传/)).toHaveCount(2);
  expect(uploads.filter(url => url === uploads[0])).toHaveLength(2);
  await page.keyboard.press('Escape');
  const title = `对话附件任务-${Date.now()}`;
  await home.getByLabel('Multivac 草稿').fill(`请根据附件创建任务\n内部工具：create_task ${JSON.stringify({ title, goal: '读取上传的需求', attachmentDraftId: draftId })}`);
  await home.getByRole('button', { name: '发送消息', exact: true }).click();
  const messages = home.getByLabel('消息附件');
  await expect(messages.filter({ hasText: '需求.md' })).toContainText('已附到任务');
  await expect(pending).toHaveCount(0);
  const tasks = (await (await request.get(`${fakeApiRoot}/api/tasks?query=${encodeURIComponent(title)}`)).json()).tasks;
  expect(tasks).toHaveLength(1);
  const detail = await (await request.get(`${fakeApiRoot}/api/tasks/${tasks[0].taskId}`)).json();
  expect(detail.attachments).toHaveLength(2);
  const item = detail.attachments.find((value: any) => value.name === '需求.md');
  expect(await (await request.get(`${fakeApiRoot}/api/tasks/${tasks[0].taskId}/attachments/${item.id}/content`)).text()).toBe(text);
  await page.reload();
  const files = home.getByLabel('消息附件').filter({ hasText: '需求.md' });
  await expect(files).toContainText('已附到任务');
  await files.locator('.task-attachment-row').filter({ hasText: '需求.md' }).getByRole('button', { name: '读取', exact: true }).click();
  await expect(files.locator('pre')).toHaveText(text);
  const href = await files.locator('.task-attachment-row').filter({ hasText: '需求.md' }).getByRole('link', { name: '下载', exact: true }).getAttribute('href');
  expect(await (await request.get(fakeApiRoot + href)).text()).toBe(text);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(files).toBeVisible();
  await files.scrollIntoViewIfNeeded();
  expect(await files.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('conversation-files-narrow.png'), fullPage: true });
});

test('全局文件拖放使用附件通道，图片选择继续使用 imageIds', async ({ page, request }) => {
  await resetE2eState(request); await page.goto('/');
  const home = page.locator('.work-surface').first();
  await expect(home.getByLabel('Multivac 草稿')).toBeEditable();
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer(); data.items.add(new File(['拖放内容'], '拖放.md', { type: 'text/plain' })); return data;
  });
  await home.locator('.assistant-composer').dispatchEvent('drop', { dataTransfer: transfer });
  await expect(home.getByLabel('待发送文件')).toContainText('拖放.md');
  await expect(home.getByLabel('待发送文件')).toContainText('已上传');
  await home.getByRole('button', { name: '移除附件 拖放.md' }).click();
  await expect(home.getByLabel('待发送文件')).toHaveCount(0);
  await home.getByRole('button', { name: '添加图片或文件' }).click();
  await expect(home.getByRole('menuitem', { name: /添加图片/ })).toBeVisible();
  const picture = { name: 'picture.png', mimeType: 'image/png', buffer: await sharp({ create: { width: 4, height: 4, channels: 3, background: 'blue' } }).png().toBuffer() };
  await home.getByLabel('选择图片文件').setInputFiles(picture);
  await expect(home.locator('.image-draft-item')).toHaveCount(1);
  await expect(home.getByLabel('待发送文件')).toHaveCount(0);
  // 同一图片经“添加文件”选择时成为附件，与看图输入同时发送。
  await home.getByLabel('选择附件文件').setInputFiles(picture);
  await expect(home.getByLabel('待发送文件')).toContainText('已上传');
  await home.getByLabel('Multivac 草稿').fill('查看图片并保留文件');
  const sending = page.waitForRequest(value => value.method() === 'POST' && value.url().endsWith('/api/assistant/turns'));
  await expect(home.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await home.getByRole('button', { name: '发送消息', exact: true }).click();
  const command = (await sending).postDataJSON();
  expect(command.imageIds).toHaveLength(1);
  expect(command.attachmentDraftId).toMatch(/^[a-f0-9-]{36}$/);
  const files = home.getByLabel('消息附件').filter({ hasText: 'picture.png' });
  await expect(files).toContainText('未使用');
  await files.getByRole('button', { name: '读取', exact: true }).click();
  await expect(files.getByRole('img', { name: 'picture.png' })).toBeVisible();
});

test('附件菜单键盘导航、大量文件与跨窗口旧草稿清空', async ({ page, context, request }, info) => {
  await resetE2eState(request); await page.goto('/');
  const home = page.locator('.work-surface').first();
  const trigger = home.getByRole('button', { name: '添加图片或文件', exact: true });
  await expect(trigger).toBeVisible(); await trigger.focus(); await trigger.press('Enter');
  await expect(home.getByRole('menuitem', { name: /添加图片/ })).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(home.getByRole('menuitem', { name: /添加文件/ })).toBeFocused();
  await page.screenshot({ path: info.outputPath('keyboard-file-menu.png') });
  await page.keyboard.press('Escape'); await expect(home.getByRole('menu')).toHaveCount(0); await expect(trigger).toBeFocused();
  await home.getByLabel('选择附件文件').setInputFiles(Array.from({ length: 20 }, (_, i) => ({ name: `第${i + 1}份-${'长文件名'.repeat(10)}.txt`, mimeType: 'text/plain', buffer: Buffer.from('文件内容') })));
  const pending = home.getByLabel('待发送文件');
  await expect(pending.getByText(/已上传/)).toHaveCount(20);
  const input = await home.getByLabel('Multivac 草稿').boundingBox();
  const button = await home.getByRole('button', { name: '发送消息', exact: true }).boundingBox();
  expect(input!.y).toBeGreaterThanOrEqual(0); expect(button!.y + button!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.screenshot({ path: info.outputPath('many-files-contained.png') });
  await pending.getByRole('button', { name: '清空附件', exact: true }).click(); await expect(pending).toHaveCount(0);
  await home.getByLabel('选择附件文件').setInputFiles({ name: '共享草稿.txt', mimeType: 'text/plain', buffer: Buffer.from('原消息必须保留') });
  await expect(pending).toContainText('已上传');
  const peer = await context.newPage(); await peer.goto('/'); const other = peer.locator('.work-surface').first();
  await expect(other.getByLabel('待发送文件')).toContainText('已上传');
  await home.getByLabel('Multivac 草稿').fill('保留材料，不创建任务。');
  await home.getByRole('button', { name: '发送消息', exact: true }).click();
  const sent = home.getByLabel('消息附件').filter({ hasText: '共享草稿.txt' }); await expect(sent).toBeVisible();
  await other.getByRole('button', { name: '移除附件 共享草稿.txt' }).click();
  await expect(other.getByLabel('待发送文件')).toContainText('已随消息发送');
  await other.getByRole('button', { name: '清空附件', exact: true }).click();
  await expect(other.getByLabel('待发送文件')).toHaveCount(0);
  await other.getByLabel('Multivac 草稿').fill('下一条不附带旧文件');
  await expect(other.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await peer.screenshot({ path: info.outputPath('peer-draft-cleared.png') });
  await sent.getByRole('button', { name: '读取', exact: true }).click(); await expect(sent.locator('pre')).toHaveText('原消息必须保留');
  await peer.close();
});
