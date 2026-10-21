import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { openPanel, fakeApiRoot } from './test-state.js';
import { noteBody, replaceNoteBody } from './notes-helpers.js';

const png = await sharp({ create: { width: 120, height: 72, channels: 3, background: 'blue' } }).png().toBuffer();
const surface = (page: Page) => page.locator('.notes-open-document:visible');
async function open(page: Page) {
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '笔记', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '笔记库' })).toBeVisible();
}
async function create(page: Page) {
  const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/notes');
  await page.getByRole('button', { name: '新建笔记', exact: true }).click();
  const note = await (await response).json() as { id: string };
  await expect(noteBody(page)).toBeVisible(); return note.id;
}
async function save(page: Page) {
  await surface(page).getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(surface(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
}
async function pasteFile(page: Page, method: 'paste' | 'drop') {
  await noteBody(page).focus(); await noteBody(page).press('ControlOrMeta+End');
  await noteBody(page).evaluate((element, { bytes, method }) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], `${method}.png`, { type: 'image/png' }));
    if (method === 'paste') element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    else { const rect = element.getBoundingClientRect(); element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 20, clientY: rect.top + 10 })); }
  }, { bytes: [...png], method });
}

test('上传、粘贴、拖入，原位展示、稳定保存、刷新、放大和历史恢复', async ({ page, request }, info) => {
  await open(page); const id = await create(page);
  await replaceNoteBody(page, '图片前的说明'); await noteBody(page).press('ControlOrMeta+End');
  await surface(page).getByLabel('选择笔记图片').setInputFiles({ name: 'upload.png', mimeType: 'image/png', buffer: png });
  await expect(surface(page).locator('.note-image img')).toHaveCount(1);
  await pasteFile(page, 'paste'); await expect(surface(page).locator('.note-image img')).toHaveCount(2);
  await pasteFile(page, 'drop'); await expect(surface(page).locator('.note-image img')).toHaveCount(3);
  await expect(surface(page).locator('.note-image-upload')).toHaveCount(0);
  await save(page);
  const saved = await (await request.get(`${fakeApiRoot}/api/notes/${id}`)).json() as { body: string; revision: number };
  expect(saved.body.match(/note-image:[a-f0-9]{64}/g)).toHaveLength(3);
  expect(saved.body).not.toMatch(/data:|blob:|\/Users\//u);
  await page.reload(); await open(page);
  await expect(surface(page).locator('.note-image img')).toHaveCount(3);
  await expect.poll(() => surface(page).locator('.note-image img').first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(120);
  const trigger = surface(page).getByRole('button', { name: '查看图片 upload.png' });
  await trigger.click(); await expect(page.getByRole('dialog', { name: '图片预览' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  await replaceNoteBody(page, '删除全部图片后的文字'); await save(page);
  await surface(page).getByRole('button', { name: '版本历史', exact: true }).click();
  const history = page.getByRole('dialog', { name: '版本历史' });
  await history.getByRole('button').filter({ hasText: `v${saved.revision}` }).click();
  await expect(history.locator('.note-image img')).toHaveCount(3);
  await history.getByRole('button', { name: '查看图片 upload.png' }).click();
  await expect(page.getByRole('dialog', { name: '图片预览' })).toBeVisible(); await page.keyboard.press('Escape');
  await history.getByRole('button', { name: '恢复此版本' }).click();
  await expect(history).toBeHidden(); await expect(surface(page).locator('.note-image img')).toHaveCount(3);
  await page.screenshot({ path: info.outputPath('note-images.png') });
});

test('上传期间输入和删除原占位，迟到结果不补插；外部图片不请求', async ({ page }) => {
  await open(page); const id = await create(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/notes/${id}/images`, async route => { await gate; await route.continue(); });
  let remoteRequests = 0;
  await page.route('https://note-image-test.invalid/**', route => { remoteRequests++; return route.abort(); });
  await replaceNoteBody(page, '正文'); await pasteFile(page, 'paste');
  await expect(surface(page).locator('.note-image-upload')).toHaveCount(1);
  await noteBody(page).press('ControlOrMeta+End'); await page.keyboard.type('继续输入');
  await surface(page).getByRole('button', { name: '移除图片', exact: true }).click(); release();
  await expect(surface(page).locator('.note-image-upload')).toHaveCount(0);
  await expect(noteBody(page)).toContainText('继续输入'); await expect(surface(page).locator('.note-image img')).toHaveCount(0);
  await replaceNoteBody(page, '![外部图](https://note-image-test.invalid/a.png)');
  await expect(noteBody(page)).toContainText('不自动加载'); await save(page);
  expect(remoteRequests).toBe(0);
});

test('多图部分失败可独立重试，撤销重做与切换笔记不串图', async ({ page }) => {
  await open(page); const id = await create(page);
  let fail = true;
  await page.route(`**/api/notes/${id}/images`, async route => {
    if (fail) { fail = false; await route.fulfill({ status: 503, json: { error: { message: '测试上传失败' } } }); }
    else await route.continue();
  });
  await surface(page).getByLabel('选择笔记图片').setInputFiles([{ name: 'one.png', mimeType: 'image/png', buffer: png }, { name: 'two.png', mimeType: 'image/png', buffer: png }]);
  await expect(surface(page).locator('.note-image img')).toHaveCount(1);
  await expect(surface(page).getByRole('button', { name: '重试上传', exact: true })).toBeVisible();
  await surface(page).getByRole('button', { name: '重试上传', exact: true }).click();
  await expect(surface(page).locator('.note-image img')).toHaveCount(2);
  await surface(page).getByRole('button', { name: '撤销正文修改' }).click(); await expect(surface(page).locator('.note-image img')).toHaveCount(0);
  await surface(page).getByRole('button', { name: '重做正文修改' }).click(); await expect(surface(page).locator('.note-image img')).toHaveCount(2);
  await save(page);
  await create(page); await expect(surface(page).locator('.note-image img')).toHaveCount(0);
  await page.evaluate(id => { sessionStorage.setItem('multivac:active-note', id); }, id); await page.reload(); await open(page);
  await expect(surface(page).locator('.note-image img')).toHaveCount(2);
});


test('图片读取失败显示独立占位，逐图重试后恢复正文预览', async ({ page }, info) => {
  await open(page); const id = await create(page);
  await surface(page).getByLabel('选择笔记图片').setInputFiles([
    { name: 'first.png', mimeType: 'image/png', buffer: png },
    { name: 'second.png', mimeType: 'image/png', buffer: png },
  ]);
  await expect(surface(page).getByRole('button', { name: /^查看图片 / })).toHaveCount(2);
  await expect(surface(page).getByRole('button', { name: '查看图片 first.png' })).toBeEnabled();
  await save(page);
  let failed = true;
  await page.route(`**/api/notes/${id}/images/*/content`, async route => {
    if (failed) await route.fulfill({ status: 503, body: '暂不可用' });
    else await route.continue();
  });
  await page.reload(); await open(page);
  const retries = surface(page).getByRole('button', { name: '重试加载', exact: true });
  await expect(retries).toHaveCount(2);
  for (const name of ['first.png', 'second.png']) {
    await expect(surface(page).getByText(`${name} · 图片加载失败`, { exact: true })).toBeVisible();
    await expect(surface(page).getByRole('img', { name, exact: true })).toBeHidden();
  }
  await page.screenshot({ path: info.outputPath('note-image-load-error.png') });
  failed = false;
  await retries.first().click(); await expect(retries).toHaveCount(1);
  await retries.first().click(); await expect(retries).toHaveCount(0);
  for (const name of ['first.png', 'second.png']) await expect(surface(page).getByRole('button', { name: `查看图片 ${name}` })).toBeEnabled();
  await surface(page).getByRole('button', { name: '查看图片 first.png' }).click();
  await expect(page.getByRole('dialog', { name: '图片预览' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: info.outputPath('note-image-load-recovered.png') });
});
