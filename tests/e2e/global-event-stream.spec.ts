import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { WorkspaceScene, WorkspaceSceneState } from '@multivac/contracts';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

/**
 * 每个窗口一条全局事件流：所有会话的正文流与工作台变更都经它送达，窗口按会话分发。
 * 正文增量经测试控制路由直接写入事件仓库（与真实正文事件同一条发布路径），可以指定会话、精确控制先后。
 */

const GLOBAL_SESSION_ID = 'global-coordinator';
const sidebar = (page: Page) => page.locator('.multivac-sidebar');

function panel(page: Page, title: string): Locator {
  return page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

/** 新会话没有历史，面板里唯一的助手行就是正文流。 */
function streamRow(page: Page, title: string): Locator {
  return panel(page, title).locator('article.chat-row.assistant');
}

/** 新建会话并放进默认工作区的并排栏位，打开工作区。返回会话 id（每次运行都不同）。 */
async function openWorkspace(page: Page, request: APIRequestContext, titles: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const title of titles) {
    const sessionId = `stream-${crypto.randomUUID()}`;
    const response = await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title } });
    expect(response.status()).toBe(201);
    ids.push(sessionId);
  }
  const current = await (await request.get(`${fakeApiRoot}/api/workspaces/default/scene`)).json() as WorkspaceScene;
  const scene: WorkspaceSceneState = {
    ...current.scene,
    parallelCount: Math.max(2, ids.length),
    slots: ids,
    focusedSessionId: ids[0]!,
    viewMode: 'parallel',
  };
  expect((await request.put(`${fakeApiRoot}/api/workspaces/default/scene`, { data: scene })).ok()).toBe(true);
  await page.goto('/');
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
  await openPanel(page, 'workspace');
  await expect(page.locator('.conversation-panel')).toHaveCount(ids.length);
  return ids;
}

async function openSidebar(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+J');
  await expect(sidebar(page)).toBeVisible();
}

/** 向会话推送一段正文增量（同一 messageId 累加为一条正文）。 */
async function publish(request: APIRequestContext, sessionId: string, delta: string): Promise<void> {
  const response = await request.post(`${fakeApiRoot}/api/__e2e/assistant/events/body`, {
    data: { sessionId, messageId: `assistant:stream:${sessionId}`, delta },
  });
  expect(response.ok()).toBe(true);
}

async function disconnectEventStreams(request: APIRequestContext): Promise<number> {
  const response = await request.post(`${fakeApiRoot}/api/__e2e/events/disconnect`);
  expect(response.ok()).toBe(true);
  return (await response.json() as { disconnected: number }).disconnected;
}

test.beforeEach(async ({ request }) => {
  await resetE2eState(request);
});

test('两个会话同时流式输出时断开全局事件流：按游标续传，两边正文不丢、不重复', async ({ page, request }) => {
  const connections: number[] = [];
  page.on('request', (event) => {
    const url = new URL(event.url());
    if (url.pathname === '/api/events') connections.push(Number(url.searchParams.get('after')));
  });
  const [a, b] = await openWorkspace(page, request, ['续传甲', '续传乙']);
  const expected = new Map([[a!, ''], [b!, '']]);
  const round = async (index: number) => {
    for (const [sessionId, label] of [[a!, '甲'], [b!, '乙']] as const) {
      const delta = `${label}${index}；`;
      await publish(request, sessionId, delta);
      expected.set(sessionId, expected.get(sessionId) + delta);
    }
  };

  for (let index = 1; index <= 4; index += 1) await round(index);
  await expect(streamRow(page, '续传甲').locator('p')).toHaveText(expected.get(a!)!);
  await expect(streamRow(page, '续传乙').locator('p')).toHaveText(expected.get(b!)!);
  expect(connections).toHaveLength(1);

  // 服务端断开这个窗口的全局事件流，断开与重连之间继续交替输出。
  expect(await disconnectEventStreams(request)).toBeGreaterThanOrEqual(1);
  for (let index = 5; index <= 8; index += 1) await round(index);
  await expect.poll(() => connections.length).toBe(2);
  for (let index = 9; index <= 10; index += 1) await round(index);

  // 与没有断开时的最终内容一致：每条正文一行，内容按顺序完整。
  for (const [title, sessionId] of [['续传甲', a!], ['续传乙', b!]] as const) {
    await expect(streamRow(page, title)).toHaveCount(1);
    await expect(streamRow(page, title).locator('p')).toHaveText(expected.get(sessionId)!);
  }
  // 续传从最后处理的全局游标开始，不是从头回放。
  expect(connections[0]).toBeGreaterThan(0);
  expect(connections[1]).toBeGreaterThan(connections[0]!);

  // 刷新后按服务端快照呈现的正文与流式看到的一致。
  await page.reload();
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
  await openPanel(page, 'workspace');
  await expect(page.locator('.conversation-panel')).toHaveCount(2);
  for (const [title, sessionId] of [['续传甲', a!], ['续传乙', b!]] as const) {
    await expect(streamRow(page, title)).toHaveCount(1);
    await expect(streamRow(page, title).locator('p')).toHaveText(expected.get(sessionId)!);
  }
});

