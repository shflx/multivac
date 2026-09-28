import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, resetE2eState, openCreationDialog } from './test-state.js';

const workspaceBar = (page: Page) => page.getByRole('toolbar', { name: '工作区' });
const sidebar = (page: Page) => page.locator('.workspace-shell .multivac-sidebar');

async function createSession(page: Page, title: string): Promise<void> {
  await openCreationDialog(page);
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await dialog.getByLabel('会话名称').fill(title);
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).toHaveCount(0);
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
});

test('侧栏默认收起为窄轨，旧版记住的展开状态不再生效；展开后与首页是同一会话并提示当前焦点会话', async ({ page }) => {
  // 旧版把开合记在本机：残留的“展开”记录不再让侧栏默认展开，并被清除。
  await page.evaluate(() => localStorage.setItem('multivac.workspace.multivac-sidebar', 'expanded'));
  await page.reload();
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(sidebar(page)).toHaveClass(/collapsed/);
  expect(Math.round((await sidebar(page).boundingBox())!.width)).toBe(44);
  await expect(sidebar(page).getByRole('button', { name: '展开 Multivac' })).toBeVisible();
  await expect(sidebar(page).getByLabel('Multivac 草稿')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('multivac.workspace.multivac-sidebar'))).toBeNull();

  await createSession(page, '梳理导航结构');
  await createSession(page, '核对接口');
  await sidebar(page).getByRole('button', { name: '展开 Multivac' }).click();
  await expect(sidebar(page).getByLabel('Multivac 草稿')).toBeFocused();
  await expect(sidebar(page).getByText('处理完、点回工作区即自动收起')).toBeVisible();
  await expect(sidebar(page).locator('.composer-context')).toHaveText('正在看「核对接口」，可以直接说“这个”');

  // 点回工作区中的会话：Multivac 已处理完，侧栏自动收起；再展开时提示随焦点会话变化。
  await workspaceBar(page).getByRole('button', { name: '并排', exact: true }).click();
  await expect(sidebar(page)).toHaveClass(/collapsed/);
  await page.getByRole('button', { name: '在「梳理导航结构」中继续' }).click();
  await sidebar(page).getByRole('button', { name: '展开 Multivac' }).click();
  await expect(sidebar(page).locator('.composer-context')).toHaveText('正在看「梳理导航结构」，可以直接说“这个”');

  // 在侧栏发送：处理完时用户还在侧栏里，不收起；消息回到首页可见。
  const draft = sidebar(page).getByLabel('Multivac 草稿');
  await draft.fill('这个会话下一步做什么？');
  await sidebar(page).getByLabel('发送消息').click();
  await expect(sidebar(page).getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(sidebar(page)).not.toHaveClass(/collapsed/);
  await page.getByRole('button', { name: '返回 Multivac' }).click();
  await expect(page.locator('.work-surface').first().locator('article.chat-row.user')
    .filter({ hasText: '这个会话下一步做什么？' })).toHaveCount(1);

  // 首页发送的消息在侧栏可见。
  await page.locator('.work-surface').first().getByLabel('Multivac 草稿').fill('首页发出的消息');
  await page.locator('.work-surface').first().getByLabel('发送消息').click();
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(sidebar(page).locator('article.chat-row.user').filter({ hasText: '首页发出的消息' })).toHaveCount(1);

  // 工作区页面按剩余宽度排版，不横向溢出。
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth))
    .toBe(false);
  // 等入场动画结束再测量布局。
  await sidebar(page).evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const shell = await page.locator('.workspace-shell').boundingBox();
  const panel = await sidebar(page).boundingBox();
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(shell!.x + shell!.width + 1);
});

test('收起与展开按钮、⌘J / Ctrl+J 快捷键；收起不丢草稿与阅读位置，刷新后回到收起', async ({ page }) => {
  const expand = sidebar(page).getByRole('button', { name: '展开 Multivac' });
  await expect(expand).toHaveAttribute('aria-keyshortcuts', 'Meta+J Control+J');

  // 快捷键叫出侧栏并把焦点交给输入区；再按一次收起，焦点回到窄轨入口。
  await page.keyboard.press('ControlOrMeta+j');
  const draft = sidebar(page).getByLabel('Multivac 草稿');
  await expect(draft).toBeFocused();
  await page.keyboard.press('ControlOrMeta+j');
  await expect(sidebar(page)).toHaveClass(/collapsed/);
  await expect(expand).toBeFocused();

  // 与切换工作区条的 Cmd/Ctrl+\ 互不影响。
  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect(workspaceBar(page)).toHaveCount(0);
  await expect(sidebar(page)).toHaveClass(/collapsed/);
  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect(workspaceBar(page)).toBeVisible();

  // 手动收起随时可用：有草稿也能收起，草稿与阅读位置都保留。
  await expand.click();
  await expect(draft).toBeFocused();
  await draft.fill('侧栏里写了一半');
  const scroll = sidebar(page).locator('.message-scroll');
  await scroll.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 400);
    element.dispatchEvent(new Event('scroll'));
  });
  const readingTop = await scroll.evaluate((element) => element.scrollTop);
  expect(readingTop).toBeGreaterThan(0);
  await sidebar(page).getByRole('button', { name: '收起 Multivac' }).click();
  await expect(sidebar(page)).toHaveClass(/collapsed/);
  await expect(expand).toBeFocused();
  await expand.click();
  await expect(draft).toHaveValue('侧栏里写了一半');
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(readingTop, 0);

  // 首页不响应该快捷键；离开再回到工作区，侧栏保持离开时的样子。
  await page.getByRole('button', { name: '返回 Multivac' }).click();
  await page.keyboard.press('ControlOrMeta+j');
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(sidebar(page)).not.toHaveClass(/collapsed/);

  // 刷新后从收起开始，草稿仍在。
  await page.reload();
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(sidebar(page)).toHaveClass(/collapsed/);
  await page.keyboard.press('ControlOrMeta+j');
  await expect(draft).toHaveValue('侧栏里写了一半');
});

test('侧栏内容按侧栏宽度排版：长会话名不把消息和输入区撑出侧栏', async ({ page }) => {
  const title = '会话初始化/恢复、只读分页读历史、页面现场读写与 SSE 推送的对齐方案';
  await createSession(page, title);
  await sidebar(page).getByRole('button', { name: '展开 Multivac' }).click();
  await sidebar(page).evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  await expect(sidebar(page).locator('.composer-context')).toHaveAttribute('title', `正在看「${title}」`);
  await sidebar(page).getByLabel('Multivac 草稿').fill('这个会话里 SSE 是什么意思？');
  await sidebar(page).getByLabel('发送消息').click();
  await expect(sidebar(page).getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();

  const bounds = await sidebar(page).boundingBox();
  const right = bounds!.x + bounds!.width;
  for (const selector of ['.assistant-composer', '.composer-context', 'article.chat-row.user .chat-content', '.message-stream']) {
    const box = await sidebar(page).locator(selector).last().boundingBox();
    expect(box!.x + box!.width, selector).toBeLessThanOrEqual(right + 0.5);
  }
});
