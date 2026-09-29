import { expect, test } from '@playwright/test';
import { fakeApiRoot, openModelSettings, openPanel, resetE2eState } from './test-state.js';

test.beforeEach(async ({ request }) => {
  await resetE2eState(request);
  const response = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
  const current = await response.json() as { revision: number };
  await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
    data: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, revision: current.revision },
  });
});

async function messageOffset(page: import('@playwright/test').Page, entryId: string) {
  return page.locator(`[data-entry-id="${entryId}"]`).evaluate((element) => {
    const container = element.closest('.message-scroll')!;
    return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });
}

test('Logo 区为白底，悬停结束及进出管理后恢复背景', async ({ page }) => {
  await page.goto('/');
  const logo = page.locator('.logo-area');
  const header = page.locator('.shell-header');
  await page.mouse.move(400, 100);
  await expect(logo).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await logo.hover();
  await expect(logo).toHaveCSS('background-color', 'rgb(246, 248, 249)');
  await page.mouse.move(400, 100);
  await expect(logo).toHaveCSS('background-color', 'rgb(255, 255, 255)');

  await logo.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(logo).toBeFocused();
  await expect(logo).toHaveCSS('outline-style', 'solid');
  await expect(logo).toHaveCSS('background-color', 'rgb(255, 255, 255)');

  // 管理中的 Logo 区同样是白底。
  await openPanel(page, 'management');
  await expect(page.locator('.app-shell')).toHaveClass(/management-mode/);
  await page.mouse.move(400, 100);
  await expect(logo).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(header).toBeVisible();
  await logo.press('Enter');
  await expect(page.locator('.app-shell')).toHaveClass(/work-mode/);
  await page.mouse.move(400, 100);
  await expect(logo).toHaveCSS('background-color', 'rgb(255, 255, 255)');
});

test('顶栏：高 58px，Logo 单独一列且没有竖线；工作中不显示副标题，也没有模拟的连接状态', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const header = page.locator('.shell-header');
  const logo = page.getByRole('button', { name: '回到 Multivac', exact: true });

  const headerBox = (await header.boundingBox())!;
  expect(headerBox.height).toBe(58);
  const logoBox = (await logo.boundingBox())!;
  expect(logoBox.width).toBe(196);
  await expect(logo).toHaveCSS('border-right-width', '0px');
  await expect(logo).toHaveAttribute('title', '回到 Multivac');
  await expect(logo.locator('svg')).toHaveCount(1);
  await expect(logo.locator('.logo-copy')).toHaveText('Multivac');
  await expect(header).not.toContainText('已连接');
  // 右侧只有“?”（34px 图标按钮，距右缘 20px）；切换工作面与进入管理靠 ⌘G 与“?”。
  const help = header.getByRole('button', { name: '快捷键' });
  await expect(header.getByRole('button')).toHaveCount(2);
  await expect(help).toBeVisible();
  const helpBox = (await help.boundingBox())!;
  expect(helpBox.width).toBe(34);
  expect(helpBox.height).toBe(34);
  expect(1440 - (helpBox.x + helpBox.width)).toBe(20);

  await openPanel(page, 'workspace');
  await expect(logo.locator('.logo-copy')).toHaveText('Multivac');
  await expect(header.getByRole('button')).toHaveCount(2);
  await expect(help).toBeVisible();

  // 管理中 Logo 下方小字“管理”，页面名在左侧紧挨 Logo 列，不带“管理 /”前缀。
  await openPanel(page, 'management');
  await expect(logo.locator('.logo-copy small')).toHaveText('管理');
  const pageName = page.locator('.shell-page-name');
  await expect(pageName).toHaveText('会话');
  await expect(pageName).toHaveCSS('font-size', '15px');
  const pageNameBox = (await pageName.boundingBox())!;
  expect(pageNameBox.x).toBeGreaterThanOrEqual(196);
  expect(pageNameBox.x).toBeLessThan(240);
  expect((await header.boundingBox())!.height).toBe(58);
  // 管理中右侧与其他层相同：没有“Multivac”侧栏开关，也没有页头的“返回”。
  await expect(header.getByRole('button')).toHaveCount(2);
  await expect(help).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Multivac|返回|管理|进入工作区|返回 Multivac)$/ })).toHaveCount(0);
});

