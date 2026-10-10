import { expect, test, type Page } from '@playwright/test';
import type { AssistantSessionPageResponse } from '@multivac/contracts';
import { fakeApiRoot, resetE2eState } from './test-state.js';

// 此组隔离验证精简React树，身份/登录响应由浏览器路由替身提供；
// 鉴权、真实cookie及服务端过滤另由remote-access-http.test.ts验证，不能混为真实远程网络验收。
async function remoteIdentity(page: Page) {
  let authenticated = false;
  await page.route('**/api/access', route => route.fulfill({ json: { kind: 'remote', authenticated, loginEnabled: true } }));
  await page.route('**/api/access/login', route => {
    if (route.request().postDataJSON()?.token !== 'browser-fixture-token') return route.fulfill({ status: 401, json: { error: { code: 'LOGIN_FAILED', message: '错误token' } } });
    authenticated = true; return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/access/logout', route => { authenticated = false; return route.fulfill({ json: { ok: true } }); });
  return { expire: () => { authenticated = false; } };
}
async function login(page: Page) {
  await page.getByLabel('访问 token').fill('browser-fixture-token');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
}
function allowedClientPath(path: string): boolean {
  return path === '/api/access' || path.startsWith('/api/access/') || path === '/api/events' || path.startsWith('/api/assistant/') || path.startsWith('/api/sessions/global-coordinator/images');
}

test.beforeEach(async ({ request }) => {
  await resetE2eState(request);
  const state = await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json() as { revision: number };
  await request.put(`${fakeApiRoot}/api/assistant/page-state`, { data: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: state.revision } });
});

test('390px手机精简入口：错误token、历史、发送流式、停止、退出，无范围外初始化', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const paths: string[] = []; const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { const path = new URL(req.url()).pathname; if (path.startsWith('/api/')) paths.push(path); });
  // 同时模拟LAN HTTP没有randomUUID，getRandomValues仍由真实浏览器实现。
  await page.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined }));
  await remoteIdentity(page); await page.goto('/');
  await expect(page.getByRole('heading', { name: '连接 Multivac' })).toBeVisible();
  expect(paths.every(path => path === '/api/access')).toBe(true);
  await page.getByLabel('访问 token').fill('wrong'); await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('访问 token 不正确'); await expect(page.getByLabel('访问 token')).toHaveValue('');
  await login(page); await expect(page.locator('article.chat-row').first()).toBeVisible();
  await expect(page.getByRole('complementary', { name: '管理导航' })).toHaveCount(0);
  await expect(page.locator('.workspace-page')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Inbox' })).toHaveCount(0);
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm-streaming`, { data: { terminalHistory: 'persist' } })).ok()).toBe(true);
  try {
    await page.getByLabel('Multivac 草稿').fill('手机远程流式停止'); await page.getByLabel('发送消息').click();
    expect((await request.get(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`)).ok()).toBe(true);
    const snapshot = await (await request.get(`${fakeApiRoot}/api/assistant/session`)).json() as AssistantSessionPageResponse;
    const stream = snapshot.streamingMessages![0]!;
    await expect(page.locator('article.chat-row.assistant').filter({ hasText: stream.text })).toBeVisible();
    await page.getByRole('button', { name: '取消当前处理' }).click();
    await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`);
    await expect(page.getByRole('button', { name: '取消当前处理' })).toHaveCount(0);
    await page.getByRole('button', { name: '退出登录' }).click(); await expect(page.getByLabel('访问 token')).toBeVisible();
    expect(paths.filter(path => !allowedClientPath(path))).toEqual([]); expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`); }
});

test('登录失效返回登录页，重登保留未发送草稿，未自动发送', async ({ page }) => {
  const identity = await remoteIdentity(page); const sends: string[] = [];
  page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/assistant/turns') sends.push(req.postData() ?? ''); });
  await page.goto('/'); await login(page);
  await page.getByLabel('Multivac 草稿').fill('失效时尚未发出的草稿');
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('multivac.remote.unsent-draft'))).toBe('失效时尚未发出的草稿');
  identity.expire(); await page.evaluate(() => window.dispatchEvent(new Event('multivac.access-check')));
  await expect(page.getByLabel('访问 token')).toBeVisible(); await login(page);
  await expect(page.getByLabel('Multivac 草稿')).toHaveValue('失效时尚未发出的草稿'); expect(sends).toEqual([]);
});

test('精简Provider树中目录授权可拒绝，卡片不初始化工作区或Inbox', async ({ page }) => {
  const paths: string[] = []; const errors: string[] = [];
  page.on('request', req => { const path = new URL(req.url()).pathname; if (path.startsWith('/api/')) paths.push(path); });
  page.on('pageerror', error => errors.push(error.message));
  await remoteIdentity(page); await page.goto('/'); await login(page);
  await page.getByLabel('Multivac 草稿').fill('越界读取场景'); await page.getByLabel('发送消息').click();
  const card = page.locator('.authorization-card.pending').last(); await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: '仅这一次' })).toBeEnabled();
  await expect(card.getByText('在 Inbox 中查看原请求')).toHaveCount(0);
  await card.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(page.locator('.authorization-card').last()).toContainText('拒绝');
  expect(paths.filter(path => !allowedClientPath(path))).toEqual([]); expect(errors).toEqual([]);
});
