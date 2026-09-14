import { expect, test, type Page } from '@playwright/test';
import { ASSISTANT_DRAFT_MAX_UTF8_BYTES } from '@multivac/contracts';

const reportRoot = '.report/in-progress/2026-09-14-dev-155-assistant-session-view';

async function scrollToReadingAnchor(page: Page, entryId: string) {
  await page.locator(`[data-entry-id="${entryId}"]`).evaluate((element) => {
    const container = element.closest('.message-scroll')!;
    container.scrollTop += element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  return page.locator('.message-scroll').evaluate((container) => {
    const containerTop = container.getBoundingClientRect().top;
    const anchor = [...container.querySelectorAll<HTMLElement>('[data-entry-id]')]
      .find((element) => element.getBoundingClientRect().bottom > containerTop + 1);
    return {
      anchorEntryId: anchor?.dataset.entryId ?? null,
      anchorOffsetPx: anchor ? anchor.getBoundingClientRect().top - containerTop : 0,
    };
  });
}

test.beforeEach(async ({ request }) => {
  const response = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
  const current = await response.json() as { revision: number };
  await request.put('http://127.0.0.1:4317/api/assistant/page-state', {
    data: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, revision: current.revision },
  });
});

test('默认进入协调助手且 composer 不可发送', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('协调助手', { exact: true }).first()).toBeVisible();
  await expect(page.locator('[data-entry-id="entry-072"]')).toBeVisible();
  await expect(page.getByLabel('发送不可用')).toBeDisabled();
  await expect(page.locator('aside, nav')).toHaveCount(0);
  await expect(page.getByLabel('协调助手草稿')).toBeEditable();

  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(0);
  expect(overflow.body).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${reportRoot}/qa-assistant-desktop.png`, fullPage: true });
});

test('加载更早消息保持视口并恢复草稿和阅读锚点', async ({ page, request }) => {
  await page.goto('/');
  const loadEarlierButton = page.getByRole('button', { name: '加载更早消息' });
  await loadEarlierButton.scrollIntoViewIfNeeded();
  const preserved = page.locator('[data-entry-id="entry-043"]');
  await expect(preserved).toBeVisible();
  const beforeOffset = await preserved.evaluate((element) => {
    const container = element.closest('.message-scroll')!;
    return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });

  await loadEarlierButton.click();
  await expect(page.locator('[data-entry-id="entry-013"]')).toHaveCount(1);
  const afterOffset = await preserved.evaluate((element) => {
    const container = element.closest('.message-scroll')!;
    return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });
  expect(Math.abs(afterOffset - beforeOffset)).toBeLessThan(3);

  await page.locator('[data-entry-id="entry-020"]').scrollIntoViewIfNeeded();
  await page.getByLabel('协调助手草稿').fill('离开页面后仍需恢复的草稿');
  await expect.poll(async () => {
    const response = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
    return await response.json() as { draft: string; anchorEntryId: string | null; anchorOffsetPx: number };
  }).toMatchObject({ draft: '离开页面后仍需恢复的草稿' });

  const stateResponse = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
  const savedState = await stateResponse.json() as {
    anchorEntryId: string;
    anchorOffsetPx: number;
  };
  expect(savedState.anchorEntryId).toBeTruthy();
  const savedAnchor = page.locator(`[data-entry-id="${savedState.anchorEntryId}"]`);
  const savedOffset = await savedAnchor.evaluate((element) => {
    const container = element.closest('.message-scroll')!;
    return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });

  await page.goto('about:blank');
  await page.goBack();

  await expect(page.getByLabel('协调助手草稿')).toHaveValue('离开页面后仍需恢复的草稿');
  const restoredAnchor = page.locator(`[data-entry-id="${savedState.anchorEntryId}"]`);
  await expect(restoredAnchor).toHaveCount(1);
  const restoredOffset = await restoredAnchor.evaluate((element) => {
    const container = element.closest('.message-scroll')!;
    return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });
  expect(Math.abs(restoredOffset - savedOffset)).toBeLessThan(4);
});

test('加载更早消息失败后可原位重试且保留页面现场', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let loadMoreAttempts = 0;
  await page.route('**/api/assistant/session?*', (route) => {
    const requestUrl = new URL(route.request().url());
    if (!requestUrl.searchParams.has('before')) return route.continue();
    loadMoreAttempts += 1;
    if (loadMoreAttempts > 1) return route.continue();
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'ASSISTANT_SESSION_UNAVAILABLE', message: '测试加载更早消息失败。' },
      }),
    });
  });

  await page.goto('/');
  await page.getByLabel('协调助手草稿').fill('分页失败后仍保留的草稿');
  const loadEarlierButton = page.getByRole('button', { name: '加载更早消息' });
  await loadEarlierButton.scrollIntoViewIfNeeded();
  const preserved = page.locator('[data-entry-id="entry-043"]');
  await expect(preserved).toBeVisible();
  const beforeOffset = await preserved.evaluate((element) => {
    const container = element.closest('.message-scroll')!;
    return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });

  await loadEarlierButton.click();
  await expect(page.getByText('更早消息加载失败')).toBeVisible();
  await expect(page.getByText('测试加载更早消息失败。')).toBeVisible();
  await expect(page.getByRole('button', { name: '重试加载更早消息' })).toBeVisible();
  await expect(page.locator('[data-entry-id="entry-072"]')).toHaveCount(1);
  await expect(page.getByLabel('协调助手草稿')).toHaveValue('分页失败后仍保留的草稿');
  const failureOffset = await preserved.evaluate((element) => {
    const container = element.closest('.message-scroll')!;
    return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });
  expect(Math.abs(failureOffset - beforeOffset)).toBeLessThan(3);
  await page.screenshot({ path: `${reportRoot}/qa-assistant-load-earlier-error-mobile.png`, fullPage: true });

  await page.getByRole('button', { name: '重试加载更早消息' }).click();
  await expect(page.locator('[data-entry-id="entry-013"]')).toHaveCount(1);
  await expect(page.getByText('更早消息加载失败')).toHaveCount(0);
  await expect(page.getByLabel('协调助手草稿')).toHaveValue('分页失败后仍保留的草稿');
  const afterOffset = await preserved.evaluate((element) => {
    const container = element.closest('.message-scroll')!;
    return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });
  expect(Math.abs(afterOffset - beforeOffset)).toBeLessThan(3);
  expect(loadMoreAttempts).toBe(2);
});

test('StrictMode 初始化乱序完成不会覆盖新草稿、已加载消息和滚动现场', async ({ page }) => {
  let releaseOldRequest!: () => void;
  const oldRequestGate = new Promise<void>((resolve) => {
    releaseOldRequest = resolve;
  });
  let sessionRequestCount = 0;
  let stateRequestCount = 0;

  await page.route('**/api/assistant/page-state', (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    stateRequestCount += 1;
    if (stateRequestCount !== 1) return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        draft: '迟到请求中的旧草稿',
        anchorEntryId: null,
        anchorOffsetPx: 0,
        revision: 0,
      }),
    });
  });
  await page.route('**/api/assistant/session?*', async (route) => {
    sessionRequestCount += 1;
    if (sessionRequestCount !== 1) return route.continue();
    await oldRequestGate;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        assistantSessionId: 'global-coordinator',
        piSessionId: 'pi-stale',
        messages: [{
          id: 'pi-stale:entry-stale',
          piSessionId: 'pi-stale',
          piEntryId: 'entry-stale',
          role: 'assistant',
          text: '迟到请求中的旧消息',
          createdAt: '2026-09-14T08:00:00.000Z',
        }],
        hasMore: false,
        nextBefore: null,
        cursor: 'pi-stale:entry-stale',
      }),
    });
  });

  await page.goto('/');
  await expect(page.locator('[data-entry-id="entry-072"]')).toBeVisible();
  const preserved = page.locator('[data-entry-id="entry-043"]');
  await page.getByRole('button', { name: '加载更早消息' }).click();
  await expect(page.locator('[data-entry-id="entry-013"]')).toHaveCount(1);
  await page.getByLabel('协调助手草稿').fill('用户在新页面现场输入的草稿');
  const beforeOffset = await preserved.evaluate((element) => {
    const container = element.closest('.message-scroll')!;
    return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });

  releaseOldRequest();
  await page.waitForTimeout(150);

  await expect(page.getByLabel('协调助手草稿')).toHaveValue('用户在新页面现场输入的草稿');
  await expect(page.locator('[data-entry-id="entry-013"]')).toHaveCount(1);
  await expect(page.locator('[data-entry-id="entry-stale"]')).toHaveCount(0);
  const afterOffset = await preserved.evaluate((element) => {
    const container = element.closest('.message-scroll')!;
    return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });
  expect(Math.abs(afterOffset - beforeOffset)).toBeLessThan(3);
  expect(sessionRequestCount).toBeGreaterThanOrEqual(2);
  expect(stateRequestCount).toBeGreaterThanOrEqual(2);
});

test('revision 冲突补读失败后继续编辑仍可保存且队列不会中毒', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('[data-entry-id="entry-072"]')).toBeVisible();

  const currentResponse = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
  const current = await currentResponse.json() as { revision: number };
  await request.put('http://127.0.0.1:4317/api/assistant/page-state', {
    data: {
      draft: '其他页面先保存的草稿',
      anchorEntryId: null,
      anchorOffsetPx: 0,
      revision: current.revision,
    },
  });

  let failConflictRefresh = true;
  await page.route('**/api/assistant/page-state', (route) => {
    if (route.request().method() !== 'GET' || !failConflictRefresh) return route.continue();
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'ASSISTANT_SESSION_UNAVAILABLE', message: '测试冲突补读失败。' },
      }),
    });
  });

  await page.getByLabel('协调助手草稿').fill('本页面冲突后保留的草稿');
  await expect(page.getByText(/保存版本冲突，且最新版本读取失败/)).toBeVisible();
  await expect(page.getByRole('button', { name: '重试保存' })).toBeVisible();
  await expect(page.getByLabel('协调助手草稿')).toHaveValue('本页面冲突后保留的草稿');

  failConflictRefresh = false;
  await page.getByLabel('协调助手草稿').fill('网络恢复后的新草稿');
  await expect(page.getByText('草稿已保存')).toBeVisible();
  await expect.poll(async () => {
    const response = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
    return await response.json() as { draft: string };
  }).toMatchObject({ draft: '网络恢复后的新草稿' });
});

test('在途 PUT 响应延迟时退出 flush 仍按最新 revision 串行保存', async ({ page, request }) => {
  let releaseFirstResponse!: () => void;
  const firstResponseGate = new Promise<void>((resolve) => {
    releaseFirstResponse = resolve;
  });
  let markFirstCommitted!: () => void;
  const firstCommitted = new Promise<void>((resolve) => {
    markFirstCommitted = resolve;
  });
  const putBodies: Array<{
    draft: string;
    anchorEntryId: string | null;
    anchorOffsetPx: number;
    revision: number;
  }> = [];

  await page.route('**/api/assistant/page-state', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    putBodies.push(route.request().postDataJSON() as {
      draft: string;
      anchorEntryId: string | null;
      anchorOffsetPx: number;
      revision: number;
    });
    if (putBodies.length !== 1) return route.continue();

    const response = await route.fetch();
    markFirstCommitted();
    await firstResponseGate;
    return route.fulfill({ response });
  });

  await page.goto('/');
  await page.getByLabel('协调助手草稿').fill('已落盘但响应仍在途的草稿');
  await firstCommitted;

  await page.locator('[data-entry-id="entry-050"]').scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await page.getByLabel('协调助手草稿').fill('退出时必须最终保存的草稿');
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
  });
  await page.waitForTimeout(150);
  expect(putBodies).toHaveLength(1);

  releaseFirstResponse();
  await expect.poll(async () => {
    const response = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
    return await response.json() as { draft: string; anchorEntryId: string | null };
  }).toMatchObject({ draft: '退出时必须最终保存的草稿' });
  const finalStateResponse = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
  const finalState = await finalStateResponse.json() as { anchorEntryId: string | null };

  expect(putBodies).toHaveLength(2);
  expect(putBodies[1]).toMatchObject({
    draft: '退出时必须最终保存的草稿',
    revision: putBodies[0].revision + 1,
  });
  expect(putBodies[1].anchorEntryId).toBeTruthy();
  expect(putBodies[1].anchorEntryId).not.toBe(putBodies[0].anchorEntryId);
  expect(finalState.anchorEntryId).toBe(putBodies[1].anchorEntryId);
});

test('revision 冲突补读成功后滚动和隐藏页面不会自动覆盖，显式重试保存最新锚点', async ({ page, request }) => {
  const pagePutBodies: Array<{
    draft: string;
    anchorEntryId: string | null;
    anchorOffsetPx: number;
    revision: number;
  }> = [];
  await page.route('**/api/assistant/page-state', (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    pagePutBodies.push(route.request().postDataJSON() as typeof pagePutBodies[number]);
    return route.continue();
  });

  await page.goto('/');
  await expect(page.locator('[data-entry-id="entry-072"]')).toBeVisible();
  const currentResponse = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
  const current = await currentResponse.json() as { revision: number };
  await request.put('http://127.0.0.1:4317/api/assistant/page-state', {
    data: {
      draft: '其他页面保留的远端草稿',
      anchorEntryId: null,
      anchorOffsetPx: 0,
      revision: current.revision,
    },
  });

  const draft = page.getByLabel('协调助手草稿');
  await draft.fill('冲突后等待显式重试的本地草稿');
  await expect(page.getByText('其他页面更新了保存版本；当前草稿已保留，请重试保存。')).toBeVisible();
  await expect(draft).toHaveValue('冲突后等待显式重试的本地草稿');
  expect(pagePutBodies).toHaveLength(1);

  const localAnchor = await scrollToReadingAnchor(page, 'entry-050');
  await page.waitForTimeout(600);
  expect(pagePutBodies).toHaveLength(1);
  await expect(page.getByText('其他页面更新了保存版本；当前草稿已保留，请重试保存。')).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
  });
  await page.waitForTimeout(600);
  expect(pagePutBodies).toHaveLength(1);
  const hiddenStateResponse = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
  await expect(hiddenStateResponse.json()).resolves.toMatchObject({ draft: '其他页面保留的远端草稿' });

  await page.getByRole('button', { name: '重试保存' }).click();
  await expect(page.getByText('草稿已保存')).toBeVisible();
  await expect.poll(async () => {
    const response = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
    return await response.json() as { draft: string };
  }).toMatchObject({ draft: '冲突后等待显式重试的本地草稿' });
  expect(pagePutBodies).toHaveLength(2);
  expect(pagePutBodies[1]).toMatchObject(localAnchor);
});

test('revision 冲突补读失败后滚动和隐藏页面不会自动 PUT，新编辑保存最新锚点', async ({ page, request }) => {
  let failConflictRefresh = false;
  const pagePutBodies: Array<{
    draft: string;
    anchorEntryId: string | null;
    anchorOffsetPx: number;
    revision: number;
  }> = [];
  await page.route('**/api/assistant/page-state', (route) => {
    if (route.request().method() === 'PUT') {
      pagePutBodies.push(route.request().postDataJSON() as typeof pagePutBodies[number]);
      return route.continue();
    }
    if (!failConflictRefresh) return route.continue();
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'ASSISTANT_SESSION_UNAVAILABLE', message: '测试冲突补读失败。' },
      }),
    });
  });

  await page.goto('/');
  await expect(page.locator('[data-entry-id="entry-072"]')).toBeVisible();
  const currentResponse = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
  const current = await currentResponse.json() as { revision: number };
  await request.put('http://127.0.0.1:4317/api/assistant/page-state', {
    data: {
      draft: '补读失败前的远端草稿',
      anchorEntryId: null,
      anchorOffsetPx: 0,
      revision: current.revision,
    },
  });
  failConflictRefresh = true;

  const draft = page.getByLabel('协调助手草稿');
  await draft.fill('补读失败后保留的本地草稿');
  await expect(page.getByText(/保存版本冲突，且最新版本读取失败/)).toBeVisible();
  await expect(draft).toHaveValue('补读失败后保留的本地草稿');
  expect(pagePutBodies).toHaveLength(1);

  const localAnchor = await scrollToReadingAnchor(page, 'entry-050');
  await page.waitForTimeout(600);
  expect(pagePutBodies).toHaveLength(1);
  await expect(page.getByText(/保存版本冲突，且最新版本读取失败/)).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
  });
  await page.waitForTimeout(600);
  expect(pagePutBodies).toHaveLength(1);

  failConflictRefresh = false;
  await draft.fill('冲突后新编辑授权保存的最终草稿');
  await expect(page.getByText('草稿已保存')).toBeVisible();
  await expect.poll(async () => {
    const response = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
    return await response.json() as { draft: string };
  }).toMatchObject({ draft: '冲突后新编辑授权保存的最终草稿' });
  expect(pagePutBodies).toHaveLength(2);
  expect(pagePutBodies[1]).toMatchObject(localAnchor);
});

for (const refreshResult of ['成功', '失败'] as const) {
  test(`revision 冲突补读${refreshResult}后仅滚动并实际卸载不会覆盖远端草稿`, async ({ page, request }) => {
    let failConflictRefresh = false;
    const pagePutBodies: Array<{ draft: string; revision: number }> = [];
    await page.route('**/api/assistant/page-state', (route) => {
      if (route.request().method() === 'PUT') {
        pagePutBodies.push(route.request().postDataJSON() as { draft: string; revision: number });
        return route.continue();
      }
      if (!failConflictRefresh) return route.continue();
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'ASSISTANT_SESSION_UNAVAILABLE', message: '测试冲突补读失败。' },
        }),
      });
    });

    await page.goto('/unmount-harness.html');
    await expect(page.locator('[data-entry-id="entry-072"]')).toBeVisible();
    const currentResponse = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
    const current = await currentResponse.json() as { revision: number };
    const remoteDraft = `补读${refreshResult}时其他页面保留的远端草稿`;
    await request.put('http://127.0.0.1:4317/api/assistant/page-state', {
      data: {
        draft: remoteDraft,
        anchorEntryId: null,
        anchorOffsetPx: 0,
        revision: current.revision,
      },
    });
    failConflictRefresh = refreshResult === '失败';

    await page.getByLabel('协调助手草稿').fill(`补读${refreshResult}后等待处理的本地草稿`);
    await expect(page.getByRole('button', { name: '重试保存' })).toBeVisible();
    expect(pagePutBodies).toHaveLength(1);

    await scrollToReadingAnchor(page, 'entry-050');
    await page.waitForTimeout(600);
    expect(pagePutBodies).toHaveLength(1);

    await page.evaluate(() => {
      (window as Window & { unmountAssistant: () => void }).unmountAssistant();
    });
    await page.waitForTimeout(600);
    expect(pagePutBodies).toHaveLength(1);
    const remoteStateResponse = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
    await expect(remoteStateResponse.json()).resolves.toMatchObject({ draft: remoteDraft });
  });
}

test('保存 400、500、网络失败和超限草稿均可见、可重试且保留正文', async ({ page, request }) => {
  let saveAttempt = 0;
  let oversizedAttempt = 0;
  await page.route('**/api/assistant/page-state', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    const body = route.request().postDataJSON() as { draft?: string };
    if (body.draft && new TextEncoder().encode(body.draft).byteLength > ASSISTANT_DRAFT_MAX_UTF8_BYTES) {
      oversizedAttempt += 1;
      return route.continue();
    }
    if (!body.draft?.startsWith('失败链路')) return route.continue();
    saveAttempt += 1;
    if (saveAttempt === 1) {
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INVALID_REQUEST', message: '测试 400 保存失败。' } }),
      });
    }
    if (saveAttempt === 2) {
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '测试 500 保存失败。' } }),
      });
    }
    if (saveAttempt === 3) return route.abort('failed');
    return route.continue();
  });

  await page.goto('/');
  const draft = page.getByLabel('协调助手草稿');
  await draft.fill('失败链路中的草稿正文');
  await expect(page.getByText('草稿保存失败：测试 400 保存失败。')).toBeVisible();
  await expect(draft).toHaveValue('失败链路中的草稿正文');

  await page.getByRole('button', { name: '重试保存' }).click();
  await expect(page.getByText('草稿保存失败：测试 500 保存失败。')).toBeVisible();
  await expect(draft).toHaveValue('失败链路中的草稿正文');

  await page.getByRole('button', { name: '重试保存' }).click();
  await expect(page.getByText('草稿保存失败：网络连接不可用，请重试。')).toBeVisible();
  await expect(draft).toHaveValue('失败链路中的草稿正文');

  await page.getByRole('button', { name: '重试保存' }).click();
  await expect(page.getByText('草稿已保存')).toBeVisible();
  await expect.poll(async () => {
    const response = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
    return await response.json() as { draft: string };
  }).toMatchObject({ draft: '失败链路中的草稿正文' });

  const oversizedAscii = 'x'.repeat(ASSISTANT_DRAFT_MAX_UTF8_BYTES + 1);
  await draft.fill(oversizedAscii);
  await expect(page.getByText(/草稿超过 12 KB 保存上限/)).toBeVisible();
  expect(await draft.inputValue()).toBe(oversizedAscii);

  const oversizedChinese = '中'.repeat(Math.floor(ASSISTANT_DRAFT_MAX_UTF8_BYTES / 3) + 1);
  await draft.fill(oversizedChinese);
  await expect(page.getByText(/草稿超过 12 KB 保存上限/)).toBeVisible();
  expect(await draft.inputValue()).toBe(oversizedChinese);
  expect(oversizedAttempt).toBe(0);
  await page.screenshot({ path: `${reportRoot}/qa-assistant-save-error.png`, fullPage: true });
});

test('debounce 到期前卸载会尽力 flush 草稿和阅读现场', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('[data-entry-id="entry-072"]')).toBeVisible();
  await page.locator('[data-entry-id="entry-050"]').scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await page.getByLabel('协调助手草稿').fill('卸载前立即 flush 的草稿');
  await page.goto('about:blank');

  await expect.poll(async () => {
    const response = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
    return await response.json() as { draft: string; anchorEntryId: string | null };
  }).toMatchObject({ draft: '卸载前立即 flush 的草稿' });
  const stateResponse = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
  const state = await stateResponse.json() as { anchorEntryId: string | null };
  expect(state.anchorEntryId).toBeTruthy();

  await page.goBack();
  await expect(page.getByLabel('协调助手草稿')).toHaveValue('卸载前立即 flush 的草稿');
  await expect(page.locator(`[data-entry-id="${state.anchorEntryId}"]`)).toHaveCount(1);
});

test('展示 loading、empty、error 并可重试', async ({ page }) => {
  await page.route('**/api/assistant/session?*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  await page.goto('/');
  await expect(page.getByText('正在恢复会话')).toBeVisible();
  await expect(page.locator('[data-entry-id="entry-072"]')).toBeVisible();

  await page.unroute('**/api/assistant/session?*');
  await page.route('**/api/assistant/session?*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      assistantSessionId: 'global-coordinator',
      piSessionId: 'pi-empty',
      messages: [],
      hasMore: false,
      nextBefore: null,
      cursor: 'pi-empty:empty',
    }),
  }));
  await page.reload();
  await expect(page.getByText('会话还没有消息')).toBeVisible();

  await page.unroute('**/api/assistant/session?*');
  let failing = true;
  await page.route('**/api/assistant/session?*', (route) => {
    if (!failing) return route.continue();
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'ASSISTANT_SESSION_RECOVERY_FAILED', message: '测试恢复失败。' },
      }),
    });
  });
  await page.reload();
  await expect(page.getByText('会话暂时不可用')).toBeVisible();
  await expect(page.getByText('测试恢复失败。')).toBeVisible();
  failing = false;
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.locator('[data-entry-id="entry-072"]')).toBeVisible();
});

test('移动端布局无横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('[data-entry-id="entry-072"]')).toBeVisible();
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${reportRoot}/qa-assistant-mobile.png`, fullPage: true });
});
