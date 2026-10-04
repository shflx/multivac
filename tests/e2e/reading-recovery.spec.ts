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

test('手机打开书伴或导航保持正文尺寸与当前页引用', async ({ page, request }) => {
  const book = await openBook(page, request, 'stable-mobile', true);
  const before = await page.evaluate(async book => {
    const path = '/src/features/reading/reading-layout.ts';
    const { measureReadingPages } = await import(path);
    const viewport = document.querySelector('.reading-page-viewport') as HTMLElement;
    return { height: viewport.clientHeight, reference: measureReadingPages(book, document.querySelector('.reading-flow'), viewport.clientWidth)[0].reference };
  }, book);
  await page.getByRole('button', { name: '书伴', exact: true }).click();
  await expect(page.getByLabel('向书伴提问')).toBeEnabled();
  await page.getByLabel('向书伴提问').fill('请解释当前页');
  await expect(page.getByRole('button', { name: '发送给书伴' })).toBeEnabled();
  await page.getByText('讨论范围：', { exact: false }).click();
  await expect(page.locator('.reading-scope blockquote')).toHaveText(before.reference.text);
  expect(await page.locator('.reading-page-viewport').evaluate(el => el.clientHeight)).toBe(before.height);
  for (const name of ['返回正文', '书签导航']) {
    await page.getByRole('button', { name, exact: true }).click();
    expect(await page.locator('.reading-page-viewport').evaluate(el => el.clientHeight)).toBe(before.height);
  }
  await page.getByRole('button', { name: '书伴', exact: true }).click();
  await expect(page.locator('.reading-scope blockquote')).toHaveText(before.reference.text);
});

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

test('标注冲突同步最新记录并保留备注，重新提交后可继续标注', async ({ page, request }) => {
  const book = await openBook(page, request, 'annotation-conflict');
  await page.getByRole('button', { name: '当前页书签' }).click();
  await expect(page.getByRole('button', { name: '当前页书签' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '书签导航', exact: true }).click();
  await page.getByRole('button', { name: '编辑备注', exact: true }).click();
  let intercepted = false;
  const statuses: number[] = [];
  page.on('response', response => { if (response.url().endsWith(`/books/${book.id}/annotations`) && response.request().method() === 'POST') statuses.push(response.status()); });
  await page.route(`**/api/reading/books/${book.id}/annotations`, async route => {
    if (route.request().method() === 'POST' && !intercepted) {
      intercepted = true;
      const command = route.request().postDataJSON();
      const competing = await request.post(`${fakeApiRoot}/api/reading/books/${book.id}/annotations`, { data: { ...command, commandId: 'other-window-annotation', remark: '其他窗口的备注' } });
      expect(competing.status()).toBe(200);
    }
    await route.continue();
  });
  await page.getByLabel('书签备注').fill('当前窗口的备注');
  await page.getByRole('button', { name: '保存备注' }).click();
  await expect.poll(() => statuses).toEqual([409]);
  await expect(page.getByRole('button', { name: '重试原标注命令' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '当前页书签' })).toBeEnabled();
  await expect(page.getByLabel('书签备注')).toHaveValue('当前窗口的备注');
  await expect(page.locator('.reading-record-location p')).toHaveText('其他窗口的备注');
  await expect(page.getByRole('button', { name: '保存备注' })).toBeEnabled();
  await page.getByRole('button', { name: '保存备注' }).click();
  await expect.poll(() => statuses).toEqual([409, 200]);
  await expect(page.getByRole('button', { name: '保存备注' })).toBeDisabled();
  const records = await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/annotations`)).json();
  expect(records.records[0].remark).toBe('当前窗口的备注');
  await page.getByRole('button', { name: '当前页书签' }).click();
  await expect(page.getByRole('button', { name: '当前页书签' })).toHaveAttribute('aria-pressed', 'false');
});


test('标注响应丢失仍保留原命令，重试不会重复创建书签', async ({ page, request }) => {
  const book = await openBook(page, request, 'annotation-unknown');
  let intercepted = false;
  const commands: string[] = [];
  await page.route(`**/api/reading/books/${book.id}/annotations`, async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    commands.push(route.request().postDataJSON().commandId);
    if (!intercepted) {
      intercepted = true;
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: '当前页书签' }).click();
  const retry = page.getByRole('button', { name: '重试原标注命令' });
  await expect(retry).toBeVisible();
  await expect(page.getByRole('button', { name: '当前页书签' })).toBeDisabled();
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(page.getByRole('button', { name: '当前页书签' })).toBeEnabled();
  expect(commands).toHaveLength(2);
  expect(commands[0]).toBe(commands[1]);
  const records = await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/annotations`)).json();
  expect(records.records).toHaveLength(1);
});
