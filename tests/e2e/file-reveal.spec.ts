import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

test('系统定位只从真实菜单点击发出，固定目标且保留阅读及草稿', async ({ page, request }) => {
  await resetE2eState(request);
  const sessionId = crypto.randomUUID();
  const created = await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: '系统定位验收' } });
  const root = (await created.json()).workingDirectory.path as string;
  writeFileSync(join(root, 'notes.txt'), '保留阅读位置\n'.repeat(200));
  const calls: Array<{ url: string; method: string }> = [];
  // 浏览器回归不启动真实 Finder；桌面效果由本机人工验收单独核对。
  await page.route('**/files/reveal?*', async route => {
    calls.push({ url: route.request().url(), method: route.request().method() });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ message: 'Finder 定位命令已退出；请在本机查看显示结果。' }) });
  });
  await page.goto('/'); await openPanel(page, 'workspace');
  const panel = page.locator(`.conversation-panel[data-session-id="${sessionId}"]`);
  await panel.getByLabel('Multivac 草稿').fill('保留正文');
  await panel.getByRole('button', { name: '查看文件', exact: true }).click();
  const browser = panel.getByRole('region', { name: '工作目录文件浏览' });
  await browser.getByRole('button', { name: 'notes.txt', exact: true }).click();
  const article = browser.getByRole('article');
  await expect(article).toContainText('保留阅读位置');
  await article.evaluate(element => { element.scrollTop = 500; });
  const scroll = await article.evaluate(element => element.scrollTop);
  const trigger = browser.locator('.file-reader').getByRole('button', { name: '「notes.txt」的文件操作', exact: true });
  await trigger.click();
  const action = page.getByRole('menuitem', { name: '在文件管理器中显示', exact: true });
  await action.evaluate(element => (element as HTMLButtonElement).click());
  expect(calls).toHaveLength(0);
  await expect(browser.getByRole('alert')).toContainText('请在本机点击');
  await action.click();
  await expect.poll(() => calls.length).toBe(1);
  const url = new URL(calls[0]!.url);
  expect(calls[0]!.method).toBe('POST'); expect(url.searchParams.get('path')).toBe('notes.txt'); expect(url.searchParams.get('root')).toBe(root);
  await expect(browser.getByRole('status')).toContainText('命令已退出');
  expect(await article.evaluate(element => element.scrollTop)).toBe(scroll);
  await expect(panel.getByLabel('Multivac 草稿')).toHaveValue('保留正文');
});
