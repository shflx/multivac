import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';

const workspaceBar = (page: Page) => page.getByRole('toolbar', { name: '工作区' });
const panel = (page: Page) => page.locator('.conversation-panel');

async function selectInPanel(page: Page, needle: string): Promise<void> {
  await page.evaluate((text) => {
    const hosts = [...document.querySelectorAll('.conversation-panel [data-quote-entry-id]')];
    for (const host of hosts) {
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = node.textContent?.indexOf(text) ?? -1;
        if (index < 0) continue;
        (host as HTMLElement).scrollIntoView({ block: 'center' });
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + text.length);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        return;
      }
    }
    throw new Error(`会话面板中未找到：${text}`);
  }, needle);
}

async function sendInPanel(page: Page, text: string): Promise<void> {
  await panel(page).getByLabel('Multivac 草稿').fill(text);
  await panel(page).getByLabel('发送消息').click();
  await expect(panel(page).locator('article.chat-row.user').filter({ hasText: text })).toHaveCount(1);
  await expect(panel(page).getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
}

async function drillDown(page: Page, needle: string): Promise<void> {
  await selectInPanel(page, needle);
  await page.getByRole('toolbar', { name: '选中内容操作' }).getByRole('button', { name: '深入一层' }).click();
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  await page.goto('/');
  await page.getByRole('button', { name: '进入工作区' }).click();
  await workspaceBar(page).getByRole('button', { name: '新会话' }).click();
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await dialog.getByLabel('会话名称').fill('导航结构');
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).toHaveCount(0);
  await sendInPanel(page, '顶栏只保留两个入口吗？');
});

