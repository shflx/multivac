import { test, expect, type Page } from '@playwright/test';
import { openPanel } from './test-state.js';
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const current = (page: Page) => page.locator('.notes-open-document:visible');
const body = (page: Page) => current(page).getByRole('textbox', { name: '笔记正文', exact: true });
async function create(page: Page, text: string) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '快捷键', exact: true })).toBeVisible();
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '笔记', exact: true }).click();
  await page.getByRole('button', { name: '新建笔记', exact: true }).click();
  await expect(current(page).getByRole('textbox', { name: '笔记标题', exact: true })).toHaveValue('未命名笔记');
  await expect(current(page).getByRole('textbox', { name: '笔记标题', exact: true })).toBeVisible();
  await current(page).getByRole('textbox', { name: '笔记标题', exact: true }).fill('边界核对-' + crypto.randomUUID().slice(0, 8));
  await page.evaluate(text => navigator.clipboard.writeText(text), text);
  await body(page).click(); await body(page).press('ControlOrMeta+V');
  await expect(body(page)).toContainText('甲');
  await current(page).getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(current(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  await current(page).getByRole('button', { name: '分块模式', exact: true }).click();
}
test('保存期间块首 Backspace 应保留分隔线', async ({ page }, info) => {
  await create(page, '甲\n\n---\n\n乙');
  await body(page).press('ControlOrMeta+End'); await body(page).press('x');
  let release: (() => void) | undefined;
  await page.route('**/api/notes/*', async route => {
    if (route.request().method() !== 'PUT') { await route.continue(); return; }
    await new Promise<void>(resolve => { release = resolve; }); await route.continue();
  });
  await current(page).getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  await body(page).press('ControlOrMeta+End'); await body(page).press('ArrowLeft'); await body(page).press('ArrowLeft');
  await page.screenshot({ path: info.outputPath('saving-before.png') });
  await body(page).press('Backspace');
  await page.screenshot({ path: info.outputPath('saving-after.png') });
  try { await expect(current(page).locator('.note-block-chrome')).toHaveCount(2); }
  finally { release?.(); }
});
test('真实拖动到折叠卡片上半部可移动到第一块', async ({ page }, info) => {
  await create(page, '甲\n\n---\n\n乙\n\n---\n\n丙');
  await current(page).getByRole('button', { name: '折叠块 1', exact: true }).click();
  const target = current(page).getByRole('button', { name: '展开块 1：甲', exact: true });
  const handle = current(page).getByRole('button', { name: '拖动块 3', exact: true });
  await handle.hover(); const start = await handle.boundingBox(); const end = await target.boundingBox();
  await page.mouse.move(start!.x + 12, start!.y + 12); await page.mouse.down();
  await page.mouse.move(start!.x + 12, start!.y + 2, { steps: 5 });
  await page.mouse.move(end!.x + 60, end!.y + 8, { steps: 20 });
  await page.screenshot({ path: info.outputPath('folded-drag-over.png') });
  await page.mouse.up();
  await page.screenshot({ path: info.outputPath('folded-drag-after.png') });
  await expect(current(page).locator('.note-block-first').first()).toHaveText('丙');
});

test('图片上传期间块首 Backspace 不删除边界，完成后仍可合并和撤销', async ({ page }, info) => {
  await create(page, '甲\n\n---\n\n乙');
  const png = await sharp({ create: { width: 20, height: 12, channels: 3, background: 'blue' } }).png().toBuffer();
  let release: (() => void) | undefined;
  await page.route('**/api/notes/*/images', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    await new Promise<void>(resolve => { release = resolve; }); await route.continue();
  });
  await body(page).press('ControlOrMeta+Home');
  await current(page).getByLabel('选择笔记图片', { exact: true }).setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: png });
  await expect.poll(() => !!release).toBe(true);
  try {
    await body(page).press('ControlOrMeta+End'); await body(page).press('ArrowLeft'); await body(page).press('Backspace');
    await expect(current(page).locator('.note-block-chrome')).toHaveCount(2);
    await expect(body(page)).toContainText('乙');
    await page.screenshot({ path: info.outputPath('upload-protected.png') });
  } finally { release?.(); }
  await expect(body(page).getByRole('button', { name: '查看图片 pixel.png', exact: true })).toBeVisible();
  await body(page).press('ControlOrMeta+End'); await body(page).press('ArrowLeft'); await body(page).press('Backspace');
  await expect(current(page).locator('.note-block-chrome')).toHaveCount(1);
  await current(page).getByRole('button', { name: '撤销正文修改', exact: true }).click();
  await expect(current(page).locator('.note-block-chrome')).toHaveCount(2);
});

