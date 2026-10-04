import { expect, test, type Locator } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

/** 逐帧及每次 DOM 更新检查，不能只比较点击前后的最终位置。 */
async function monitorRailPosition(scroll: Locator, target: Locator): Promise<() => Promise<void>> {
  const row = (await target.elementHandle())!;
  const observation = await scroll.evaluateHandle((element, row) => {
    const top = element.scrollTop;
    const y = row.getBoundingClientRect().y;
    const changes: { sameContainer: boolean; connectedRow: boolean; top: number; y: number }[] = [];
    const sample = () => {
      const current = document.querySelector('.workspace-shell .rail-scroll');
      const next = { sameContainer: current === element, connectedRow: row.isConnected,
        top: current?.scrollTop ?? -1, y: row.getBoundingClientRect().y };
      if (!next.sameContainer || !next.connectedRow || Math.abs(next.top - top) > 0.5 || Math.abs(next.y - y) > 0.5) changes.push(next);
    };
    let frame = 0;
    const observeFrame = () => { sample(); frame = requestAnimationFrame(observeFrame); };
    frame = requestAnimationFrame(observeFrame);
    const observer = new MutationObserver(sample);
    observer.observe(element.closest('.workspace-page')!, { childList: true, subtree: true, attributes: true });
    element.addEventListener('scroll', sample);
    return {
      stop: () => {
        sample();
        cancelAnimationFrame(frame);
        observer.disconnect();
        element.removeEventListener('scroll', sample);
        return changes;
      },
    };
  }, row);
  return async () => {
    // 最后再观察两次绘制，覆盖输入区聚焦及其后续布局。
    const changes = await observation.evaluate(async (observation) => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return observation.stop();
    });
    await observation.dispose();
    await row.dispose();
    expect(changes).toEqual([]);
  };
}

test('侧栏按可读空间停靠或浮层，布局与开合偏好各自保持', async ({ page, request }) => {
  await resetE2eState(request);
  for (let n = 1; n <= 4; n++) expect((await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId: `rail-${n}`, title: `阅读 ${n}` } })).ok()).toBe(true);
  await page.goto('/');
  await openPanel(page, 'workspace');
  const rail = page.getByRole('complementary', { name: '工作区会话导航' });
  await expect(rail).toBeVisible();
  await rail.getByRole('radio', { name: '并排 4 栏', includeHidden: true }).click();
  await expect(page.locator('.workspace-rail-wrap.overlay')).toBeVisible();
  await expect(page.locator('.conversation-panel')).toHaveCount(4);
  await page.screenshot({ path: 'test-results/workspace-rail-overlay.png' });
  await rail.locator('[data-workspace-id="default"]').getByRole('button', { name: '阅读 1', exact: true }).click();
  await expect(rail).toBeHidden();
  await page.keyboard.press('ControlOrMeta+B');
  await expect(rail).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(rail).toBeHidden();
  await page.keyboard.press('ControlOrMeta+B');
  await rail.getByRole('radio', { name: '聚焦：只看当前会话', includeHidden: true }).click();
  await expect(page.locator('.workspace-rail-wrap.overlay')).toHaveCount(0);
  await expect(rail).toBeVisible();
  await expect(page.locator('.conversation-panel')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+B');
  await expect(rail).toBeHidden();
  await page.reload();
  await openPanel(page, 'workspace');
  await expect(rail).toBeHidden();
  await page.getByRole('button', { name: '展开工作区侧栏' }).click();
  await expect(rail).toBeVisible();
  await rail.getByRole('radio', { name: '并排 3 栏', includeHidden: true }).click();
  await page.keyboard.press('ControlOrMeta+J');
  await expect(rail).toBeHidden();
  await page.keyboard.press('ControlOrMeta+B');
  await expect(page.locator('.workspace-rail-wrap.overlay')).toBeVisible();
  await page.locator('.conversation-panel').last().locator('h2').click();
  await expect(rail).toBeHidden();
});

