import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, openModelSettings, openPanel, resetE2eState } from './test-state.js';

const sidebar = (page: Page) => page.locator('.multivac-sidebar');
const home = (page: Page) => page.locator('.work-surface');
const managementPage = (page: Page) => page.getByRole('main', { name: '模型' });

/** 进入管理的模型页，按 ⌘J / Ctrl+J 叫出停靠侧栏。 */
async function openSidebar(page: Page): Promise<void> {
  await openModelSettings(page);
  await expect(page.locator('.app-shell')).toHaveClass(/management-mode/);
  await expect(sidebar(page)).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+J');
  await expect(sidebar(page).getByLabel('Multivac 草稿')).toBeEditable();
  // 等入场动画结束再测量布局。
  await sidebar(page).evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
}

/** 经面板跳转回到首页（侧栏开合保持，下次进入管理仍是原样）。 */
async function returnToWork(page: Page): Promise<void> {
  await openPanel(page, 'home');
  await expect(page.locator('.app-shell')).toHaveClass(/work-mode/);
}

async function readAnchor(page: Page): Promise<{ anchorEntryId: string | null; anchorOffsetPx: number }> {
  const response = await page.request.get(`${fakeApiRoot}/api/assistant/page-state`);
  return response.json() as Promise<{ anchorEntryId: string | null; anchorOffsetPx: number }>;
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  const current = await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json() as {
    revision: number;
  };
  await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
    data: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: current.revision },
  });
  await page.goto('/');
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
});