test('从选中内容深入两层：路径正确、可逐层返回，父会话内容不变，刷新后栈式关系保留', async ({ page, request }) => {
  const parentMessages = await panel(page).locator('article.chat-row').allTextContents();

  await drillDown(page, 'Fake Multivac 已处理当前消息');
  await expect(panel(page)).toHaveCount(1);
  await expect(panel(page).locator('.conversation-path')).toHaveText('栈式路径 · 导航结构 / Fake Multivac 已处理当前消息');
  await expect(panel(page).locator('.stack-source p')).toHaveText('Fake Multivac 已处理当前消息');
  await expect(workspaceBar(page).getByRole('button', { name: '聚焦', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await sendInPanel(page, '展开讲讲子话题');

  // 再深入一层到孙会话。
  await drillDown(page, '已处理');
  await expect(panel(page).locator('.conversation-path')).toContainText('导航结构 / Fake Multivac 已处理当前消息 / 已处理');

  // 子会话出现在列表中并标明层级。
  await workspaceBar(page).getByRole('button', { name: /^会话/ }).click();
  const menu = page.getByRole('dialog', { name: '工作区会话' });
  await expect(menu.locator('.scene-level')).toHaveText([
    '第 3 层 · 来自「Fake Multivac 已处理当前消息」 · ', '第 2 层 · 来自「导航结构」 · ',
  ]);
  await workspaceBar(page).getByRole('button', { name: /^会话/ }).click();

  await page.reload();
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(panel(page).locator('.conversation-path')).toContainText('导航结构 / Fake Multivac 已处理当前消息 / 已处理');

  // 逐层返回，父会话内容不变。
  await panel(page).getByRole('button', { name: '返回父会话' }).click();
  await expect(panel(page).locator('h2')).toHaveText('Fake Multivac 已处理当前消息');
  await expect(panel(page).locator('article.chat-row.user').filter({ hasText: '展开讲讲子话题' })).toHaveCount(1);
  await panel(page).getByRole('button', { name: '返回父会话' }).click();
  await expect(panel(page).locator('h2')).toHaveText('导航结构');
  await expect(panel(page).getByRole('button', { name: '返回父会话' })).toHaveCount(0);
  await expect(panel(page).locator('article.chat-row')).toHaveText(parentMessages);

  // 子会话的结论不会写回父会话。
  const sessions = await (await request.get(`${fakeApiRoot}/api/sessions`)).json() as {
    sessions: Array<{ sessionId: string; parentSessionId: string | null }>;
  };
  expect(sessions.sessions.filter((session) => session.parentSessionId !== null)).toHaveLength(2);
});

test('并排时深入与返回都留在原来那一栏：视图、其他栏与列宽不变，刷新后保持', async ({ page }) => {
  // beforeEach 已有“导航结构”；再建一个会话并切到并排：新会话在第 1 栏，“导航结构”在第 2 栏。
  await workspaceBar(page).getByRole('button', { name: '新会话' }).click();
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await dialog.getByLabel('会话名称').fill('接口约定');
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).toHaveCount(0);
  await workspaceBar(page).getByRole('button', { name: '并排', exact: true }).click();
  await expect(panel(page).locator('h2')).toHaveText(['接口约定', '导航结构']);
  const separator = page.getByRole('separator');
  await separator.focus();
  await page.keyboard.press('Shift+ArrowLeft');
  const split = await separator.getAttribute('aria-valuenow');
  expect(Number(split)).toBeLessThan(50);

  await drillDown(page, 'Fake Multivac 已处理当前消息');
  await expect(workspaceBar(page).getByRole('button', { name: '并排', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel(page).locator('h2')).toHaveText(['接口约定', 'Fake Multivac 已处理当前消息']);
  await expect(panel(page).nth(1)).toHaveClass(/active/);
  await expect(panel(page).nth(1).locator('.slot-tag')).toHaveText('第 2 栏');
  await expect(page.getByRole('separator')).toHaveAttribute('aria-valuenow', split!);

  await page.reload();
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(panel(page).locator('h2')).toHaveText(['接口约定', 'Fake Multivac 已处理当前消息']);

  await panel(page).nth(1).getByRole('button', { name: '返回父会话' }).click();
  await expect(workspaceBar(page).getByRole('button', { name: '并排', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel(page).locator('h2')).toHaveText(['接口约定', '导航结构']);
  await expect(panel(page).nth(1)).toHaveClass(/active/);
  await expect(page.getByRole('separator')).toHaveAttribute('aria-valuenow', split!);
});

test('深入后选中内容作为来自父会话的引用出现在子会话输入区，发送时带上，刷新后未发送的引用仍在', async ({ page }) => {
  await drillDown(page, 'Fake Multivac 已处理当前消息');
  const child = panel(page);
  await expect(child.locator('h2')).toHaveText('Fake Multivac 已处理当前消息');
  const quote = child.locator('.composer-quote');
  await expect(quote.locator('.quote-source')).toHaveText('来自「导航结构」');
  await expect(quote.locator('p')).toHaveText('Fake Multivac 已处理当前消息');
  await expect(child.getByLabel('Multivac 草稿')).toBeFocused();
  // 子会话顶部的来源横条保留。
  await expect(child.locator('.stack-source p')).toHaveText('Fake Multivac 已处理当前消息');

  await page.reload();
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(panel(page).locator('.composer-quote p')).toHaveText('Fake Multivac 已处理当前消息');

  await sendInPanel(page, '这段具体指什么？');
  const sent = panel(page).locator('article.chat-row.user').filter({ hasText: '这段具体指什么？' });
  await expect(sent.locator('.message-quote')).toContainText('Fake Multivac 已处理当前消息');
  await expect(panel(page).locator('.composer-quote')).toHaveCount(0);
});

test('深入后移除引用再发送，与普通发送一致', async ({ page }) => {
  await drillDown(page, 'Fake Multivac 已处理当前消息');
  await panel(page).locator('.composer-quote').getByRole('button', { name: '移除引用' }).click();
  await expect(panel(page).locator('.composer-quote')).toHaveCount(0);
  await sendInPanel(page, '不带引用的追问');
  await expect(panel(page).locator('article.chat-row.user').filter({ hasText: '不带引用的追问' }).locator('.message-quote'))
    .toHaveCount(0);
});
