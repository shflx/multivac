import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';

const workspaceBar = (page: Page) => page.getByRole('toolbar', { name: '工作区' });
const sidebar = (page: Page) => page.locator('.workspace-shell .multivac-sidebar');

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

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  const current = await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json() as { revision: number };
  await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
    data: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: current.revision },
  });
  await page.goto('/');
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
  await page.getByRole('button', { name: '进入工作区' }).click();
  await workspaceBar(page).getByRole('button', { name: '新会话' }).click();
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await dialog.getByLabel('会话名称').fill('导航结构');
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).toHaveCount(0);
  const panel = page.locator('.conversation-panel');
  await panel.getByLabel('Multivac 草稿').fill('顶栏怎么设计？');
  await panel.getByLabel('发送消息').click();
  await expect(panel.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
});

test('选中工作会话内容交给 Multivac：侧栏出现带来源的引用，发送后模型收到，刷新后仍在', async ({ page }) => {
  const panel = page.locator('.conversation-panel');
  // 侧栏默认收起：交接时自动展开。
  await expect(sidebar(page)).toHaveClass(/collapsed/);

  await selectInPanel(page, '已处理当前消息');
  await page.getByRole('toolbar', { name: '选中内容操作' }).getByRole('button', { name: '交给 Multivac' }).click();

  await expect(sidebar(page)).not.toHaveClass(/collapsed/);
  const preview = sidebar(page).locator('.composer-quote');
  await expect(preview.locator('.quote-source')).toHaveText('来自「导航结构」');
  await expect(preview.locator('p')).toHaveText('已处理当前消息');
  await expect(sidebar(page).getByLabel('Multivac 草稿')).toBeFocused();
  // 当前会话保持原样：没有引用，草稿不变。
  await expect(panel.locator('.composer-quote')).toHaveCount(0);

  await sidebar(page).getByLabel('Multivac 草稿').fill('这个怎么落地？');
  await sidebar(page).getByLabel('发送消息').click();
  await expect(sidebar(page).getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  const sent = sidebar(page).locator('article.chat-row.user').filter({ hasText: '这个怎么落地？' });
  await expect(sent.locator('.message-quote cite')).toHaveText('来自「导航结构」');

  await page.reload();
  const home = page.locator('.work-surface').first();
  const restored = home.locator('article.chat-row.user').filter({ hasText: '这个怎么落地？' });
  await expect(restored.locator('.message-quote cite')).toHaveText('来自「导航结构」');
  await expect(restored.locator('.message-quote')).toContainText('已处理当前消息');
});

/** 等“点回工作区”的判断执行完（它排在这次点击之后的下一轮事件里），用于断言侧栏没有收起。 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    window.setTimeout(() => window.requestAnimationFrame(() => resolve()), 50);
  }));
}

test('用完即收：交给 Multivac 临时展开，有未发出的内容或仍在处理时点回会话不收起，处理完自动收起', async ({ page, request }) => {
  const panel = page.locator('.conversation-panel');
  const backToSession = () => panel.locator('h2').click();
  const draft = sidebar(page).getByLabel('Multivac 草稿');
  await expect(sidebar(page)).toHaveClass(/collapsed/);

  await selectInPanel(page, '已处理当前消息');
  await page.getByRole('toolbar', { name: '选中内容操作' }).getByRole('button', { name: '交给 Multivac' }).click();
  await expect(sidebar(page)).not.toHaveClass(/collapsed/);
  await expect(draft).toBeFocused();

  // 带来的引用还没发出：点回会话不收起。
  await backToSession();
  await settle(page);
  await expect(sidebar(page)).not.toHaveClass(/collapsed/);
  await expect(sidebar(page).locator('.composer-quote p')).toHaveText('已处理当前消息');

  // 发出后 Multivac 还在处理：点回会话不收起，处理完自动收起。
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);
  await draft.fill('把这个整理成文档');
  await draft.press('Enter');
  expect((await request.get(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`)).ok()).toBe(true);
  await expect(sidebar(page).getByRole('button', { name: '取消当前处理' })).toBeVisible();
  await backToSession();
  await settle(page);
  await expect(sidebar(page)).not.toHaveClass(/collapsed/);
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(sidebar(page)).toHaveClass(/collapsed/);

  // 收起不影响会话：再次展开能看到这一轮的结果与带来源的引用。
  await sidebar(page).getByRole('button', { name: '展开 Multivac' }).click();
  await expect(sidebar(page).getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  const sent = sidebar(page).locator('article.chat-row.user').filter({ hasText: '把这个整理成文档' });
  await expect(sent.locator('.message-quote cite')).toHaveText('来自「导航结构」');

  // 点回会话后又回到侧栏里操作：处理完不收起。
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);
  await draft.fill('再补一句');
  await draft.press('Enter');
  expect((await request.get(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`)).ok()).toBe(true);
  await backToSession();
  await sidebar(page).locator('.message-scroll').click({ position: { x: 20, y: 20 } });
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(sidebar(page).getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await settle(page);
  await expect(sidebar(page)).not.toHaveClass(/collapsed/);

  // 正在侧栏里输入：点回会话不收起；草稿清空后再点回即收起。
  await draft.fill('还没想好怎么说');
  await backToSession();
  await settle(page);
  await expect(sidebar(page)).not.toHaveClass(/collapsed/);
  await draft.fill('');

  // 在会话里拖选文字是在阅读（可能正要交给 Multivac），不算点回。
  const text = panel.locator('[data-quote-entry-id]').last();
  const box = (await text.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole('toolbar', { name: '选中内容操作' })).toBeVisible();
  await settle(page);
  await expect(sidebar(page)).not.toHaveClass(/collapsed/);

  await backToSession();
  await expect(sidebar(page)).toHaveClass(/collapsed/);
});

test('首页只有同会话引用，不显示来源会话', async ({ page }) => {
  await page.getByRole('button', { name: '返回 Multivac' }).click();
  const home = page.locator('.work-surface').first();
  await expect(home.getByRole('toolbar', { name: '选中内容操作' })).toHaveCount(0);
  await page.evaluate(() => {
    const host = document.querySelector('.work-surface [data-quote-entry-id="entry-072"]')!;
    const node = document.createTreeWalker(host, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 6);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  });
  const toolbar = page.getByRole('toolbar', { name: '选中内容操作' });
  await expect(toolbar.getByRole('button', { name: '交给 Multivac' })).toHaveCount(0);
  await toolbar.getByRole('button', { name: '引用', exact: true }).click();
  await expect(home.locator('.composer-quote .quote-source')).toHaveCount(0);
});