test('Logo 在任何一层都回到 Multivac 首页；Esc 回到进入管理前的面板', async ({ page }) => {
  await page.goto('/');
  const logo = page.getByRole('button', { name: '回到 Multivac', exact: true });
  // 第一个工作面是 Multivac 首页，工作区在它之后挂载。
  const home = page.locator('.work-surface').first();
  const workspace = page.getByRole('toolbar', { name: '工作区' });

  // 首页点 Logo 仍停在首页。
  await logo.click();
  await expect(page.locator('.app-shell')).toHaveClass(/work-mode/);
  await expect(home).toBeVisible();

  // 工作区点 Logo 回首页。
  await openPanel(page, 'workspace');
  await expect(workspace).toBeVisible();
  await logo.click();
  await expect(home).toBeVisible();
  await expect(workspace).toBeHidden();

  // 从工作区进入管理，点 Logo 回到首页而不是工作区；Esc 才回到进入前的工作区。
  await openPanel(page, 'workspace');
  await openPanel(page, 'management');
  await expect(page.locator('.app-shell')).toHaveClass(/management-mode/);
  await page.keyboard.press('Escape');
  await expect(workspace).toBeVisible();
  await openPanel(page, 'management');
  await logo.click();
  await expect(page.locator('.app-shell')).toHaveClass(/work-mode/);
  await expect(home).toBeVisible();
  await expect(workspace).toBeHidden();
});

test('模型页有未保存的修改时，点 Logo 先经过离开确认', async ({ page }) => {
  await page.goto('/');
  await openPanel(page, 'workspace');
  await openModelSettings(page);
  const logo = page.getByRole('button', { name: '回到 Multivac', exact: true });
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('显示名称').fill('尚未保存的名称');

  // 继续编辑：留在管理，草稿不变。
  const leaveCard = page.getByRole('dialog', { name: '放弃未保存的更改？' });
  await logo.click();
  await leaveCard.getByRole('button', { name: '继续编辑' }).click();
  await expect(leaveCard).toHaveCount(0);
  await expect(page.locator('.app-shell')).toHaveClass(/management-mode/);
  await expect(page.getByLabel('显示名称')).toHaveValue('尚未保存的名称');

  // 放弃并离开：回到首页，草稿被丢弃。
  await logo.click();
  await leaveCard.getByRole('button', { name: '放弃并离开' }).click();
  await expect(page.locator('.app-shell')).toHaveClass(/work-mode/);
  await expect(page.locator('.work-surface').first().getByLabel('Multivac 草稿')).toBeVisible();
  await expect(page.getByRole('toolbar', { name: '工作区' })).toBeHidden();
  await openPanel(page, 'management');
  await expect(page.getByLabel('显示名称')).toHaveCount(0);
});

/** 界面文字、无障碍名称与提示中都不出现“管理模式”与“工作模式”。 */
async function expectNoModeWording(page: import('@playwright/test').Page) {
  const text = await page.locator('body').innerText();
  expect(text).not.toContain('管理模式');
  expect(text).not.toContain('工作模式');
  await expect(page.locator([
    '[aria-label*="管理模式"]', '[title*="管理模式"]', '[aria-label*="工作模式"]', '[title*="工作模式"]',
  ].join(', '))).toHaveCount(0);
}

