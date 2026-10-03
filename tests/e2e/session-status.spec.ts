import { test, expect } from '@playwright/test';
import { fakeApiRoot, resetE2eState, openPanel, ensureWorkspaceRail } from './test-state.js';

test('侧栏与快速跳转只用图标呈现三态，查看后消除未读并跨刷新保留', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  const sessionId = 'status-session';
  for (const [id, title] of [[sessionId, '等待回复的会话'], ['status-reader', '当前阅读的会话']]) {
    expect((await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId: id, title } })).ok()).toBeTruthy();
  }
  await page.goto('/');
  await openPanel(page, 'workspace');
  await ensureWorkspaceRail(page);
  const rail = page.getByRole('complementary', { name: '工作区会话导航' });
  await rail.getByRole('button', { name: '当前阅读的会话', exact: true }).first().click();
  const row = rail.locator(`[data-session-id="${sessionId}"]`).first();
  await expect(row.locator('.session-status-badge')).toHaveCount(0);
  await expect(page.locator('.conversation-header .session-status-badge')).toHaveCount(0);

  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBeTruthy();
  const running = request.post(`${fakeApiRoot}/api/sessions/${sessionId}/turns`, { data: { commandId: 'remote-status-turn', assistantSessionId: sessionId, text: '后台发起的处理', contextRefs: [] } });
  try {
    await expect(row.getByRole('img', { name: '会话状态：处理中' })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+K');
    const palette = page.getByRole('dialog', { name: '跳到会话' });
    const option = palette.getByRole('option').filter({ hasText: '等待回复的会话' });
    await expect(option.getByRole('img', { name: '会话状态：处理中' })).toBeVisible();
    expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBeTruthy();
    expect((await running).ok()).toBeTruthy();
    await expect(option.getByRole('img', { name: '会话状态：未查看' })).toBeVisible();
    await expect(option.locator('.session-status-badge')).toHaveText('');
    await page.screenshot({ path: testInfo.outputPath('session-status-unread.png') });
    await page.keyboard.press('Escape');
    await expect(row.getByRole('img', { name: '会话状态：未查看' })).toBeVisible();
    await page.reload();
    await openPanel(page, 'workspace');
    await ensureWorkspaceRail(page);
    await expect(row.getByRole('img', { name: '会话状态：未查看' })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+K');
    await option.click();
    await expect(page.locator(`.conversation-panel[data-session-id="${sessionId}"]`).getByLabel('Multivac 草稿')).toBeFocused();
    await expect(row.locator('.session-status-badge')).toHaveCount(0);
    await page.reload();
    await openPanel(page, 'workspace');
    await ensureWorkspaceRail(page);
    await expect(row.locator('.session-status-badge')).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+G');
    await expect(page.getByRole('dialog', { name: '面板跳转' }).locator('.session-status-badge')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1120, height: 820 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  } finally {
    await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`);
    await running.catch(() => undefined);
  }
});

test('失败也按是否查看区分，后台窗口不自动读掉结果，阅读状态同步到其他窗口', async ({ page, context, request }) => {
  await resetE2eState(request);
  const sessionId = 'status-background';
  await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: '后台会话' } });
  await page.goto('/');
  await openPanel(page, 'workspace');
  await ensureWorkspaceRail(page);
  const row = page.getByRole('complementary', { name: '工作区会话导航' }).locator(`[data-session-id="${sessionId}"]`).first();
  await expect(page.locator('.conversation-panel.active').getByLabel('Multivac 草稿')).toBeFocused();
  // 无头浏览器的多个页面可能同时报告可见；显式模拟后台标签页的可见性事件。
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const other = await context.newPage();
  await other.goto('/');
  await openPanel(other, 'workspace');
  await other.keyboard.press('ControlOrMeta+K');
  const palette = other.getByRole('dialog', { name: '跳到会话' });
  expect((await request.post(`${fakeApiRoot}/api/sessions/${sessionId}/turns`, { data: { commandId: 'failed-status-turn', assistantSessionId: sessionId, text: '失败场景：状态展示', contextRefs: [] } })).ok()).toBeTruthy();
  await expect(row.getByRole('img', { name: '会话状态：未查看' })).toBeVisible();
  // 第二个窗口停在跳转列表，不会自行清除未查看标记。
  await expect(palette.getByRole('img', { name: '会话状态：未查看' })).toBeVisible();
  await page.bringToFront();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.locator('.conversation-panel.active').getByLabel('Multivac 草稿').focus();
  await expect(row.locator('.session-status-badge')).toHaveCount(0);
  await expect(palette.locator('.session-status-badge')).toHaveCount(0);
});