test('真实拖动到开头空块可以排序并一次撤销', async ({ page }, info) => {
  await create(page, '---\n\n甲\n\n---\n\n乙');
  const target = current(page).getByRole('button', { name: '空块 · 点击开始输入', exact: true });
  const handle = current(page).getByRole('button', { name: '拖动块 3', exact: true });
  await handle.hover(); const start = await handle.boundingBox(); const end = await target.boundingBox();
  await page.mouse.move(start!.x + 12, start!.y + 12); await page.mouse.down();
  await page.mouse.move(start!.x + 12, start!.y + 2, { steps: 5 });
  await page.mouse.move(end!.x + 60, end!.y + 8, { steps: 20 });
  await page.mouse.up();
  await expect(current(page).locator('.note-block-first').first()).toHaveText('乙');
  await page.screenshot({ path: info.outputPath('empty-drop.png') });
  await current(page).getByRole('button', { name: '撤销正文修改', exact: true }).click();
  await expect(current(page).locator('.note-block-empty')).toHaveCount(1);
  await expect(current(page).locator('.note-block-first').first()).toHaveText('甲');
});

test('鼠标打开块菜单后可用 Escape 关闭并从触发器用键盘继续操作', async ({ page }) => {
  await create(page, '甲\n\n---\n\n乙');
  const trigger = current(page).getByLabel('块 2 操作', { exact: true });
  await trigger.click(); await expect(trigger).toBeFocused();
  const menu = current(page).getByRole('group', { name: '块操作', exact: true });
  await page.keyboard.press('Escape'); await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused(); await page.keyboard.press('Enter');
  await expect(menu).toBeVisible(); await page.keyboard.press('Tab');
  await expect(menu.getByRole('button', { name: '在下方插入块', exact: true })).toBeFocused();
  await page.keyboard.press('Enter'); await expect(current(page).locator('.note-block-chrome')).toHaveCount(3);
  await current(page).getByRole('button', { name: '撤销正文修改', exact: true }).click();
  await expect(current(page).locator('.note-block-chrome')).toHaveCount(2);
});

for (const folded of [true, false]) {
  test(`原生文件拖放到${folded ? '折叠卡片' : '空块'}仍上传图片`, async ({ page }, info) => {
    await create(page, folded ? '甲\n\n---\n\n乙' : '---\n\n甲');
    if (folded) await current(page).getByRole('button', { name: '折叠块 1', exact: true }).click();
    const target = current(page).getByRole('button', { name: folded ? '展开块 1：甲' : '空块 · 点击开始输入', exact: true });
    const bounds = await target.boundingBox();
    const file = info.outputPath('native-drop.png');
    await writeFile(file, await sharp({ create: { width: 20, height: 12, channels: 3, background: 'blue' } }).png().toBuffer());
    const upload = page.waitForResponse(response => response.request().method() === 'POST' && /\/api\/notes\/[^/]+\/images$/.test(new URL(response.url()).pathname));
    const input = await page.context().newCDPSession(page);
    // 通过浏览器原生输入通道拖入测试文件，不改 DOM 或调用上传接口。
    const position = { x: bounds!.x + 60, y: bounds!.y + 12, data: { items: [], files: [file], dragOperationsMask: 1 } };
    await input.send('Input.dispatchDragEvent', { type: 'dragEnter', ...position });
    await input.send('Input.dispatchDragEvent', { type: 'dragOver', ...position });
    await input.send('Input.dispatchDragEvent', { type: 'drop', ...position });
    expect((await upload).ok()).toBeTruthy();
    await expect(body(page).getByRole('button', { name: '查看图片 native-drop.png', exact: true })).toBeVisible();
    await expect(current(page).locator('.note-block-chrome')).toHaveCount(2);
    await page.screenshot({ path: info.outputPath('native-file-uploaded.png') });
  });
}

test('长文末块折叠后的操作菜单不会被正文滚动区裁剪', async ({ page }, info) => {
  await create(page, Array.from({ length: 31 }, (_, i) => `## 甲：第 ${i + 1} 块\n\n${'长正文与换行布局。'.repeat(12)}`).join('\n\n---\n\n'));
  await body(page).getByText('甲：第 31 块', { exact: true }).click(); await page.mouse.wheel(0, 10000);
  await current(page).getByRole('button', { name: '折叠块 31', exact: true }).click();
  await current(page).getByLabel('块 31 操作', { exact: true }).click();
  const menu = current(page).getByRole('group', { name: '块操作', exact: true });
  const remove = menu.getByRole('button', { name: '删除块', exact: true });
  const field = await body(page).boundingBox();
  await page.mouse.move(field!.x + 30, 200); await page.mouse.wheel(0, -80);
  await expect.poll(() => menu.evaluate(element => [element.firstElementChild!, element.lastElementChild!].every(button => {
    const rect = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  }))).toBe(true);
  await expect.poll(async () => {
    const popup = (await menu.boundingBox())!, trigger = (await current(page).getByLabel('块 31 操作', { exact: true }).boundingBox())!;
    return Math.abs(popup.x + popup.width - trigger.x - trigger.width);
  }).toBeLessThan(2);
  await page.screenshot({ path: info.outputPath('last-block-menu.png') });
  await page.keyboard.press('Escape');
  await expect(remove).toBeHidden();
});