test('管理导航按分组只列已实现的页面，界面统一称“管理”', async ({ page }) => {
  await page.goto('/');
  await expectNoModeWording(page);
  await openPanel(page, 'workspace');
  await expect(page.getByRole('toolbar', { name: '工作区' })).toBeVisible();
  await expectNoModeWording(page);

  await openPanel(page, 'management');
  await expect(page.locator('.app-shell')).toHaveClass(/management-mode/);

  // 工作组的“会话”与设置组的“项目”“模型”“偏好”；没有已实现页面的“应用”组整组不出现。进入管理首先打开“会话”。
  // 记住的授权按归属放在项目与会话里，没有单独的“授权记录”页。
  const nav = page.getByRole('complementary', { name: '管理导航' });
  await expect(nav.getByRole('group')).toHaveCount(2);
  const work = nav.getByRole('group', { name: '工作' });
  const settings = nav.getByRole('group', { name: '设置' });
  await expect(work.getByText('工作', { exact: true })).toBeVisible();
  await expect(settings.getByText('设置', { exact: true })).toBeVisible();
  await expect(nav.getByRole('group', { name: '应用' })).toHaveCount(0);
  await expect(nav.getByRole('button')).toHaveText(['会话', '项目', '模型', '偏好']);
  await expect(nav.getByText('授权记录')).toHaveCount(0);
  await expect(work.getByRole('button', { name: '会话' })).toHaveAttribute('aria-current', 'page');
  // 有其他分组时设置组沉到底部。
  const workBox = await work.boundingBox();
  const settingsBox = await settings.boundingBox();
  expect(settingsBox!.y).toBeGreaterThan(workBox!.y + workBox!.height + 40);

  // 顶栏称“管理”，顶栏左侧只写页面名；页头只有标题，不放眉题与说明。
  await expect(page.locator('.logo-area')).toHaveAccessibleName('回到 Multivac');
  await expect(page.locator('.logo-copy small')).toHaveText('管理');
  await expect(page.locator('.shell-page-name')).toHaveText('会话');
  await expect(page.getByRole('main', { name: '会话' }).locator('.management-page-header')).toHaveText('会话');
  await settings.getByRole('button', { name: '模型' }).click();
  await expect(settings.getByRole('button', { name: '模型' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.shell-page-name')).toHaveText('模型');
  const main = page.getByRole('main', { name: '模型' });
  await expect(main.getByRole('heading', { name: '模型', level: 1 })).toBeVisible();
  // 模型页页头除标题外只有主要操作位里的“添加模型”。
  await expect(main.locator('.management-page-header h1')).toHaveText('模型');
  await expect(main.locator('.management-page-actions')).toHaveText('添加模型');
  await expect(main.locator('.management-page-header')).toHaveText('模型添加模型');
  await expectNoModeWording(page);

  // 打开 Multivac 侧栏后同样不出现。
  await page.keyboard.press('ControlOrMeta+J');
  await expect(page.locator('.multivac-sidebar')).toBeVisible();
  await expectNoModeWording(page);

  // 窄屏不显示管理导航与页面，只给“管理请在桌面使用”；回到宽屏后仍在原来的页面。
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(page.getByRole('heading', { name: '管理请在桌面使用' })).toBeVisible();
  await expect(nav).toHaveCount(0);
  await expect(main).toBeHidden();
  await expectNoModeWording(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('heading', { name: '管理请在桌面使用' })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: '模型' })).toHaveAttribute('aria-current', 'page');
  await expect(main).toBeVisible();

  // 离开管理再进入，回到上次所在的页面。
  await openPanel(page, 'workspace');
  await expect(page.locator('.app-shell')).toHaveClass(/work-mode/);
  await openPanel(page, 'management');
  await expect(page.locator('.shell-page-name')).toHaveText('模型');
});

test('管理外壳按原型：导航分组有分隔线、条目 38px、选中项左侧竖条；页头只有标题；列表页铺满，偏好页正文限宽', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await openPanel(page, 'management');
  const nav = page.getByRole('complementary', { name: '管理导航' });
  const work = nav.getByRole('group', { name: '工作' });
  const settings = nav.getByRole('group', { name: '设置' });

  // 导航：浅底；组与组之间 1px 分隔线；条目 38px 高、4px 圆角；选中项浅强调底色加左侧 2px 深色竖条。
  await expect(nav).toHaveCSS('background-color', 'rgb(251, 252, 253)');
  await expect(work).toHaveCSS('border-top-width', '0px');
  await expect(settings).toHaveCSS('border-top-width', '1px');
  await expect(settings).toHaveCSS('border-top-color', 'rgb(227, 231, 234)');
  const active = work.getByRole('button', { name: '会话' });
  const idle = settings.getByRole('button', { name: '项目' });
  expect((await active.boundingBox())!.height).toBe(38);
  await expect(idle).toHaveCSS('border-radius', '4px');
  await expect(idle).toHaveCSS('box-shadow', 'none');
  await expect(active).toHaveCSS('background-color', 'rgb(233, 237, 242)');
  await expect(active).toHaveCSS('box-shadow', 'rgb(51, 66, 79) 2px 0px 0px 0px inset');

  // 页头：只有 22px 标题（主要操作位为空时不占位），下方一条分隔线。
  const sessions = page.getByRole('main', { name: '会话' });
  const sessionsHeader = sessions.locator('.management-page-header');
  await expect(sessionsHeader).toHaveText('会话');
  await expect(sessionsHeader.locator('p')).toHaveCount(0);
  await expect(sessionsHeader.getByRole('heading', { level: 1 })).toHaveCSS('font-size', '22px');
  await expect(sessionsHeader).toHaveCSS('border-bottom-width', '1px');
  await expect(sessionsHeader.locator('.management-page-actions')).toBeHidden();

  // 列表 + 详情的页铺满可用宽度（左右各 30px 内边距），不再统一限宽。
  const pageBox = (await sessions.boundingBox())!;
  expect(pageBox.x).toBe(196);
  expect(pageBox.x + pageBox.width).toBe(1440);
  const sessionsBody = (await sessions.locator('.management-page-body').boundingBox())!;
  expect(sessionsBody.x).toBe(226);
  expect(sessionsBody.width).toBeGreaterThan(1100);

  // 偏好这类简单规则页：页头仍铺满，正文限宽 880px。
  await settings.getByRole('button', { name: '偏好' }).click();
  const preferences = page.getByRole('main', { name: '偏好' });
  const preferencesHeader = (await preferences.locator('.management-page-header').boundingBox())!;
  const preferencesBody = (await preferences.locator('.management-page-body').boundingBox())!;
  expect(preferencesHeader.width).toBeGreaterThan(1100);
  expect(preferencesBody.width).toBe(880);
});