for (const width of [1200, 1440] as const) {
  test(`${width}px 打开侧栏挤压管理页，管理页内容完整可见且无横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 860 });
    await openSidebar(page);

    const panel = await sidebar(page).boundingBox();
    const managementPage = page.getByRole('main', { name: '模型' });
    const pageBox = await managementPage.boundingBox();
    expect(Math.round(panel!.width)).toBe(360);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(width + 1);
    // 挤压而不是遮挡：管理页止于侧栏左缘。
    expect(pageBox!.x + pageBox!.width).toBeLessThanOrEqual(panel!.x + 1);
    const settings = await page.locator('.model-settings').boundingBox();
    expect(settings!.x + settings!.width).toBeLessThanOrEqual(pageBox!.x + pageBox!.width);
    expect(await managementPage.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth))
      .toBe(false);
    // 侧栏使用紧凑形态的模型选择器。
    await expect(sidebar(page).locator('.model-selector')).toHaveClass(/compact/);

    // 收起按钮提示快捷键；收起后焦点交给管理页。
    const collapse = sidebar(page).getByRole('button', { name: '收起 Multivac' });
    await expect(collapse).toHaveAttribute('title', /^收起 Multivac（(⌘J|Ctrl\+J)）$/);
    await collapse.click();
    await expect(sidebar(page)).toHaveCount(0);
    await expect(managementPage).toBeFocused();
  });
}

test('侧栏与首页是同一会话：发送、草稿、引用与停止运行双向同步', async ({ page, request }) => {
  let eventSubscriptions = 0;
  page.on('request', (event) => {
    if (new URL(event.url()).pathname === '/api/assistant/events') eventSubscriptions += 1;
  });
  await page.reload();
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
  await openSidebar(page);
  const sidebarDraft = sidebar(page).getByLabel('Multivac 草稿');

  // 在侧栏发送的消息回到首页可见。
  await sidebarDraft.fill('从侧栏发出的消息');
  await sidebar(page).getByLabel('发送消息').click();
  await expect(sidebar(page).getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(sidebar(page).locator('article.chat-row.user').filter({ hasText: '从侧栏发出的消息' }))
    .toHaveCount(1);

  // 侧栏里的草稿与引用就是首页的草稿与引用。
  await sidebarDraft.fill('侧栏里写了一半的草稿');
  await page.evaluate(() => {
    const host = document.querySelector('.multivac-sidebar [data-quote-entry-id="entry-072"]');
    const node = host && document.createTreeWalker(host, NodeFilter.SHOW_TEXT).nextNode();
    if (!node) throw new Error('侧栏中未找到引用来源');
    // 用户只能选中看得见的文字：先把来源消息滚进侧栏可视区域。
    (host as HTMLElement).scrollIntoView({ block: 'center' });
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 8);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  });
  await page.getByRole('toolbar', { name: '选中内容操作' }).getByRole('button', { name: '引用', exact: true }).click();
  await expect(sidebar(page).locator('.composer-quote p')).toHaveText('第 72 条历史');

  await returnToWork(page);
  await expect(home(page).locator('article.chat-row.user').filter({ hasText: '从侧栏发出的消息' })).toHaveCount(1);
  await expect(home(page).getByLabel('Multivac 草稿')).toHaveValue('侧栏里写了一半的草稿');
  await expect(home(page).locator('.composer-quote p')).toHaveText('第 72 条历史');

  // 首页发起的运行可以在侧栏停止，结果回到首页。
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);
  await home(page).getByLabel('Multivac 草稿').fill('稍后在侧栏停止');
  await home(page).getByLabel('发送消息').click();
  await expect(home(page).getByRole('button', { name: '取消当前处理' })).toBeVisible();
  // 侧栏开合状态在模式切换间保留。
  await openPanel(page, 'management');
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByRole('button', { name: '取消当前处理' }).click();
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(sidebar(page).getByRole('status').getByText('处理已取消', { exact: true })).toBeVisible();
  await returnToWork(page);
  await expect(home(page).getByRole('status').getByText('处理已取消', { exact: true })).toBeVisible();
  await expect(home(page).getByLabel('Multivac 草稿')).toHaveValue('稍后在侧栏停止');

  // 多个呈现实例共享同一条事件订阅。
  expect(eventSubscriptions).toBe(1);
});

test('Esc 先收起侧栏，再按一次回到进入前的面板；弹层与输入框里的 Esc 只作用于自身', async ({ page }) => {
  await openSidebar(page);

  // 输入框里的 Esc 不收起侧栏。
  await sidebar(page).getByLabel('Multivac 草稿').focus();
  await page.keyboard.press('Escape');
  await expect(sidebar(page)).toBeVisible();

  // 模型弹层里的 Esc 只关闭弹层。
  await sidebar(page).getByRole('button', { name: '当前会话模型' }).click();
  const menu = page.locator('#assistant-sidebar-model-menu');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(sidebar(page)).toBeVisible();

  // “?”菜单里的 Esc 只关闭菜单。
  const help = page.getByRole('button', { name: '快捷键' });
  await help.click();
  await expect(page.getByRole('dialog', { name: '快捷键' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '快捷键' })).toHaveCount(0);
  await expect(help).toBeFocused();
  await expect(sidebar(page)).toBeVisible();

  // 侧栏里（输入框之外）的 Esc 收起侧栏，仍停留在管理中，焦点交给管理页。
  await sidebar(page).locator('.message-scroll').focus();
  await page.keyboard.press('Escape');
  await expect(sidebar(page)).toHaveCount(0);
  await expect(page.locator('.app-shell')).toHaveClass(/management-mode/);
  await expect(managementPage(page)).toBeFocused();

  // 再按一次回到进入管理前的首页；再进入管理时侧栏保持收起。
  await page.keyboard.press('Escape');
  await expect(page.locator('.app-shell')).toHaveClass(/work-mode/);
  await expect(home(page).first().getByLabel('Multivac 草稿')).toBeVisible();
  await openPanel(page, 'management');
  await expect(sidebar(page)).toHaveCount(0);
});

test('⌘J 在管理中叫出或收起停靠侧栏，输入框里同样可用；“?”菜单的条目随开合改写并可直接点', async ({ page }) => {
  await openModelSettings(page);
  const help = page.getByRole('button', { name: '快捷键' });
  const helpMenu = page.getByRole('dialog', { name: '快捷键' });

  // “?”菜单：显示侧栏。
  await help.click();
  await helpMenu.getByRole('button', { name: /显示 Multivac 侧栏/ }).click();
  await expect(helpMenu).toHaveCount(0);
  await expect(sidebar(page)).toBeVisible();

  // 侧栏输入框里按 ⌘J 收起，焦点交给管理页。
  await sidebar(page).getByLabel('Multivac 草稿').click();
  await page.keyboard.press('ControlOrMeta+J');
  await expect(sidebar(page)).toHaveCount(0);
  await expect(managementPage(page)).toBeFocused();

  // 再按 ⌘J 叫出，“?”菜单改写为收起，点它收起。
  await page.keyboard.press('ControlOrMeta+J');
  await expect(sidebar(page)).toBeVisible();
  await help.click();
  await helpMenu.getByRole('button', { name: /收起 Multivac 侧栏/ }).click();
  await expect(sidebar(page)).toHaveCount(0);
  await expect(help).toBeFocused();
});

test('侧栏滚动与加载更早消息不改写首页阅读锚点，回到首页阅读位置不变', async ({ page }) => {
  const scroll = home(page).locator('.message-scroll');
  await scroll.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 360);
    element.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(async () => (await readAnchor(page)).anchorEntryId).not.toBeNull();
  const anchor = await readAnchor(page);
  const anchorRow = home(page).locator(`[data-entry-id="${anchor.anchorEntryId}"]`);
  const offsetBefore = await anchorRow.evaluate((element) =>
    element.getBoundingClientRect().top - element.closest('.message-scroll')!.getBoundingClientRect().top);

  await openSidebar(page);
  const sidebarScroll = sidebar(page).locator('.message-scroll');
  await sidebarScroll.hover();
  await page.mouse.wheel(0, -5000);
  await expect.poll(() => sidebarScroll.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(2);
  // 在侧栏里补进更早历史：首页内容随之在顶部增加，但首页阅读位置不能因此漂移。
  const loadEarlier = sidebar(page).getByRole('button', { name: '加载更早消息' });
  const before = await sidebar(page).locator('article[data-entry-id]').count();
  await loadEarlier.click();
  await expect.poll(() => sidebar(page).locator('article[data-entry-id]').count()).toBeGreaterThan(before);
  await page.waitForTimeout(700);
  expect(await readAnchor(page)).toMatchObject(anchor);

  await returnToWork(page);
  await expect.poll(() => anchorRow.evaluate((element) =>
    element.getBoundingClientRect().top - element.closest('.message-scroll')!.getBoundingClientRect().top))
    .toBeCloseTo(offsetBefore, 0);
  expect(await readAnchor(page)).toMatchObject(anchor);
});
