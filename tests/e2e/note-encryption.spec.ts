import sharp from 'sharp';
import { test, expect, type Page } from '@playwright/test';
import { openPanel, fakeApiRoot } from './test-state.js';
import { replaceNoteBody, noteBody } from './notes-helpers.js';

async function openNotes(page: Page) {
  await page.goto('/'); await expect(page.getByRole('button', { name: '快捷键', exact: true })).toBeVisible();
  await openPanel(page, 'management'); await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '笔记', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '笔记库' })).toBeVisible();
}
async function unlock(page: Page, password: string) {
  await page.getByLabel('共用密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: /^解锁(?:笔记|并恢复转换)$/ }).click();
}
const editor = (page: Page) => page.locator('.notes-open-document:visible');

test('逐篇加密、跨窗口隔离、密文草稿恢复、讨论、换密码与取消加密', async ({ page, context, request }, testInfo) => {
  test.setTimeout(45_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const id = crypto.randomUUID(), ordinary = crypto.randomUUID(), title = `秘密标题-${id}`, body = `秘密正文-${id}`, password = `共用密码-${id}`;
  for (const input of [{ id, title, body }, { id: ordinary, title: `普通笔记-${ordinary}`, body: '普通正文' }]) {
    expect((await request.post(`${fakeApiRoot}/api/notes`, { data: { ...input, commandId: input.id } })).ok()).toBeTruthy();
  }
  const imageResponse = await request.post(`${fakeApiRoot}/api/notes/${id}/images`, { headers: { 'content-type': 'application/octet-stream' }, data: await sharp({ create: { width: 16, height: 16, channels: 3, background: 'blue' } }).png().toBuffer() });
  expect(imageResponse.ok()).toBeTruthy(); const image = await imageResponse.json();
  await request.put(`${fakeApiRoot}/api/notes/${id}`, { data: { commandId: crypto.randomUUID(), expectedRevision: 1, title, body: `${body}\n\n![加密图片](note-image:${image.id})` } });
  await openNotes(page); await page.getByRole('button', { name: title, exact: false }).click();
  const peer = await context.newPage(); await openNotes(peer); await peer.getByRole('button', { name: title, exact: false }).click();
  await page.bringToFront();
  await editor(page).getByRole('button', { name: '加密此笔记', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '加密此笔记', exact: true }); await dialog.getByLabel('共用密码').fill(password);
  await editor(peer).getByLabel('笔记标题', { exact: true }).fill(title + '未保存');
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '未保存草稿' })).toBeVisible();
  expect((await request.get(`${fakeApiRoot}/api/notes/${id}`)).status()).toBe(200);
  await editor(peer).getByLabel('笔记标题', { exact: true }).fill(title);
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(editor(page).getByRole('button', { name: '锁定', exact: true })).toBeVisible();
  await expect(peer.getByRole('button', { name: '解锁笔记', exact: true })).toBeVisible();
  expect((await request.get(`${fakeApiRoot}/api/notes/${id}`)).status()).toBe(423);
  await expect(editor(page).getByLabel('笔记标题', { exact: true })).toHaveValue(title);
  await expect.poll(() => editor(page).locator('.note-image img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(16);
  expect((await request.get(`${fakeApiRoot}/api/notes/${id}/images/${image.id}/content`)).status()).toBe(423);
  await replaceNoteBody(page, `未保存密文草稿-${id}`);
  await expect.poll(() => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('multivac:note-vault:')).length)).toBeGreaterThan(0);
  // 等待草稿包已完成最新一轮写入；浏览器持久区不应出现标题、正文或未保存输入。
  await expect.poll(() => page.evaluate(({ title, body, draft }) => !JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }).includes(title) && !JSON.stringify(localStorage).includes(body) && !JSON.stringify(localStorage).includes(draft), { title, body, draft: `未保存密文草稿-${id}` })).toBeTruthy();
  await expect(editor(page).getByText('加密草稿已保存', { exact: true })).toBeVisible();
  const focusChecked = page.waitForResponse(response => response.url().includes(`/api/notes/${id}/access`));
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await focusChecked;
  await expect(noteBody(page)).toHaveText(`未保存密文草稿-${id}`);

  await openNotes(page);
  await expect(page.getByRole('button', { name: '解锁笔记', exact: true })).toBeVisible();
  await unlock(page, '错误密码'); await expect(page.getByRole('alert').filter({ hasText: /密码|解密/ })).toBeVisible();
  await unlock(page, password); await expect(noteBody(page)).toHaveText(`未保存密文草稿-${id}`);
  await editor(page).getByRole('button', { name: '保存笔记', exact: true }).click(); await expect(editor(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  await editor(page).getByRole('button', { name: '梳理助手', exact: true }).click();
  const question = editor(page).getByLabel('向梳理助手提问', { exact: true }); await expect(question).toBeEnabled(); await question.fill('讨论加密笔记'); await question.press('Enter');
  await expect(editor(page).locator('.note-message.assistant')).toHaveCount(1);
  await page.route('**/api/sessions/*/page-state', async route => { if (route.request().method() === 'PUT') await route.abort('failed'); else await route.continue(); });
  await question.fill('尚未发送的加密讨论草稿');
  await expect(editor(page).getByText('加密草稿已保存', { exact: true })).toBeVisible();
  await openNotes(page); await unlock(page, password);
  await expect(editor(page).getByLabel('向梳理助手提问', { exact: true })).toHaveValue('尚未发送的加密讨论草稿');
  await page.unroute('**/api/sessions/*/page-state');

  await editor(page).getByRole('button', { name: '锁定', exact: true }).click(); await expect(page.getByRole('button', { name: '解锁笔记', exact: true })).toBeVisible();
  await expect(page.getByText(`未保存密文草稿-${id}`, { exact: true })).toHaveCount(0);
  await unlock(page, password); await expect(noteBody(page)).toHaveText(`未保存密文草稿-${id}`);
  expect((await request.post(`${fakeApiRoot}/api/__e2e/restart`)).status()).toBe(202);
  await expect(page.getByRole('button', { name: '解锁笔记', exact: true })).toBeVisible({ timeout: 15000 });
  await unlock(page, password); await expect(noteBody(page)).toHaveText(`未保存密文草稿-${id}`);
  await page.getByRole('button', { name: `普通笔记-${ordinary}`, exact: false }).click();
  await editor(page).getByRole('button', { name: '加密此笔记', exact: true }).click();
  const secondDialog = page.getByRole('dialog', { name: '加密此笔记', exact: true }); await secondDialog.getByLabel('共用密码').fill(password); await secondDialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(editor(page).getByRole('button', { name: '锁定', exact: true })).toBeVisible();
  expect((await request.get(`${fakeApiRoot}/api/notes/${ordinary}`)).status()).toBe(423);
  await editor(page).getByRole('button', { name: '锁定', exact: true }).click();
  await expect(page.getByRole('button', { name: '解锁笔记', exact: true })).toBeVisible();
  await page.locator('.note-list-open:not([aria-current="true"])').filter({ hasText: '加密笔记' }).click();
  await expect(noteBody(page)).toHaveText(`未保存密文草稿-${id}`);
  await page.getByRole('button', { name: '共用密码设置', exact: true }).click();
  await page.getByLabel('原密码', { exact: true }).fill(password); await page.getByLabel('新密码', { exact: true }).fill(password + '新'); await page.getByRole('button', { name: '修改密码', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '共用密码已修改' })).toBeVisible();
  await page.getByRole('button', { name: '关闭密码设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '解锁笔记', exact: true })).toBeVisible();
  await unlock(page, password); await expect(page.getByRole('alert').filter({ hasText: /密码|解密/ })).toBeVisible();
  await unlock(page, password + '新'); await expect(noteBody(page)).toHaveText(`未保存密文草稿-${id}`);
  await editor(page).getByRole('button', { name: '取消加密', exact: true }).click(); await page.getByRole('dialog', { name: '取消加密', exact: true }).getByRole('button', { name: '确认', exact: true }).click();
  await expect(editor(page).getByRole('button', { name: '加密此笔记', exact: true })).toBeVisible();
  expect((await (await request.get(`${fakeApiRoot}/api/notes/${id}`)).json()).body).toBe(`未保存密文草稿-${id}`);
  await page.locator('.note-list-open:not([aria-current="true"])').filter({ hasText: '加密笔记' }).click();
  await unlock(page, password + '新'); await expect(noteBody(page)).toHaveText('普通正文');
  await editor(page).getByRole('button', { name: '取消加密', exact: true }).click(); await page.getByRole('dialog', { name: '取消加密', exact: true }).getByRole('button', { name: '确认', exact: true }).click();
  await expect(editor(page).getByRole('button', { name: '加密此笔记', exact: true })).toBeVisible();
  expect((await (await request.get(`${fakeApiRoot}/api/notes/${ordinary}`)).json()).body).toBe('普通正文');
  await page.getByRole('button', { name: title, exact: false }).click();
  let conversions = 0;
  await page.route(`**/api/notes/${id}/protection`, async route => {
    if (route.request().method() === 'POST' && route.request().postDataJSON()?.action === 'encrypt') { conversions++; await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await editor(page).getByRole('button', { name: '加密此笔记', exact: true }).click();
  const unknownDialog = page.getByRole('dialog', { name: '加密此笔记', exact: true }); await unknownDialog.getByLabel('共用密码').fill(password + '新'); await unknownDialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('button', { name: '解锁并恢复转换', exact: true })).toBeVisible();
  await page.unroute(`**/api/notes/${id}/protection`); await unlock(page, password + '新');
  await expect(noteBody(page)).toHaveText(`未保存密文草稿-${id}`); expect(conversions).toBe(1);
  await expect.poll(() => page.evaluate(title => !JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }).includes(title), title)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('note-encryption-complete.png') });
  await page.goto('/?note-back-check=1'); await page.goBack();
  await openPanel(page, 'management'); await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '笔记', exact: true }).click();
  await expect(page.getByRole('button', { name: /^解锁(?:笔记|并恢复转换)$/ })).toBeVisible();
  await expect(page.getByText(`未保存密文草稿-${id}`, { exact: true })).toHaveCount(0);
  await peer.close();
  expect(errors).toEqual([]);
});
