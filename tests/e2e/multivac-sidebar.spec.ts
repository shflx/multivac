import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, openModelSettings, openPanel, resetE2eState } from './test-state.js';

const sidebar = (page: Page) => page.locator('.multivac-sidebar');
const home = (page: Page) => page.locator('.work-surface');
const managementPage = (page: Page) => page.getByRole('main', { name: '模型' });

/** 进入管理的模型页，按 ⌘J / Ctrl+J 叫出侧栏（焦点交给侧栏输入区）。 */
async function openSidebar(page: Page): Promise<void> {
  await openModelSettings(page);
  await expect(page.locator('.app-shell')).toHaveClass(/management-mode/);
  await expect(sidebar(page)).toBeHidden();
  await page.keyboard.press('ControlOrMeta+J');
  await expect(sidebar(page).getByLabel('Multivac 草稿')).toBeFocused();
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
    await expect(sidebar(page)).toBeHidden();
    await expect(managementPage).toBeFocused();
  });
}

test('侧栏与首页是同一会话：发送、草稿、引用与停止运行双向同步', async ({ page, request }) => {
  let eventSubscriptions = 0;
  page.on('request', (event) => {
    if (new URL(event.url()).pathname === '/api/events') eventSubscriptions += 1;
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
  await expect(sidebar(page)).toBeHidden();
  await expect(page.locator('.app-shell')).toHaveClass(/management-mode/);
  await expect(managementPage(page)).toBeFocused();

  // 再按一次回到进入管理前的首页；再进入管理时侧栏保持收起。
  await page.keyboard.press('Escape');
  await expect(page.locator('.app-shell')).toHaveClass(/work-mode/);
  await expect(home(page).first().getByLabel('Multivac 草稿')).toBeVisible();
  await openPanel(page, 'management');
  await expect(sidebar(page)).toBeHidden();
});

test('⌘J 在管理中叫出或收起侧栏，输入框里同样可用；“?”菜单的条目随开合改写并可直接点', async ({ page }) => {
  await openModelSettings(page);
  const help = page.getByRole('button', { name: '快捷键' });
  const helpMenu = page.getByRole('dialog', { name: '快捷键' });

  // “?”菜单：显示侧栏，与 ⌘J 一样把焦点交给侧栏输入区（与工作区一致）。
  await help.click();
  await helpMenu.getByRole('button', { name: /显示 Multivac 侧栏/ }).click();
  await expect(helpMenu).toHaveCount(0);
  await expect(sidebar(page)).toBeVisible();
  await expect(sidebar(page).getByLabel('Multivac 草稿')).toBeFocused();

  // 侧栏输入框里按 ⌘J 收起，焦点交给管理页。
  await sidebar(page).getByLabel('Multivac 草稿').click();
  await page.keyboard.press('ControlOrMeta+J');
  await expect(sidebar(page)).toBeHidden();
  await expect(managementPage(page)).toBeFocused();

  // 再按 ⌘J 叫出（焦点交给侧栏输入区），“?”菜单改写为收起，点它收起。
  await page.keyboard.press('ControlOrMeta+J');
  await expect(sidebar(page)).toBeVisible();
  await expect(sidebar(page).getByLabel('Multivac 草稿')).toBeFocused();
  await help.click();
  await helpMenu.getByRole('button', { name: /收起 Multivac 侧栏/ }).click();
  await expect(sidebar(page)).toBeHidden();
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

/** 等侧栏入场动画结束（切换面板时侧栏不重放动画）。 */
async function settleSidebar(page: Page): Promise<void> {
  await sidebar(page).evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
}

test('工作区与管理共用一个侧栏：切换面板时侧栏不跳、不重建，不丢草稿、阅读位置与运行状态', async ({ page, request }) => {
  await openPanel(page, 'workspace');
  await page.keyboard.press('ControlOrMeta+J');
  const draft = sidebar(page).getByLabel('Multivac 草稿');
  await expect(draft).toBeFocused();
  await settleSidebar(page);
  // 同一个呈现实例：打上记号，切换面板后记号仍在（没有重建）。
  await sidebar(page).evaluate((element) => { element.dataset.marker = 'same'; });
  const box = await sidebar(page).boundingBox();

  // 运行中切到管理：侧栏原地不动、不重放入场动画，运行照常进行。
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);
  await draft.fill('运行中切换面板');
  await draft.press('Enter');
  expect((await request.get(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`)).ok()).toBe(true);
  await expect(sidebar(page).getByRole('button', { name: '取消当前处理' })).toBeVisible();
  await openPanel(page, 'management');
  await expect(page.locator('.app-shell')).toHaveClass(/management-mode/);
  await expect(sidebar(page)).toBeVisible();
  expect(await sidebar(page).getAttribute('data-marker')).toBe('same');
  expect(await sidebar(page).evaluate((element) => element.getAnimations().length)).toBe(0);
  expect(await sidebar(page).boundingBox()).toEqual(box);
  await expect(sidebar(page).getByRole('button', { name: '取消当前处理' })).toBeVisible();
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(sidebar(page).getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();

  // 草稿与阅读位置随侧栏走：回到工作区原样。
  await draft.fill('切换面板前写的草稿');
  const scroll = sidebar(page).locator('.message-scroll');
  await scroll.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 400);
    element.dispatchEvent(new Event('scroll'));
  });
  const readingTop = await scroll.evaluate((element) => element.scrollTop);
  expect(readingTop).toBeGreaterThan(0);
  await openPanel(page, 'workspace');
  await expect(sidebar(page)).toBeVisible();
  expect(await sidebar(page).getAttribute('data-marker')).toBe('same');
  expect(await sidebar(page).evaluate((element) => element.getAnimations().length)).toBe(0);
  await expect(draft).toHaveValue('切换面板前写的草稿');
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(readingTop, 0);

  // 开合只有一个状态：在工作区收起，到管理中同样是收起的；在管理中叫出，回到工作区也开着。
  await sidebar(page).getByRole('button', { name: '收起 Multivac' }).click();
  await openPanel(page, 'management');
  await expect(sidebar(page)).toBeHidden();
  await page.keyboard.press('ControlOrMeta+J');
  await expect(draft).toBeFocused();
  await openPanel(page, 'workspace');
  await expect(sidebar(page)).toBeVisible();
  expect(await sidebar(page).getAttribute('data-marker')).toBe('same');
  await expect(draft).toHaveValue('切换面板前写的草稿');
});

test('并排与浮层：切换只记在本机，刷新后保持；并排挤压页面，浮层覆盖页面右侧且不改变页面排版', async ({ page }) => {
  await openModelSettings(page);
  const unsqueezed = (await managementPage(page).boundingBox())!;
  await page.keyboard.press('ControlOrMeta+J');
  await settleSidebar(page);
  const draft = sidebar(page).getByLabel('Multivac 草稿');
  await draft.fill('切换浮层前写的草稿');

  // 默认与页面并排：管理页止于侧栏左缘。
  const toOverlay = sidebar(page).getByRole('button', { name: '改为浮在页面上' });
  await expect(toOverlay).toHaveAttribute('title', '改为浮在页面上');
  await expect(sidebar(page)).not.toHaveClass(/floating/);
  let panel = (await sidebar(page).boundingBox())!;
  expect((await managementPage(page).boundingBox())!.x + (await managementPage(page).boundingBox())!.width)
    .toBeLessThanOrEqual(panel.x + 1);

  // 浮在页面上：管理页保持不带侧栏时的宽度，侧栏盖住页面右侧；草稿不丢。
  await toOverlay.click();
  await expect(sidebar(page)).toHaveClass(/floating/);
  await expect(sidebar(page).getByRole('button', { name: '改为与页面并排' })).toBeVisible();
  panel = (await sidebar(page).boundingBox())!;
  const overlaid = (await managementPage(page).boundingBox())!;
  expect(overlaid.width).toBeCloseTo(unsqueezed.width, 0);
  expect(panel.x).toBeLessThan(overlaid.x + overlaid.width);
  expect(Math.round(panel.width)).toBe(360);
  await expect(draft).toHaveValue('切换浮层前写的草稿');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth))
    .toBe(false);
  expect(await page.evaluate(() => localStorage.getItem('multivac.sidebar.dock'))).toBe('overlay');

  // 刷新后仍是浮层；工作区里同样浮在页面上，工作区铺满内容区。
  await page.reload();
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
  await openPanel(page, 'workspace');
  await page.keyboard.press('ControlOrMeta+J');
  await expect(sidebar(page)).toHaveClass(/floating/);
  const content = (await page.locator('.shell-content').boundingBox())!;
  const workspace = (await page.locator('.workspace-shell').boundingBox())!;
  expect(Math.round(workspace.width)).toBe(Math.round(content.width));

  // 改回并排：工作区止于侧栏左缘；刷新后仍是并排。
  await sidebar(page).getByRole('button', { name: '改为与页面并排' }).click();
  await expect(sidebar(page)).not.toHaveClass(/floating/);
  await settleSidebar(page);
  panel = (await sidebar(page).boundingBox())!;
  const squeezed = (await page.locator('.workspace-shell').boundingBox())!;
  expect(squeezed.x + squeezed.width).toBeLessThanOrEqual(panel.x + 1);
  await page.reload();
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
  await openPanel(page, 'workspace');
  await page.keyboard.press('ControlOrMeta+J');
  await expect(sidebar(page)).toBeVisible();
  await expect(sidebar(page)).not.toHaveClass(/floating/);
  expect(await page.evaluate(() => localStorage.getItem('multivac.sidebar.dock'))).toBe('push');
});

test('管理中会话页、项目页选中的对象作为侧栏上下文，发送时交给服务端；开始干活即收起', async ({ page, request }) => {
  for (const [sessionId, title] of [['ctx-a', '核对接口'], ['ctx-b', '梳理导航'], ['ctx-old', '旧会话']] as const) {
    expect((await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title } })).status()).toBe(201);
  }
  expect((await request.post(`${fakeApiRoot}/api/sessions/ctx-old/archive`)).ok()).toBe(true);
  const created = await request.post(`${fakeApiRoot}/api/projects`, { data: { name: '资料整理' } });
  const { project } = await created.json() as { project: { projectId: string } };
  await page.reload();
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();

  const sessionsPage = page.getByRole('main', { name: '会话' });
  const context = sidebar(page).locator('.composer-context');
  await openPanel(page, 'management');
  await expect(sessionsPage.getByRole('list', { name: '会话列表' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+J');
  const firstTitle = await sessionsPage.locator('[aria-current="true"] strong').textContent();
  await expect(context).toHaveText(`正在看会话「${firstTitle}」，可以直接说“这个”`);

  // 点选会话：提示跟着变，侧栏不收起；发送时把选中的会话作为上下文交给服务端。
  await sessionsPage.getByRole('button').filter({ hasText: '核对接口' }).click();
  await expect(context).toHaveText('正在看会话「核对接口」，可以直接说“这个”');
  await expect(sidebar(page)).toBeVisible();
  const sessionTurn = page.waitForRequest((item) =>
    item.method() === 'POST' && new URL(item.url()).pathname === '/api/assistant/turns');
  await sidebar(page).getByLabel('Multivac 草稿').fill('这个会话下一步做什么？');
  await sidebar(page).getByLabel('发送消息').click();
  expect((await sessionTurn).postDataJSON().contextRefs).toEqual([{ kind: 'workspace-session', sessionId: 'ctx-a' }]);
  await expect(sidebar(page).getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();

  // 搜索只是找东西，不算干活：侧栏不收起。已归档的会话不作为上下文（服务端只接受未归档的会话）。
  await sessionsPage.getByRole('searchbox', { name: '按标题搜索' }).click();
  await expect(sidebar(page)).toBeVisible();
  await sessionsPage.getByRole('group', { name: '按状态筛选' }).getByRole('button', { name: '已归档' }).click();
  await expect(sessionsPage.locator('[aria-current="true"] strong')).toHaveText('旧会话');
  await expect(context).toHaveCount(0);

  // 项目页：选中的项目作为上下文。
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '项目' }).click();
  await expect(context).toHaveText('正在看项目「资料整理」，可以直接说“这个”');
  const projectTurn = page.waitForRequest((item) =>
    item.method() === 'POST' && new URL(item.url()).pathname === '/api/assistant/turns');
  await sidebar(page).getByLabel('Multivac 草稿').fill('这个项目还缺什么？');
  await sidebar(page).getByLabel('发送消息').click();
  expect((await projectTurn).postDataJSON().contextRefs).toEqual([{ kind: 'project', projectId: project.projectId }]);
  await expect(sidebar(page).getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();

  // 没有选中对象的页面不提示。
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '模型' }).click();
  await expect(context).toHaveCount(0);

  // 在管理页里开始干活（点进默认约束）：侧栏里有草稿时不收起，草稿清空后收起。
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '项目' }).click();
  const constraints = page.getByRole('main', { name: '项目' }).getByRole('textbox', { name: '默认约束' });
  await sidebar(page).getByLabel('Multivac 草稿').fill('还没想好');
  await constraints.click();
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByLabel('Multivac 草稿').fill('');
  await constraints.click();
  await expect(constraints).toBeFocused();
  await expect(sidebar(page)).toBeHidden();
});
