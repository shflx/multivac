import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { Editor } from '@tiptap/core';
import { fakeApiRoot, openPanel } from './test-state.js';
import { noteBody } from './notes-helpers.js';

const png = await sharp({ create: { width: 20, height: 12, channels: 3, background: 'blue' } }).png().toBuffer();
const current = (page: Page) => page.locator('.notes-open-document:visible');
async function openNotes(page: Page) {
  await page.goto('/'); await expect(page.getByRole('button', { name: '快捷键', exact: true })).toBeVisible();
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '笔记', exact: true }).click();
}
async function create(request: APIRequestContext, body: string) {
  const id = crypto.randomUUID();
  const response = await request.post(`${fakeApiRoot}/api/notes`, { data: { id, commandId: crypto.randomUUID(), title: `分块-${id.slice(0, 8)}`, body } });
  expect(response.ok()).toBeTruthy(); return { id, title: `分块-${id.slice(0, 8)}` };
}
async function choose(page: Page, title: string) { await page.getByRole('complementary', { name: '笔记库' }).getByRole('button').filter({ hasText: title }).first().click(); }
async function saved(request: APIRequestContext, id: string) { return (await request.get(`${fakeApiRoot}/api/notes/${id}`)).json() as Promise<{ body: string; revision: number }>; }
async function source(page: Page) {
  return page.evaluate(async () => {
    const id = sessionStorage.getItem('multivac:active-note');
    const pointer = sessionStorage.getItem(`multivac:note-draft-pointer:${id}`);
    const stored = pointer && localStorage.getItem(pointer);
    return stored ? (JSON.parse(stored) as { body: string }).body : (await (await fetch(`/api/notes/${id}`)).json() as { body: string }).body;
  });
}
async function menu(page: Page, index: number, label: string) {
  const chrome = current(page).locator(`.note-block-chrome[data-block="${index}"]`);
  await chrome.locator('summary').click(); await chrome.getByRole('button', { name: label, exact: true }).click();
}
async function undo(page: Page) { await current(page).getByRole('button', { name: '撤销正文修改', exact: true }).click(); }
async function setCursor(page: Page, blockIndex: number, offset = 1) {
  await noteBody(page).evaluate((element, { blockIndex, offset }) => {
    const editor = (element as HTMLElement & { editor: Editor }).editor;
    let pos = 0, index = 0;
    editor.state.doc.forEach((node, at) => { if (node.type.name === 'horizontalRule') { index++; if (index === blockIndex) pos = at + 1; } });
    editor.commands.setTextSelection(pos + offset); editor.view.focus();
  }, { blockIndex, offset });
}