test('首页默认不显示管理侧栏，并可双向切换到模型管理页', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('.app-shell')).toHaveClass(/work-mode/);
  await expect(page.locator('.logo-copy small')).toHaveCount(0);
  await expect(page.locator('aside, nav')).toHaveCount(0);
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();

  await openModelSettings(page);

  await expect(page.locator('.app-shell')).toHaveClass(/management-mode/);
  await expect(page.getByRole('heading', { name: '模型', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'GPT Fixture' })).toBeVisible();
  await expect(page.getByText('Pi 报告的能力')).toHaveCount(0);
  await expect(page.locator('[data-management-page="models"] input:not([type="password"])')).toHaveCount(0);
  await expect(page.locator('[data-management-page="models"] input[type="password"]')).toHaveCount(1);
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  await expect(page.locator('[data-management-page="models"] select')).toHaveCount(0);
  await expect(page.locator('.management-sidebar button')).toHaveCount(4);
  await expect(page.getByRole('button', { name: /待办|Inbox|成果|资料库|记忆/ })).toHaveCount(0);

  await page.keyboard.press('Escape');

  await expect(page.locator('.app-shell')).toHaveClass(/work-mode/);
  await expect(page.locator('.logo-copy small')).toHaveCount(0);
  await expect(page.locator('aside, nav')).toHaveCount(0);
  await expect(page.getByLabel('Multivac 草稿')).toBeVisible();
});

test('会话内进入模型页保留草稿、阅读位置、焦点且不重新初始化会话', async ({ page }) => {
  let sessionRequests = 0;
  let eventSubscriptions = 0;
  await page.route('**/api/assistant/session?*', async (route) => {
    sessionRequests += 1;
    await route.continue();
  });
  // 会话状态全局唯一：模式切换期间始终只有一条事件订阅。
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/assistant/events') eventSubscriptions += 1;
  });

  await page.goto('/');
  const draft = page.getByLabel('Multivac 草稿');
  const scroll = page.locator('.message-scroll');
  await expect(draft).toBeEditable();
  await expect(page.locator('[data-entry-id="entry-072"]')).toBeVisible();

  await scroll.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 320);
    element.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const readingPosition = await scroll.evaluate((element) => element.scrollTop);
  await draft.fill('切换模式后仍保留的草稿');
  await expect(draft).toBeFocused();
  const initializedRequests = sessionRequests;

  await page.getByRole('button', { name: '当前会话模型' }).click();
  await page.getByRole('button', { name: '管理模型配置' }).click();

  await expect(page.getByRole('heading', { name: '模型', level: 1 })).toBeVisible();
  await expect(draft).toHaveCount(1);
  await expect(draft).toBeHidden();
  expect(sessionRequests).toBe(initializedRequests);

  await page.keyboard.press('Escape');

  await expect(draft).toHaveValue('切换模式后仍保留的草稿');
  await expect(draft).toBeFocused();
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(readingPosition, 0);
  expect(sessionRequests).toBe(initializedRequests);
  expect(eventSubscriptions).toBe(1);
});