test('全局事件流游标过期时，所有已打开的会话重读快照后恢复，正文不丢、不重复', async ({ page, request }) => {
  let expireNext = false;
  let expiredResponses = 0;
  const resumed: number[] = [];
  await page.route('**/api/events?*', async (route) => {
    if (!expireNext) {
      if (expiredResponses > 0) resumed.push(Number(new URL(route.request().url()).searchParams.get('after')));
      return route.continue();
    }
    expireNext = false;
    expiredResponses += 1;
    return route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'EVENT_CURSOR_EXPIRED', message: '回归测试：全局游标已过期。' } }),
    });
  });
  let counting = false;
  const snapshotReads = new Map<string, number>();
  page.on('request', (event) => {
    const path = new URL(event.url()).pathname;
    if (counting && path.endsWith('/session')) snapshotReads.set(path, (snapshotReads.get(path) ?? 0) + 1);
  });

  const [a, b] = await openWorkspace(page, request, ['过期甲', '过期乙']);
  await openSidebar(page);
  const sessions = [[a!, '甲'], [b!, '乙'], [GLOBAL_SESSION_ID, '全']] as const;
  const expected = new Map<string, string>(sessions.map(([sessionId]) => [sessionId, '']));
  const round = async (index: number) => {
    for (const [sessionId, label] of sessions) {
      const delta = `${label}${index}；`;
      await publish(request, sessionId, delta);
      expected.set(sessionId, expected.get(sessionId) + delta);
    }
  };
  const globalRow = () => sidebar(page).locator('article.chat-row.assistant').filter({ hasText: '全1；' });

  for (let index = 1; index <= 3; index += 1) await round(index);
  await expect(streamRow(page, '过期乙').locator('p')).toHaveText(expected.get(b!)!);
  await expect(globalRow().locator('p')).toHaveText(expected.get(GLOBAL_SESSION_ID)!);

  // 断开后重连时游标过期；过期到重新起流期间继续输出。
  expireNext = true;
  counting = true;
  expect(await disconnectEventStreams(request)).toBeGreaterThanOrEqual(1);
  await expect.poll(() => expiredResponses).toBe(1);
  for (let index = 4; index <= 6; index += 1) await round(index);
  await expect.poll(() => resumed.length).toBeGreaterThan(0);
  for (let index = 7; index <= 8; index += 1) await round(index);

  await expect(streamRow(page, '过期甲')).toHaveCount(1);
  await expect(streamRow(page, '过期甲').locator('p')).toHaveText(expected.get(a!)!);
  await expect(streamRow(page, '过期乙')).toHaveCount(1);
  await expect(streamRow(page, '过期乙').locator('p')).toHaveText(expected.get(b!)!);
  await expect(globalRow()).toHaveCount(1);
  await expect(globalRow().locator('p')).toHaveText(expected.get(GLOBAL_SESSION_ID)!);

  // 三个会话各自重读了快照；只过期一次，之后从新快照的游标重新起流一次。
  for (const path of [`/api/sessions/${a}/session`, `/api/sessions/${b}/session`, '/api/assistant/session']) {
    expect(snapshotReads.get(path) ?? 0).toBeGreaterThan(0);
  }
  expect(expiredResponses).toBe(1);
  expect(resumed).toHaveLength(1);
  expect(resumed[0]).toBeGreaterThan(0);
});

test('4 个面板同时流式输出时，保存草稿与发送消息及时完成', async ({ page, request }) => {
  const titles = ['并发一', '并发二', '并发三', '并发四'];
  const ids = await openWorkspace(page, request, titles);
  await openSidebar(page);

  const started = new Map<object, number>();
  const durations = new Map<string, number>();
  page.on('request', (event) => started.set(event, Date.now()));
  page.on('requestfinished', (event) => {
    const url = new URL(event.url());
    const key = `${event.method()} ${url.pathname}`;
    if (event.method() !== 'GET' && !durations.has(key)) durations.set(key, Date.now() - started.get(event)!);
  });

  // 4 个会话持续交替输出正文，直到测试停下（失败时同样停下，不拖住下一个用例）。
  let pumping = true;
  let rounds = 0;
  const pump = (async () => {
    while (pumping) {
      rounds += 1;
      const delta = `${rounds}，`;
      await Promise.all(ids.map((sessionId) => publish(request, sessionId, delta)));
    }
  })();
  // 草稿按全局会话保存、重置不清空：每次运行写不同的内容，保证真的发出保存。
  const draft = `输出期间写的草稿 ${crypto.randomUUID()}`;
  try {
    for (const title of titles) await expect(streamRow(page, title).locator('p')).toContainText('3，');

    // 保存：侧栏草稿（防抖后 PUT page-state）。
    await sidebar(page).getByLabel('Multivac 草稿').fill(draft);
    await expect.poll(() => durations.has('PUT /api/assistant/page-state')).toBe(true);
    // 发送：第一栏（当前会话）发出一条消息。
    const current = panel(page, '并发一');
    await current.getByLabel('Multivac 草稿').fill('输出期间发出的消息');
    await current.getByLabel('Multivac 草稿').press('Enter');
    await expect(current.locator('article.chat-row.user').filter({ hasText: '输出期间发出的消息' })).toHaveCount(1);
    await expect.poll(() => durations.has(`POST /api/sessions/${ids[0]}/turns`)).toBe(true);
  } finally {
    pumping = false;
    await pump;
  }

  // 输出期间各栏的正文完整、按序（发送消息的第一栏多了一轮回复，只核对另外三栏）。
  const expectedText = Array.from({ length: rounds }, (_, index) => `${index + 1}，`).join('');
  for (const title of titles.slice(1)) {
    await expect(streamRow(page, title).locator('p')).toHaveText(expectedText);
  }
  // 请求不排队：保存在 1 秒内完成；发送包含 Fake 约 650ms 的处理，在 3 秒内完成。
  expect(durations.get('PUT /api/assistant/page-state')).toBeLessThan(1_000);
  expect(durations.get(`POST /api/sessions/${ids[0]}/turns`)).toBeLessThan(3_000);
});
