import { expect, test } from '@playwright/test';
import { openPanel } from './test-state.js';
import { noteBody, replaceNoteBody } from './notes-helpers.js';

// 合成摘要隔离后端；验证行数和交互行为，不在普通回归中断言耗时。
test('千条摘要分页可用键盘访问，全量搜索与切换不丢未保存正文', async ({ page }) => {
  const notes = Array.from({ length: 1000 }, (_, index) => ({
    id: `perf-${index}`, title: `性能笔记${String(index).padStart(4, '0')}`, revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }));
  await page.route('**/api/notes', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: { notes } });
  });
  await page.route(/\/api\/notes\/perf-\d+$/, async route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const summary = notes.find(note => note.id === id);
    await route.fulfill({ json: { ...summary, body: '服务端正文' } });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '快捷键', exact: true })).toBeVisible();
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '笔记', exact: true }).click();
  const library = page.getByRole('complementary', { name: '笔记库' });
  await expect(library.locator('.note-list-open')).toHaveCount(100);
  await expect(noteBody(page)).toHaveText('服务端正文');
  await replaceNoteBody(page, '本机未保存正文');

  const next = library.getByRole('button', { name: '下一页笔记', exact: true });
  await next.focus(); await next.press('Enter');
  await expect(library.locator('.note-list-open').first()).toBeFocused();
  await expect(library.locator('.note-list-open').first()).toContainText('性能笔记0100');
  await library.locator('.note-list-open').first().press('Enter');
  await expect(noteBody(page)).toHaveText('服务端正文');

  const search = library.getByRole('searchbox', { name: '搜索笔记标题', exact: true });
  await search.fill('0999');
  await expect(library.locator('.note-list-open')).toHaveCount(1);
  await library.locator('.note-list-open').click();
  await expect(page.locator('.notes-open-document:visible').getByRole('textbox', { name: '笔记标题', exact: true })).toHaveValue('性能笔记0999');
  await search.fill('0000');
  await library.locator('.note-list-open').click();
  await expect(noteBody(page)).toHaveText('本机未保存正文');
  await search.press('Escape');
  await expect(library.locator('.note-list-open')).toHaveCount(100);
  await expect(library.locator('.note-list-open[aria-current="true"]')).toContainText('性能笔记0000');
});