test('初始化恢复在管理中完成后，返回时才应用阅读锚点', async ({ page, request }) => {
  const currentResponse = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
  const current = await currentResponse.json() as { revision: number };
  await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
    data: {
      draft: '隐藏期间恢复的草稿',
      anchorEntryId: 'entry-050',
      anchorOffsetPx: 18,
      revision: current.revision,
    },
  });

  let releaseSession!: () => void;
  const sessionGate = new Promise<void>((resolve) => { releaseSession = resolve; });
  await page.route('**/api/assistant/session?*', async (route) => {
    await sessionGate;
    await route.continue();
  });

  await page.goto('/');
  await expect(page.getByText('正在恢复会话')).toBeVisible();
  await openPanel(page, 'management');
  await expect(page.locator('main.management-page')).toBeFocused();

  releaseSession();
  const draft = page.getByLabel('Multivac 草稿');
  await expect(draft).toHaveValue('隐藏期间恢复的草稿');
  await expect(draft).toBeHidden();

  await page.keyboard.press('Escape');

  await expect(page.locator('[data-entry-id="entry-050"]')).toBeVisible();
  await expect.poll(() => messageOffset(page, 'entry-050')).toBeCloseTo(18, 0);
});

test('加载更早消息在管理中完成后，返回时补偿阅读位置并回退失效焦点', async ({ page }) => {
  await page.goto('/');
  const loadEarlier = page.getByRole('button', { name: '加载更早消息' });
  const preserved = page.locator('[data-entry-id="entry-043"]');
  await expect(loadEarlier).toBeVisible();
  await loadEarlier.scrollIntoViewIfNeeded();
  await expect(preserved).toBeVisible();
  const beforeOffset = await messageOffset(page, 'entry-043');

  let releaseEarlier!: () => void;
  let earlierStarted!: () => void;
  const earlierGate = new Promise<void>((resolve) => { releaseEarlier = resolve; });
  const earlierRequest = new Promise<void>((resolve) => { earlierStarted = resolve; });
  await page.route('**/api/assistant/session?*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.has('before')) return route.continue();
    earlierStarted();
    await earlierGate;
    const response = await route.fetch();
    const body = await response.json() as Record<string, unknown>;
    await route.fulfill({
      response,
      contentType: 'application/json',
      body: JSON.stringify({ ...body, hasMore: false, nextBefore: null }),
    });
  });

  await loadEarlier.click();
  await earlierRequest;
  await openPanel(page, 'management');
  await expect(page.locator('main.management-page')).toBeFocused();

  releaseEarlier();
  await expect(page.locator('[data-entry-id="entry-013"]')).toHaveCount(1);
  await expect(page.locator('[data-entry-id="entry-013"]')).toBeHidden();

  await page.keyboard.press('Escape');

  await expect(page.locator('[data-entry-id="entry-013"]')).toBeVisible();
  await expect.poll(async () => Math.abs(
    await messageOffset(page, 'entry-043') - beforeOffset,
  )).toBeLessThan(3);
  await expect(page.getByLabel('Multivac 草稿')).toBeFocused();
});

test('历史请求挂起时先离开管理，响应后仍按对应批次补偿阅读位置', async ({ page }) => {
  await page.goto('/');
  const loadEarlier = page.getByRole('button', { name: '加载更早消息' });
  await loadEarlier.scrollIntoViewIfNeeded();
  const beforeOffset = await messageOffset(page, 'entry-043');

  let releaseEarlier!: () => void;
  let earlierStarted!: () => void;
  const earlierGate = new Promise<void>((resolve) => { releaseEarlier = resolve; });
  const earlierRequest = new Promise<void>((resolve) => { earlierStarted = resolve; });
  await page.route('**/api/assistant/session?*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.has('before')) return route.continue();
    earlierStarted();
    await earlierGate;
    await route.continue();
  });

  await loadEarlier.click();
  await earlierRequest;
  await openPanel(page, 'management');
  await expect(page.locator('main.management-page')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '正在加载' })).toBeVisible();

  releaseEarlier();

  await expect(page.locator('[data-entry-id="entry-013"]')).toBeVisible();
  await expect.poll(async () => Math.abs(
    await messageOffset(page, 'entry-043') - beforeOffset,
  )).toBeLessThan(3);
});

