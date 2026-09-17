import { expect, test } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';

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

test('模式入口默认保持浅色，悬停结束及模式切换后恢复背景', async ({ page }) => {
  await page.goto('/');
  const entry = page.locator('.logo-area');
  const header = page.locator('.shell-header');
  await page.mouse.move(400, 100);
  await expect(entry).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await entry.hover();
  await expect(entry).toHaveCSS('background-color', 'rgb(246, 248, 246)');
  await page.mouse.move(400, 100);
  await expect(entry).toHaveCSS('background-color', 'rgb(255, 255, 255)');

  await entry.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(entry).toBeFocused();
  await expect(entry).toHaveCSS('outline-style', 'solid');
  await expect(entry).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await entry.press('Enter');
  await expect(page.locator('.app-shell')).toHaveClass(/management-mode/);
  await expect(entry).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(header).toBeVisible();
  await page.getByRole('button', { name: '返回工作模式' }).first().click();
  await expect(page.locator('.app-shell')).toHaveClass(/work-mode/);
  await page.mouse.move(400, 100);
  await expect(entry).toHaveCSS('background-color', 'rgb(255, 255, 255)');
});

test('默认工作模式不显示管理侧栏，并可双向切换到模型管理页', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('.app-shell')).toHaveClass(/work-mode/);
  await expect(page.getByText('工作模式', { exact: true })).toBeVisible();
  await expect(page.locator('aside, nav')).toHaveCount(0);
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();

  await page.getByRole('button', { name: '打开管理模式' }).click();

  await expect(page.locator('.app-shell')).toHaveClass(/management-mode/);
  await expect(page.getByRole('heading', { name: '模型', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'GPT Fixture' })).toBeVisible();
  await expect(page.getByText('Pi 报告的能力')).toBeVisible();
  await expect(page.locator('[data-management-page="models"] input:not([type="password"])')).toHaveCount(0);
  await expect(page.locator('[data-management-page="models"] input[type="password"]')).toHaveCount(1);
  await expect(page.getByLabel('一次性 API Key')).toHaveValue('');
  await expect(page.locator('[data-management-page="models"] select')).toHaveCount(0);
  await expect(page.locator('.management-sidebar button')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /待办|Inbox|成果|资料库|记忆/ })).toHaveCount(0);

  await page.getByRole('button', { name: '返回工作模式' }).first().click();

  await expect(page.locator('.app-shell')).toHaveClass(/work-mode/);
  await expect(page.getByText('工作模式', { exact: true })).toBeVisible();
  await expect(page.locator('aside, nav')).toHaveCount(0);
  await expect(page.getByLabel('Multivac 草稿')).toBeVisible();
});

