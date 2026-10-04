import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { openPanel, fakeApiRoot } from './test-state.js';

async function openBook(page: Page, request: APIRequestContext, id: string, mobile = false) {
  const book = await (await request.post(`${fakeApiRoot}/api/reading/books`, { data: { commandId: id, title: id, author: '', format: 'txt', text: mobile ? `原文${id}，用于回归验证。`.repeat(150) : `原文${id}，用于回归验证。` } })).json();
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  if (mobile) await page.getByRole('button', { name: '读书', exact: true }).click();
  else { await openPanel(page, 'management'); await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click(); }
  await page.getByRole('navigation', { name: '书架' }).getByRole('button', { name: new RegExp(id) }).click();
  await expect(page.getByRole('button', { name: '本页已读', exact: true })).toBeEnabled();
  return book;
}

for (const action of ['draft', 'save'] as const) {
  test(`${action} 结果未知后重试保留后续输入与本机备份`, async ({ page, request }) => {
    const book = await openBook(page, request, `safe-note-retry-${action}`);
    await page.getByRole('button', { name: '为当前页写笔记' }).click();
    await expect(page.getByLabel('笔记内容')).toBeVisible();
    if (action === 'save') await page.getByLabel('笔记内容').fill('第一版自动保存');
    await expect(page.getByText('草稿已保留', { exact: true })).toBeVisible();
    let originalCommand = '';
    let savingNewer = false;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/api/reading/books/${book.id}/notes`, async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      const command = route.request().postDataJSON();
      if (!originalCommand) {
        expect(command.action).toBe(action);
        originalCommand = command.commandId;
        await route.fetch();
        await route.abort('failed');
      } else {
        if (command.commandId !== originalCommand) { savingNewer = true; await held; }
        await route.continue();
      }
    });
    if (action === 'draft') await page.getByLabel('笔记内容').fill('第一版自动保存');
    else await page.getByRole('button', { name: '保存笔记', exact: true }).click();
    const retry = page.getByRole('button', { name: '重试原命令', exact: true });
    await expect(retry).toBeVisible();
    await page.getByLabel('笔记内容').fill('第一版之后补写的重要内容');
    await retry.click();
    await expect(page.getByLabel('笔记内容')).toHaveValue('第一版之后补写的重要内容');
    try {
      await expect.poll(() => savingNewer).toBe(true);
      expect(await page.evaluate(id => JSON.parse(localStorage.getItem(`multivac.reading.note-buffer.${id}`)!).draft.body, book.id)).toBe('第一版之后补写的重要内容');
    } finally { release(); }
    await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/notes`)).json()).draft?.body).toBe('第一版之后补写的重要内容');
    await expect(page.getByLabel('笔记内容')).toHaveValue('第一版之后补写的重要内容');
  });
}