for (const edge of ['顶部', '底部'] as const) {
  test(`点击侧边栏${edge}部分可见的会话时，导航保持原位`, async ({ page, request }) => {
    await resetE2eState(request);
    for (let n = 1; n <= 30; n++) {
      expect((await request.post(`${fakeApiRoot}/api/sessions`, {
        data: { sessionId: `rail-edge-${n}`, title: `边缘会话 ${n}` },
      })).ok()).toBe(true);
    }
    await page.goto('/');
    await openPanel(page, 'workspace');
    const rail = page.getByRole('complementary', { name: '工作区会话导航' });
    await rail.getByRole('radio', { name: '聚焦：只看当前会话', includeHidden: true }).click();
    const recent = rail.locator('[data-workspace-id="recent"]');
    await recent.getByRole('button', { name: '边缘会话 30', exact: true }).click();
    await expect(recent.locator('.rail-folder')).toHaveClass(/active/);
    const scroll = rail.locator('.rail-scroll');
    const id = `rail-edge-${edge === '顶部' ? 20 : 5}`;
    const position = await scroll.evaluate((element, { id, edge }) => {
      const target = element.querySelector<HTMLElement>(`.rail-group[data-workspace-id="recent"] [data-session-id="${id}"] .rail-session-open`)!;
      const viewport = element.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      element.scrollTop += edge === '顶部' ? rect.bottom - viewport.top - 12 : rect.top - viewport.bottom + 12;
      const actual = target.getBoundingClientRect();
      return { top: element.scrollTop, x: actual.left + actual.width / 2,
        y: edge === '顶部' ? viewport.top + 6 : viewport.bottom - 6 };
    }, { id, edge });
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(position.top);
    const checkPosition = await monitorRailPosition(scroll, recent.locator(`[data-session-id="${id}"] .rail-session-open`));
    // 直接点当前可见的一小段，避免 locator.click 自带的滚入视口动作掩盖真实点击行为。
    await page.mouse.move(position.x, position.y);
    await page.mouse.down();
    // 按下时就保持行位置并交出焦点，不能等 click 后恢复滚动来掩盖闪跳。
    await expect(recent.locator(`[data-session-id="${id}"] .rail-session-open`)).toBeFocused();
    expect(await scroll.evaluate((element) => element.scrollTop)).toBe(position.top);
    await page.mouse.up();
    await expect(page.locator('.conversation-panel.active h2')).toHaveText(`边缘会话 ${edge === '顶部' ? 20 : 5}`);
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(position.top);
    await checkPosition();
  });
}

test('切换会话与工作区保持侧边导航的垂直阅读位置', async ({ page, request }) => {
  await resetE2eState(request);
  for (let n = 1; n <= 30; n++) {
    expect((await request.post(`${fakeApiRoot}/api/sessions`, {
      data: { sessionId: `rail-scroll-${n}`, title: `滚动位置 ${n}` },
    })).ok()).toBe(true);
  }
  await page.goto('/');
  await openPanel(page, 'workspace');
  const rail = page.getByRole('complementary', { name: '工作区会话导航' });
  await expect(rail.getByRole('button', { name: '查看归档', includeHidden: true })).toHaveCount(0);
  await rail.getByRole('radio', { name: '聚焦：只看当前会话', includeHidden: true }).click();
  const scroll = rail.locator('.rail-scroll');
  const recent = rail.locator('[data-workspace-id="recent"]');
  const own = rail.locator('[data-workspace-id="default"]');
  await expect(recent.locator('.rail-item')).toHaveCount(30);
  await scroll.evaluate((element) => { element.scrollTop = 300; });
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(300);
  const recentTarget = recent.getByRole('button', { name: '滚动位置 20', exact: true });
  await expect(recentTarget).toBeInViewport();
  // 暂停目标工作区的现场读取，让检查覆盖加载中的实际绘制，而不是仅覆盖缓存切换。
  let releaseScene!: () => void;
  const sceneGate = new Promise<void>((resolve) => { releaseScene = resolve; });
  await page.route('**/api/workspaces/recent/scene', async (route) => {
    await sceneGate;
    await route.continue();
  });
  const checkRecentPosition = await monitorRailPosition(scroll, recentTarget);
  try {
    await recentTarget.click();
    await expect(page.getByText('正在读取工作区会话', { exact: true })).toBeVisible();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  } finally {
    releaseScene();
  }
  await expect(recent.locator('.rail-folder')).toHaveClass(/active/);
  await expect(page.locator('.conversation-panel.active h2')).toHaveText('滚动位置 20');
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(300);
  await checkRecentPosition();

  // 同一工作区的切换和会话草稿保存也保持导航位置。
  await recent.getByRole('button', { name: '滚动位置 19', exact: true }).click();
  await expect(page.locator('.conversation-panel.active h2')).toHaveText('滚动位置 19');
  await page.locator('.conversation-panel.active').getByLabel('Multivac 草稿').fill('保留导航阅读位置');
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(300);
  await page.keyboard.press('ControlOrMeta+B');
  await expect(rail).toBeHidden();
  await page.keyboard.press('ControlOrMeta+B');
  await expect(rail).toBeVisible();
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(300);

  // 从最近集合返回真实工作区，同样不能随着会话区重建而回到顶部。
  await scroll.evaluate((element) => { element.scrollTop = 1300; });
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(1300);
  const ownTarget = own.getByRole('button', { name: '滚动位置 20', exact: true });
  await expect(ownTarget).toBeInViewport();
  const targetTop = (await ownTarget.boundingBox())!.y;
  const checkOwnPosition = await monitorRailPosition(scroll, ownTarget);
  await ownTarget.click();
  await expect(own.locator('.rail-folder')).toHaveClass(/active/);
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(1300);
  await expect.poll(async () => (await ownTarget.boundingBox())!.y).toBe(targetTop);
  await checkOwnPosition();

  // 鼠标聚焦的修正不能破坏键盘激活会话。
  const keyboardTarget = own.getByRole('button', { name: '滚动位置 19', exact: true });
  await keyboardTarget.focus();
  const checkKeyboardPosition = await monitorRailPosition(scroll, keyboardTarget);
  await keyboardTarget.press('Enter');
  await expect(page.locator('.conversation-panel.active h2')).toHaveText('滚动位置 19');
  await checkKeyboardPosition();
});