test('会话内进入模型页保留草稿、阅读位置、焦点且不重新初始化会话', async ({ page }) => {
  let sessionRequests = 0;
  await page.route('**/api/assistant/session?*', async (route) => {
    sessionRequests += 1;
    await route.continue();
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

  await page.getByRole('button', { name: '管理模型配置' }).click();

  await expect(page.getByRole('heading', { name: '模型', level: 1 })).toBeVisible();
  await expect(draft).toHaveCount(1);
  await expect(draft).toBeHidden();
  expect(sessionRequests).toBe(initializedRequests);

  await page.getByRole('button', { name: '返回工作模式' }).first().click();

  await expect(draft).toHaveValue('切换模式后仍保留的草稿');
  await expect(draft).toBeFocused();
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(readingPosition, 0);
  expect(sessionRequests).toBe(initializedRequests);
});

test('初始化恢复在管理模式完成后，返回时才应用阅读锚点', async ({ page, request }) => {
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
  await page.getByRole('button', { name: '打开管理模式' }).click();
  await expect(page.locator('main.management-page')).toBeFocused();

  releaseSession();
  const draft = page.getByLabel('Multivac 草稿');
  await expect(draft).toHaveValue('隐藏期间恢复的草稿');
  await expect(draft).toBeHidden();

  await page.getByRole('button', { name: '返回工作模式' }).first().click();

  await expect(page.locator('[data-entry-id="entry-050"]')).toBeVisible();
  await expect.poll(() => messageOffset(page, 'entry-050')).toBeCloseTo(18, 0);
});

test('加载更早消息在管理模式完成后，返回时补偿阅读位置并回退失效焦点', async ({ page }) => {
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
  await page.getByRole('button', { name: '打开管理模式' }).click();
  await expect(page.locator('main.management-page')).toBeFocused();

  releaseEarlier();
  await expect(page.locator('[data-entry-id="entry-013"]')).toHaveCount(1);
  await expect(page.locator('[data-entry-id="entry-013"]')).toBeHidden();

  await page.getByRole('button', { name: '返回工作模式' }).first().click();

  await expect(page.locator('[data-entry-id="entry-013"]')).toBeVisible();
  await expect.poll(async () => Math.abs(
    await messageOffset(page, 'entry-043') - beforeOffset,
  )).toBeLessThan(3);
  await expect(page.getByLabel('Multivac 草稿')).toBeFocused();
});

test('历史请求挂起时先返回工作模式，响应后仍按对应批次补偿阅读位置', async ({ page }) => {
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
  await page.getByRole('button', { name: '打开管理模式' }).click();
  await expect(page.locator('main.management-page')).toBeFocused();
  await page.getByRole('button', { name: '返回工作模式' }).first().click();
  await expect(page.getByRole('button', { name: '正在加载' })).toBeVisible();

  releaseEarlier();

  await expect(page.locator('[data-entry-id="entry-013"]')).toBeVisible();
  await expect.poll(async () => Math.abs(
    await messageOffset(page, 'entry-043') - beforeOffset,
  )).toBeLessThan(3);
});

test('管理模式接管焦点，返回时恢复助手内最后一个非输入焦点', async ({ page }) => {
  await page.goto('/');
  const messageScroll = page.locator('.message-scroll');
  await expect(messageScroll).toBeVisible();
  await messageScroll.focus();
  await expect(messageScroll).toBeFocused();

  await page.getByRole('button', { name: '打开管理模式' }).click();
  await expect(page.locator('main.management-page')).toBeFocused();

  await page.locator('.return-work-button').click();
  await expect(messageScroll).toBeFocused();
});

test('窄屏模型入口保留可见图标，管理页独立纵向滚动', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await page.goto('/');
  const scroll = page.locator('.message-scroll');
  await scroll.evaluate((element) => { element.scrollTop = 180; });
  const assistantScrollTop = await scroll.evaluate((element) => element.scrollTop);
  const manageModels = page.getByRole('button', { name: '管理模型配置' });

  await expect(manageModels).toBeVisible();
  await expect(manageModels).toHaveAttribute('title', '管理模型配置');
  await expect(manageModels.locator('svg')).toBeVisible();
  await expect(manageModels.locator('.manage-models-label')).toBeHidden();
  expect(await manageModels.evaluate((button) => getComputedStyle(button).color))
    .not.toBe('rgba(0, 0, 0, 0)');

  await manageModels.click();
  const managementPage = page.locator('main.management-page');
  await expect(managementPage).toBeFocused();
  expect(await managementPage.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
  expect(await managementPage.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
    await managementPage.evaluate((element) => element.clientHeight),
  );
  await managementPage.evaluate((element) => { element.scrollTop = 120; });
  await expect.poll(() => managementPage.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await page.getByRole('button', { name: '返回工作模式' }).first().click();
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(assistantScrollTop);
});

test('已开始的 Turn 在管理模式中继续运行且返回后展示终态', async ({ page, request }) => {
  let turnRequests = 0;
  await page.route('**/api/assistant/turns', async (route) => {
    turnRequests += 1;
    await route.continue();
  });

  await page.goto('/');
  const draft = page.getByLabel('Multivac 草稿');
  await expect(draft).toBeEditable();
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);

  await draft.fill('切换管理模式时继续运行的消息');
  await page.getByLabel('发送消息').click();
  await expect(page.getByText('Multivac 正在处理')).toBeVisible();

  await page.getByRole('button', { name: '打开管理模式' }).click();
  await expect(page.getByRole('heading', { name: 'GPT Fixture' })).toBeVisible();
  expect(turnRequests).toBe(1);

  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(page.locator('.work-surface')).toHaveAttribute('hidden', '');
  await expect(page.locator('.work-surface .run-status')).toContainText('处理完成');
  await expect(page.locator('article.chat-row.user').filter({
    hasText: '切换管理模式时继续运行的消息',
  })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'GPT Fixture' })).toBeVisible();
  await page.getByRole('button', { name: '返回工作模式' }).first().click();

  await expect(page.getByText('处理完成', { exact: true })).toBeVisible();
  await expect(page.locator('article.chat-row.user').filter({
    hasText: '切换管理模式时继续运行的消息',
  })).toHaveCount(1);
  expect(turnRequests).toBe(1);
});