test('管理页接管焦点，返回时恢复助手内最后一个非输入焦点', async ({ page }) => {
  await page.goto('/');
  const messageScroll = page.locator('.message-scroll');
  await expect(messageScroll).toBeVisible();
  await messageScroll.focus();
  await expect(messageScroll).toBeFocused();

  await openPanel(page, 'management');
  await expect(page.locator('main.management-page')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(messageScroll).toBeFocused();
});

test('窄屏从选模菜单进入模型管理时提示在桌面使用，回到宽屏后管理页独立纵向滚动', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await page.goto('/');
  const scroll = page.locator('.message-scroll');
  await scroll.evaluate((element) => { element.scrollTop = 180; });
  const assistantScrollTop = await scroll.evaluate((element) => element.scrollTop);
  await expect(page.locator('.manage-models-button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '管理模型配置' })).toHaveCount(0);
  await page.getByRole('button', { name: '当前会话模型' }).click();
  const manageModels = page.getByRole('button', { name: '管理模型配置' });

  await expect(manageModels).toBeVisible();
  await expect(manageModels.locator('svg').first()).toBeVisible();
  expect(await manageModels.evaluate((button) => getComputedStyle(button).color))
    .not.toBe('rgba(0, 0, 0, 0)');

  await manageModels.click();
  const managementPage = page.locator('main.management-page');
  await expect(page.getByRole('heading', { name: '管理请在桌面使用' })).toBeVisible();
  await expect(managementPage).toBeHidden();

  // “回到 Multivac”回到首页，阅读位置不变。
  await page.getByRole('region', { name: '管理请在桌面使用' }).getByRole('button', { name: '回到 Multivac' }).click();
  await expect(page.getByRole('heading', { name: '管理请在桌面使用' })).toHaveCount(0);
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(assistantScrollTop);

  // 宽屏（高度仍然很矮）从同一入口进入模型页，管理页自己纵向滚动。
  await page.setViewportSize({ width: 1024, height: 500 });
  await page.getByRole('button', { name: '当前会话模型' }).click();
  await manageModels.click();
  await expect(managementPage).toBeFocused();
  expect(await managementPage.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
  expect(await managementPage.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
    await managementPage.evaluate((element) => element.clientHeight),
  );
  await managementPage.evaluate((element) => { element.scrollTop = 120; });
  await expect.poll(() => managementPage.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await page.keyboard.press('Escape');
  await expect(scroll).toBeVisible();
});

test('已开始的 Turn 在管理中继续运行且返回后展示终态', async ({ page, request }) => {
  let turnRequests = 0;
  await page.route('**/api/assistant/turns', async (route) => {
    turnRequests += 1;
    await route.continue();
  });

  await page.goto('/');
  const draft = page.getByLabel('Multivac 草稿');
  await expect(draft).toBeEditable();
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);

  await draft.fill('切换到管理时继续运行的消息');
  await page.getByLabel('发送消息').click();
  await expect(page.getByText('Multivac 正在处理')).toBeVisible();

  await openModelSettings(page);
  await expect(page.getByRole('heading', { name: 'GPT Fixture' })).toBeVisible();
  expect(turnRequests).toBe(1);

  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(page.locator('.work-surface')).toHaveAttribute('hidden', '');
  await expect(page.locator('.work-surface .run-status')).toContainText('处理完成');
  await expect(page.locator('article.chat-row.user').filter({
    hasText: '切换到管理时继续运行的消息',
  })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'GPT Fixture' })).toBeVisible();
  await page.keyboard.press('Escape');

  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(page.locator('article.chat-row.user').filter({
    hasText: '切换到管理时继续运行的消息',
  })).toHaveCount(1);
  expect(turnRequests).toBe(1);
});