test('分块开关不改正文，各笔记切换刷新保持，空块和嵌套边界正确', async ({ page, request }) => {
  const original = '---\n\n甲\n\n> 引用\n>\n> ---\n\n---\n\n---';
  const a = await create(request, original), b = await create(request, '普通笔记');
  await openNotes(page); await choose(page, a.title);
  await current(page).getByRole('button', { name: '分块模式', exact: true }).click();
  await expect(current(page).locator('.note-block-chrome')).toHaveCount(4);
  await expect(current(page).locator('.note-block-empty')).toHaveCount(3);
  await expect(current(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  await choose(page, b.title); await expect(current(page).getByRole('button', { name: '分块模式' })).toHaveAttribute('aria-pressed', 'false');
  await choose(page, a.title); await expect(current(page).getByRole('button', { name: '分块模式' })).toHaveAttribute('aria-pressed', 'true');
  await openNotes(page); await expect(current(page).locator('.note-block-chrome')).toHaveCount(4);
  await expect(current(page).getByRole('button', { name: '分块模式', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await current(page).locator('.note-block-empty').first().click();
  await expect.poll(() => source(page)).toContain('&nbsp;'); await undo(page);
  await expect.poll(() => source(page)).toBe(original);
  await current(page).getByRole('button', { name: '分块模式' }).click();
  await expect(current(page).locator('.note-block-chrome')).toHaveCount(0);
  expect(await saved(request, a.id)).toMatchObject({ body: original, revision: 1 });
  await expect(current(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  const row = page.locator('.notes-library-item[data-selected="true"]'); await row.hover();
  await row.getByRole('button', { name: '删除笔记', exact: true }).click();
  await page.getByRole('dialog', { name: '删除这篇笔记？' }).getByRole('button', { name: '删除笔记', exact: true }).click();
  await expect.poll(() => page.evaluate(id => Object.keys(localStorage).filter(key => key.startsWith(`multivac.notes.blocks.${id}`)), a.id)).toEqual([]);
});

test('菜单和快捷键按块修改，一次撤销还原原文，保存期间禁止块操作', async ({ page, request }) => {
  const original = '首块 **保留**。 \n\n---\n\n第二块内容\n\n---\n\n末块 _原文_。 \n';
  const a = await create(request, original); await openNotes(page); await choose(page, a.title);
  await current(page).getByRole('button', { name: '分块模式' }).click();
  for (const label of ['在下方插入块', '复制块', '上移', '下移', '与上一块合并', '删除块']) {
    await menu(page, 1, label); await expect.poll(() => source(page)).not.toBe(original);
    await undo(page); await expect.poll(() => source(page)).toBe(original);
  }
  await setCursor(page, 1, 3); await noteBody(page).press('ControlOrMeta+Shift+Enter');
  await expect(current(page).locator('.note-block-chrome')).toHaveCount(4); await undo(page);
  await expect.poll(() => source(page)).toBe(original);
  await setCursor(page, 1); await noteBody(page).press('Backspace'); await expect(current(page).locator('.note-block-chrome')).toHaveCount(2); await undo(page);
  await setCursor(page, 1); await noteBody(page).press('Alt+ArrowUp'); await expect.poll(() => source(page)).not.toBe(original); await undo(page);
  await menu(page, 1, '复制块');
  const changed = await source(page);
  let release: (() => void) | undefined;
  await page.route(`**/api/notes/${a.id}`, async route => {
    if (route.request().method() !== 'PUT') { await route.continue(); return; }
    await new Promise<void>(resolve => { release = resolve; }); await route.continue();
  });
  await current(page).getByRole('button', { name: '保存笔记', exact: true }).click();
  const chrome = current(page).locator('.note-block-chrome').first(); await chrome.locator('summary').click();
  await expect(chrome.getByRole('button', { name: '删除块', exact: true })).toBeDisabled();
  await expect(current(page).locator('.note-block-drag').first()).toBeDisabled();
  await expect.poll(() => !!release).toBe(true); release!();
  await expect(current(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  expect((await saved(request, a.id)).body).toBe(changed);
  await current(page).getByRole('button', { name: '分块模式' }).click();
  await expect(current(page).locator('.note-block-chrome')).toHaveCount(0);
  expect((await saved(request, a.id)).body).toBe(changed);
});

test('真实鼠标拖动第 3 块到第 1 块前，一次撤销，图片文件仍上传', async ({ page, request }) => {
  const original = '第一块\n\n---\n\n第二块\n\n---\n\n第三块';
  const a = await create(request, original); await openNotes(page); await choose(page, a.title);
  await current(page).getByRole('button', { name: '分块模式' }).click();
  const handle = current(page).getByRole('button', { name: '拖动块 3', exact: true });
  await handle.hover(); const start = await handle.boundingBox(); const target = await current(page).locator('.note-block-first').first().boundingBox();
  await page.mouse.move(start!.x + 12, start!.y + 12); await page.mouse.down();
  await page.mouse.move(start!.x + 12, start!.y + 4, { steps: 5 });
  await page.mouse.move(target!.x + 30, target!.y + 5, { steps: 15 });
  await expect(page.locator('.note-block-drop-line')).toHaveCount(1);
  await page.mouse.up();
  await expect(current(page).locator('.note-block-first').first()).toHaveText('第三块');
  await undo(page); await expect.poll(() => source(page)).toBe(original);
  const upload = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes(`/api/notes/${a.id}/images`));
  await noteBody(page).evaluate((element, bytes) => {
    const dataTransfer = new DataTransfer(); dataTransfer.items.add(new File([new Uint8Array(bytes)], 'pixel.png', { type: 'image/png' }));
    const bounds = element.getBoundingClientRect();
    element.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true, clientX: bounds.x + 50, clientY: bounds.y + 24 }));
  }, [...png]);
  expect((await upload).ok()).toBeTruthy(); await expect.poll(() => source(page)).toContain('note-image:');
});

test('本机折叠刷新保持，光标、首行编辑、查找进入时展开，正文不变', async ({ page, request }, testInfo) => {
  const original = '# 背景\n\n首段说明。\n\n---\n\n第二块首行\n第二行\n\n还有第三行\n\n---\n\n末块';
  const a = await create(request, original); await openNotes(page); await choose(page, a.title);
  await current(page).getByRole('button', { name: '分块模式' }).click();
  await current(page).getByRole('button', { name: '折叠块 2', exact: true }).click();
  await expect(current(page).locator('.note-block-folded')).toContainText('还有 2 行');
  await expect(current(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  await openNotes(page); await expect(current(page).locator('.note-block-folded')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('blocks-desktop.png'), animations: 'disabled' });
  await setCursor(page, 1); await expect(current(page).locator('.note-block-folded')).toHaveCount(0);
  await current(page).getByRole('button', { name: '折叠块 2', exact: true }).click();
  await current(page).locator('[hidden="until-found"]').first().dispatchEvent('beforematch', { bubbles: true });
  await expect(current(page).locator('.note-block-folded')).toHaveCount(0);
  await current(page).getByRole('button', { name: '折叠块 2', exact: true }).click();
  await noteBody(page).press('ControlOrMeta+f');
  await expect(current(page).locator('.note-block-folded')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await current(page).getByRole('button', { name: '折叠块 2', exact: true }).click();
  await noteBody(page).evaluate(element => { const editor = (element as HTMLElement & { editor: Editor }).editor; const pos = editor.state.selection.from; editor.view.dispatch(editor.state.tr.insertText('新', pos)); });
  await expect(current(page).locator('.note-block-folded')).toHaveCount(0); await undo(page);
  await expect.poll(() => source(page)).toBe(original);
  expect((await saved(request, a.id)).body).toBe(original);
});

test('触屏通过菜单排序，禁编辑仍阻止块命令', async ({ browser, request }, testInfo) => {
  const a = await create(request, '甲\n\n---\n\n乙');
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, hasTouch: true, viewport: { width: 820, height: 1000 } }); const page = await context.newPage();
  await openNotes(page); await choose(page, a.title); await current(page).getByRole('button', { name: '分块模式' }).click();
  await expect(current(page).locator('.note-block-drag').first()).toBeHidden();
  await menu(page, 1, '上移'); await expect(current(page).locator('.note-block-first').first()).toHaveText('乙');
  await noteBody(page).evaluate(element => { (element as HTMLElement & { editor: Editor }).editor.setEditable(false); });
  await current(page).locator('.note-block-chrome').first().locator('summary').click();
  await expect(current(page).locator('.note-block-menu[open]').getByRole('button', { name: '复制块', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('blocks-touch.png'), animations: 'disabled' }); await context.close();
});

test('相同文档节点仍移动原 Markdown，嵌套块首 Backspace 合并，历史保持普通只读', async ({ page, request }) => {
  const original = '**同文**\n\n---\n\n__同文__';
  const a = await create(request, original); await openNotes(page); await choose(page, a.title);
  await current(page).getByRole('button', { name: '分块模式' }).click();
  await menu(page, 1, '上移');
  await expect.poll(async () => (await source(page)).indexOf('__同文__') < (await source(page)).indexOf('**同文**')).toBe(true);
  await undo(page); await expect.poll(() => source(page)).toBe(original);
  await current(page).getByRole('button', { name: '版本历史', exact: true }).click();
  const history = page.getByRole('dialog', { name: '版本历史', exact: true });
  await expect(history.getByRole('textbox', { name: '笔记正文' })).toHaveAttribute('aria-readonly', 'true');
  await expect(history.locator('.note-block-chrome')).toHaveCount(0);
  await history.getByRole('button', { name: '关闭版本历史', exact: true }).click();
  const b = await create(request, '前块\n\n---\n\n- 列表首项'); await choose(page, b.title);
  await current(page).getByRole('button', { name: '分块模式' }).click();
  await setCursor(page, 1, 3); await noteBody(page).press('Backspace');
  await expect(current(page).locator('.note-block-chrome')).toHaveCount(1);
  await undo(page); await expect.poll(() => source(page)).toBe('前块\n\n---\n\n- 列表首项');
});

test('分块模式中的选区引用仍使用原 Markdown 的 UTF-16 偏移', async ({ page, request }) => {
  const original = '首块\n\n---\n\n第二块 **粗体🙂** 结尾\n\n---\n\n末块';
  const a = await create(request, original); await openNotes(page); await choose(page, a.title);
  await current(page).getByRole('button', { name: '分块模式' }).click();
  await noteBody(page).locator('strong').evaluate(element => {
    const range = window.document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    window.document.dispatchEvent(new Event('selectionchange'));
  });
  const snapshotResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/notes/${a.id}/contexts` && response.request().method() === 'POST');
  await current(page).getByRole('button', { name: '引用给助手', exact: true }).click();
  const snapshot = await (await snapshotResponse).json() as { selection: { start: number; end: number; text: string } };
  expect(snapshot.selection).toEqual({ start: original.indexOf('粗体'), end: original.indexOf('粗体') + 4, text: '粗体🙂' });
  expect((await saved(request, a.id)).body).toBe(original);
});
