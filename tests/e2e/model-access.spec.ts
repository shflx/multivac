import { expect, test } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';

test.beforeEach(async ({ request }) => { await resetE2eState(request); });

test('页面展示 service deadline 驱动的 timeout，认证仍独立且可再次检查', async ({ page, request }) => {
  await openModel(page, 'GPT Fixture');
  expect((await request.post(`${fakeApiRoot}/api/__e2e/model-access`, { data: { behavior: 'wait', timeoutMs: 200 } })).ok()).toBe(true);
  await page.getByRole('button', { name: '检查连接', exact: true }).click();
  await expect(page.getByText('检查超时', { exact: true })).toBeVisible();
  await expect(page.locator('.model-check-state')).toHaveAttribute('data-check-status', 'timed-out');
  await expect(page.locator('.model-availability')).toContainText('已认证且可用');
  await expect(page.getByRole('button', { name: '取消检查', exact: true })).toHaveCount(0);
  expect((await request.post(`${fakeApiRoot}/api/__e2e/model-access`, { data: { behavior: 'pass', timeoutMs: 20000 } })).ok()).toBe(true);
  await page.getByRole('button', { name: '检查连接', exact: true }).click();
  await expect(page.getByText('连接成功', { exact: true })).toBeVisible();
});

test('异常结算读取失败的取消快照递增 revision，迟到旧 checking GET 不能回滚 invalidated', async ({ page, request }) => {
  await openModel(page, 'GPT Fixture');
  expect((await request.post(`${fakeApiRoot}/api/__e2e/model-access`, { data: { behavior: 'wait-read-failure' } })).ok()).toBe(true);
  await page.getByRole('button', { name: '检查连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消检查', exact: true })).toBeVisible();
  let entered!: () => void; let release!: () => void;
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let once = true;
  let oldRevision = -1;
  await page.route('**/api/model-access', async (route) => {
    if (!once) return route.continue(); once = false;
    const old = await route.fetch(); const snapshot = await old.json();
    expect(snapshot.checks[0].status).toBe('checking'); oldRevision = snapshot.accessRevision;
    entered(); await gate; await route.fulfill({ response: old });
  });
  try {
    const late = page.waitForResponse('**/api/model-access');
    await page.getByRole('button', { name: '刷新认证与连接状态', exact: true }).click(); await entry;
    const cancelled = page.waitForResponse('**/api/model-access/cancel-check');
    await page.getByRole('button', { name: '取消检查', exact: true }).click();
    const settled = await (await cancelled).json();
    expect(settled.accessRevision).toBe(oldRevision + 1);
    expect(settled.checks[0].status).toBe('invalidated');
    await expect(page.locator('.model-check-state')).toHaveAttribute('data-check-status', 'invalidated');
    release(); await (await late).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('.model-check-state')).toHaveAttribute('data-check-status', 'invalidated');
    await expect(page.getByRole('button', { name: '取消检查', exact: true })).toHaveCount(0);
  } finally { release(); }
});

test('前端本地到期，同版本迟到 passed 不回滚，跨期新检查响应也显示 expired', async ({ page }) => {
  await openModel(page, 'GPT Fixture');
  await page.getByRole('button', { name: '检查连接', exact: true }).click();
  await expect(page.getByText('连接成功', { exact: true })).toBeVisible();
  const state = page.locator('.model-check-state');
  const oldId = await state.getAttribute('data-check-id');
  let mode: 'first' | 'held-future' | 'late-past' = 'first';
  let entered!: () => void; let release!: () => void;
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let fulfilled = 0;
  await page.route('**/api/model-access', async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    const check = snapshot.checks[0];
    if (check?.status === 'passed') {
      if (mode === 'first') {
        check.expiresAt = new Date(Date.now() + 300).toISOString(); mode = 'held-future';
      } else if (mode === 'held-future') {
        entered(); await gate;
      } else if (check.checkId !== oldId) {
        check.expiresAt = new Date(Date.now() + 30).toISOString();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await route.fulfill({ response, json: snapshot }); fulfilled += 1;
  });
  try {
    await page.getByRole('button', { name: '刷新认证与连接状态', exact: true }).click();
    await expect(state).toHaveAttribute('data-check-status', 'expired');
    expect(fulfilled).toBe(1);
    await entry;
    const late = page.waitForResponse('**/api/model-access');
    release(); await (await late).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(state).toHaveAttribute('data-check-status', 'expired');
    mode = 'late-past';
    const start = page.waitForRequest((req) => req.url().endsWith('/api/model-access/check') && req.method() === 'POST');
    await page.getByRole('button', { name: '检查连接', exact: true }).click();
    const id = (await start).postDataJSON().commandId;
    await expect(state).toHaveAttribute('data-check-id', id);
    await expect(state).toHaveAttribute('data-check-status', 'expired');
    await expect(page.getByText('连接成功', { exact: true })).toHaveCount(0);
  } finally { release(); }
});

test('完整新取消快照跨 profile 重挂载后，迟到旧 GET 不回滚凭据/认证/检查', async ({ page, context, request }) => {
  await openModel(page);
  await page.getByLabel('一次性 API Key').fill('compound-key');
  await page.getByRole('button', { name: '配置 API Key', exact: true }).click();
  await expect(page.getByRole('button', { name: '检查连接', exact: true })).toBeEnabled();
  const second = await context.newPage(); await openModel(second);
  await request.post(`${fakeApiRoot}/api/__e2e/model-access`, { data: { behavior: 'wait' } });
  await page.getByRole('button', { name: '检查连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消检查', exact: true })).toBeVisible();
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  let once = true;
  await page.route('**/api/model-access', async (route) => {
    if (!once) return route.continue();
    once = false;
    const old = await route.fetch(); entered(); await gate; await route.fulfill({ response: old });
  });
  try {
    const late = page.waitForResponse('**/api/model-access');
    await page.getByRole('button', { name: '刷新认证与连接状态', exact: true }).click(); await entry;
    await second.getByRole('button', { name: '刷新认证与连接状态', exact: true }).click();
    await expect(second.getByText('正在检查', { exact: true })).toBeVisible();
    second.once('dialog', (dialog) => dialog.accept());
    await second.getByRole('button', { name: '撤销 API Key', exact: true }).click();
    await expect(second.locator('.model-access-panel')).toContainText('无已保存 API Key');
    await page.getByRole('button', { name: '取消检查', exact: true }).click();
    await expect(page.locator('.model-access-panel')).toContainText('无已保存 API Key');
    await page.getByRole('button', { name: /GPT Fixture/ }).click();
    await page.getByRole('button', { name: /未认证 Fixture/ }).click();
    await expect(page.getByText('检查已失效', { exact: true })).toBeVisible();
    release(); await (await late).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('.model-access-panel')).toContainText('无已保存 API Key');
    await expect(page.getByRole('button', { name: '检查连接', exact: true })).toBeDisabled();
    await expect(page.getByText('检查已失效', { exact: true })).toBeVisible();
  } finally { release(); await second.close(); }
});

test('延迟默认回执不覆盖跨页撤销后新 access 认证状态', async ({ page, context }) => {
  await openModel(page);
  const second = await context.newPage(); await openModel(second);
  await second.getByLabel('一次性 API Key').fill('default-key');
  await second.getByRole('button', { name: '配置 API Key', exact: true }).click();
  await expect(page.getByRole('button', { name: '设为默认', exact: true })).toBeEnabled();
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  await page.route('**/api/model-settings/default', async (route) => {
    const old = await route.fetch(); entered(); await gate; await route.fulfill({ response: old });
  });
  try {
    const late = page.waitForResponse('**/api/model-settings/default');
    await page.getByRole('button', { name: '设为默认', exact: true }).click(); await entry;
    await expect(second.getByRole('button', { name: '刷新当前配置', exact: true })).toBeVisible();
    await second.getByRole('button', { name: '刷新当前配置', exact: true }).click();
    await expect(second.getByRole('button', { name: '确认当前配置', exact: true })).toBeEnabled();
    await second.getByRole('button', { name: '确认当前配置', exact: true }).click();
    second.once('dialog', (dialog) => dialog.accept());
    await second.getByRole('button', { name: '撤销 API Key', exact: true }).click();
    await expect(second.locator('.model-availability')).toContainText('未认证');
    await expect(page.locator('.model-availability')).toContainText('认证状态待刷新');
    release(); await (await late).finished();
    await expect(page.getByRole('button', { name: '当前默认', exact: true })).toBeVisible();
    await expect(page.locator('.model-availability')).toContainText('未认证');
    await expect(page.locator('.model-access-panel')).toContainText('无已保存 API Key');
    await expect(page.getByRole('button', { name: '检查连接', exact: true })).toBeDisabled();
  } finally { release(); await second.close(); }
});

test('Cloudflare 多字段 Provider 禁用单 Key 提交并解释安全原因', async ({ page, request }) => {
  const snapshot = await (await request.get(`${fakeApiRoot}/api/model-settings`)).json();
  const saved = await request.post(`${fakeApiRoot}/api/model-settings/profiles`, { data: { commandId: 'cloudflare-profile',
    revision: snapshot.revision, profile: { profileId: 'cloudflare', displayName: 'Cloudflare', provider: 'cloudflare-ai-gateway',
      modelId: 'cloudflare-test', protocol: 'openai-completions', endpoint: 'https://gateway.ai.cloudflare.com' } } });
  expect(saved.ok()).toBe(true);
  await page.goto('/'); await page.getByRole('button', { name: '打开管理模式' }).click();
  await page.getByRole('button', { name: /Cloudflare/ }).click();
  await expect(page.locator('.model-access-panel')).toContainText('需要额外字段');
  await expect(page.getByLabel('一次性 API Key')).toBeDisabled();
  await expect(page.getByRole('button', { name: '配置 API Key', exact: true })).toBeDisabled();
});

test('迟到取消快照不得覆盖另一页撤销后的凭据及检查门禁', async ({ page, context, request }) => {
  await openModel(page);
  await page.getByLabel('一次性 API Key').fill('late-cancel-key');
  await page.getByRole('button', { name: '配置 API Key', exact: true }).click();
  await expect(page.getByRole('button', { name: '检查连接', exact: true })).toBeEnabled();
  const second = await context.newPage(); await openModel(second);
  await request.post(`${fakeApiRoot}/api/__e2e/model-access`, { data: { behavior: 'wait' } });
  await page.getByRole('button', { name: '检查连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消检查', exact: true })).toBeVisible();
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  await page.route('**/api/model-access/cancel-check', async (route) => {
    const old = await route.fetch(); entered(); await gate; await route.fulfill({ response: old });
  });
  try {
    const late = page.waitForResponse('**/api/model-access/cancel-check');
    await page.getByRole('button', { name: '取消检查', exact: true }).click(); await entry;
    await second.getByRole('button', { name: '刷新认证与连接状态', exact: true }).click();
    await expect(second.getByText('已取消', { exact: true })).toBeVisible();
    second.once('dialog', (dialog) => dialog.accept());
    await second.getByRole('button', { name: '撤销 API Key', exact: true }).click();
    await expect(page.getByRole('button', { name: '检查连接', exact: true })).toBeDisabled();
    await expect(page.locator('.model-access-panel')).toContainText('无已保存 API Key');
    release(); await (await late).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('button', { name: '检查连接', exact: true })).toBeDisabled();
    await expect(page.locator('.model-access-panel')).toContainText('无已保存 API Key');
  } finally { release(); await second.close(); }
});

test('双页仅配置及撤销 Key 自动更新真实认证/检查门禁，旧认证响应不得覆盖', async ({ page, context }) => {
  await openModel(page);
  const second = await context.newPage();
  await openModel(second);
  await expect(page.getByRole('button', { name: '检查连接', exact: true })).toBeDisabled();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  await page.route('**/api/model-settings', async (route) => {
    const old = await route.fetch();
    entered(); await gate;
    await route.fulfill({ response: old });
  });
  try {
    await page.getByRole('button', { name: '刷新认证与连接状态', exact: true }).click();
    await entry;
    await second.getByLabel('一次性 API Key').fill('second-page-key');
    await second.getByRole('button', { name: '配置 API Key', exact: true }).click();
    await expect(page.locator('.model-availability')).toContainText('已认证且可用');
    await expect(page.getByRole('button', { name: '检查连接', exact: true })).toBeEnabled();
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(page.locator('.model-availability')).toContainText('已认证且可用');
    await expect(page.getByRole('button', { name: '检查连接', exact: true })).toBeEnabled();
    await expect(second.getByRole('button', { name: '撤销 API Key', exact: true })).toBeEnabled();
    second.once('dialog', (dialog) => dialog.accept());
    await second.getByRole('button', { name: '撤销 API Key', exact: true }).click();
    await expect(page.locator('.model-availability')).toContainText('未认证');
    await expect(page.getByRole('button', { name: '检查连接', exact: true })).toBeDisabled();
    await expect(page.getByLabel('一次性 API Key')).toHaveValue('');
  } finally { release(); await second.close(); }
});

test('慢全量 access GET 期间快速切换 profile 不累积旧请求', async ({ page }) => {
  let activeRequests = 0;
  let maximum = 0;
  let count = 0;
  let entered!: () => void;
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  await page.route('**/api/model-access', async (route) => {
    activeRequests += 1; count += 1; maximum = Math.max(maximum, activeRequests); entered();
    try {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 1800));
      await route.fulfill({ response });
    } finally { activeRequests -= 1; }
  });
  await page.goto('/');
  await page.getByRole('button', { name: '打开管理模式' }).click();
  await entry;
  for (const name of ['未认证 Fixture', 'Claude Fixture', 'GPT Fixture', 'Claude Fixture', '未认证 Fixture']) {
    await page.getByRole('button', { name: new RegExp(name) }).click();
  }
  await expect(page.getByLabel('一次性 API Key')).toBeEnabled({ timeout: 10000 });
  await expect(page.locator('.model-access-panel')).toContainText('Provider：missing-auth');
  expect(maximum).toBe(1);
  expect(count).toBeLessThanOrEqual(2);
});

for (const action of ['configure', 'revoke'] as const) {
  test(`双页 Provider 变更清空旧 Key，刷新确认前禁止 ${action}`, async ({ page, context, request }) => {
    const second = await context.newPage();
    await openModel(second, 'Claude Fixture');
    await second.getByLabel('一次性 API Key').fill('provider-b-key');
    await second.getByRole('button', { name: '配置 API Key', exact: true }).click();
    await expect(second.getByText('Pi 已保存 API Key', { exact: false })).toBeVisible();
    await openModel(page);
    if (action === 'revoke') {
      await page.getByLabel('一次性 API Key').fill('provider-a-stored-key');
      await page.getByRole('button', { name: '配置 API Key', exact: true }).click();
      await expect(page.getByRole('button', { name: '撤销 API Key', exact: true })).toBeEnabled();
      await expect(page.getByLabel('一次性 API Key')).toBeEnabled();
    }
    let writes = 0;
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/(?:api-key|revoke-api-key)$/u.test(req.url())) writes += 1;
    });
    await page.getByLabel('一次性 API Key').fill('old-provider-a-key');
    const config = await (await request.get(`${fakeApiRoot}/api/model-settings`)).json();
    const old = config.profiles.find((entry: { profileId: string }) => entry.profileId === 'fixture-missing-auth');
    // 第二页提交配置，第一页仍展示旧快照；凭据状态轮询不得把 B 状态套到 A。
    await second.evaluate(async ({ api, revision, profile }) => {
      const response = await fetch(`${api}/api/model-settings/profiles`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commandId: crypto.randomUUID(), revision, profile }) });
      if (!response.ok) throw new Error('config failed');
    }, { api: fakeApiRoot, revision: config.revision, profile: {
      profileId: old.profileId, displayName: old.displayName, modelId: old.modelId, provider: 'fixture-anthropic',
      protocol: 'anthropic-messages', endpoint: 'https://anthropic.fixture.example' } });
    await expect(page.getByLabel('一次性 API Key')).toHaveValue('');
    await expect(page.getByLabel('一次性 API Key')).toBeDisabled();
    await expect(page.getByRole('button', { name: '撤销 API Key', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '刷新当前配置', exact: true }).click();
    await expect(page.locator('.model-access-panel')).toContainText('Provider：fixture-anthropic');
    await expect(page.getByRole('button', { name: '确认当前配置', exact: true })).toBeEnabled();
    await expect(page.getByLabel('一次性 API Key')).toBeDisabled();
    const access = await (await request.get(`${fakeApiRoot}/api/model-access`)).json();
    expect(access.credentials.find((entry: { profileId: string }) => entry.profileId === 'fixture-anthropic').storedApiKey).toBe(true);
    expect(writes).toBe(0);
    await page.getByRole('button', { name: '确认当前配置', exact: true }).click();
    const submitted = page.waitForRequest((req) => req.url().endsWith(action === 'configure' ? '/api-key' : '/revoke-api-key') && req.method() === 'POST');
    if (action === 'configure') {
      await page.getByLabel('一次性 API Key').fill('confirmed-provider-b-key');
      await page.getByRole('button', { name: '配置 API Key', exact: true }).click();
    } else {
      page.once('dialog', async (dialog) => { expect(dialog.message()).toContain('fixture-anthropic'); await dialog.accept(); });
      await page.getByRole('button', { name: '撤销 API Key', exact: true }).click();
    }
    const payload = (await submitted).postDataJSON();
    expect(payload.revision).toBe(config.revision + 1);
    expect(writes).toBe(1);
    expect(JSON.stringify(payload)).not.toContain('old-provider-a-key');
    await expect(page.getByLabel('一次性 API Key')).toBeEnabled();
    await second.close();
  });
}

test('慢于轮询间隔的响应仍更新状态且始终单在途', async ({ page }) => {
  let concurrent = 0;
  let maximum = 0;
  let completed = 0;
  await page.route('**/api/model-access', async (route) => {
    concurrent += 1; maximum = Math.max(maximum, concurrent);
    try {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.fulfill({ response });
      completed += 1;
    } finally { concurrent -= 1; }
  });
  await openModel(page, 'GPT Fixture');
  await page.getByRole('button', { name: '检查连接', exact: true }).click();
  await expect(page.getByText('连接成功', { exact: true })).toBeVisible({ timeout: 15000 });
  expect(completed).toBeGreaterThanOrEqual(2);
  expect(maximum).toBe(1);
});

async function openModel(page: import('@playwright/test').Page, name = '未认证 Fixture') {
  await page.goto('/');
  await page.getByRole('button', { name: '打开管理模式' }).click();
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByLabel('一次性 API Key')).toBeEnabled();
}
test('一次性 password 录入提交后清空，不回显已有 Key，撤销后认证和检查状态更新', async ({ page }) => {
  await openModel(page);
  const input = page.getByLabel('一次性 API Key');
  await expect(input).toHaveAttribute('type', 'password');
  await input.fill('e2e-private-key');
  await page.getByRole('button', { name: '配置 API Key', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(page.getByText('Pi 已保存 API Key', { exact: false })).toBeVisible();
  await expect(page.getByText('已认证且可用', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '打开管理模式' }).click();
  await page.getByRole('button', { name: /未认证 Fixture/ }).click();
  await expect(input).toHaveValue('');
  await expect(page.getByText('Pi 已保存 API Key', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '检查连接', exact: true }).click();
  await expect(page.getByText('连接成功', { exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '撤销 API Key', exact: true }).click();
  await expect(page.getByText('无已保存 API Key', { exact: false })).toBeVisible();
  await expect(page.locator('.model-availability').getByText('未认证', { exact: true })).toBeVisible();
  await expect(page.getByText('检查已失效', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('');
  expect(await page.locator('body').innerText()).not.toContain('e2e-private-key');
});

test('错误结果仍清空输入，未知结果只查询安全原命令而不重发 Key', async ({ page }) => {
  await openModel(page);
  let posts = 0;
  let committedId = '';
  await page.route('**/api/model-access/api-key', async (route) => {
    posts += 1;
    committedId = route.request().postDataJSON().commandId;
    await route.fetch();
    await route.abort('failed');
  });
  await page.getByLabel('一次性 API Key').fill('unknown-private-key');
  await page.getByRole('button', { name: '配置 API Key', exact: true }).click();
  await expect(page.getByLabel('一次性 API Key')).toHaveValue('');
  await expect(page.getByRole('button', { name: '查询原命令结果' })).toBeVisible();
  const query = page.waitForRequest((request) => request.url().endsWith(`/commands/${committedId}`));
  await page.getByRole('button', { name: '查询原命令结果' }).click();
  await query;
  await expect(page.getByText('原命令结果已确认。')).toBeVisible();
  expect(posts).toBe(1);
  await page.unroute('**/api/model-access/api-key');
  await page.route('**/api/model-access/api-key', (route) => route.fulfill({ status: 409,
    contentType: 'application/json', body: JSON.stringify({ error: { code: 'ACCESS_CONFLICT' } }) }));
  await page.getByLabel('一次性 API Key').fill('conflicting-private-key');
  await page.getByRole('button', { name: '配置 API Key', exact: true }).click();
  await expect(page.getByLabel('一次性 API Key')).toHaveValue('');
  await expect(page.getByRole('alert')).toContainText('状态已更新');
});

test('检查失败与认证分离，支持取消/离开、过期和配置变化失效', async ({ page, request }) => {
  await openModel(page, 'GPT Fixture');
  await request.post(`${fakeApiRoot}/api/__e2e/model-access`, { data: { behavior: 'fail' } });
  await page.getByRole('button', { name: '检查连接', exact: true }).click();
  await expect(page.getByText('连接失败', { exact: true })).toBeVisible();
  await expect(page.getByText('已认证且可用', { exact: true })).toBeVisible();
  await request.post(`${fakeApiRoot}/api/__e2e/model-access`, { data: { behavior: 'wait' } });
  await page.getByRole('button', { name: '检查连接', exact: true }).click();
  await expect(page.getByText('正在检查', { exact: true })).toBeVisible();
  await page.locator('.management-page-header').getByRole('button', { name: '返回工作模式', exact: true }).click();
  await page.getByRole('button', { name: '打开管理模式' }).click();
  await page.getByRole('button', { name: '取消检查', exact: true }).click();
  await expect(page.getByText('已取消', { exact: true })).toBeVisible();
  await request.post(`${fakeApiRoot}/api/__e2e/model-access`, { data: { behavior: 'pass' } });
  await page.getByRole('button', { name: '检查连接', exact: true }).click();
  await expect(page.getByText('连接成功', { exact: true })).toBeVisible();
  await request.post(`${fakeApiRoot}/api/__e2e/model-access`, { data: { advanceMs: 300_001 } });
  await expect(page.getByText('检查已过期', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('显示名称').fill('Changed Fixture');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('检查已失效', { exact: true })).toBeVisible();
});

test('窄屏凭据面板可操作且无横向溢出，离开管理页清空未提交密码', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openModel(page, 'GPT Fixture');
  const input = page.getByLabel('一次性 API Key');
  await input.scrollIntoViewIfNeeded();
  await input.fill('not-submitted-private-key');
  const width = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  expect(width.content).toBeLessThanOrEqual(width.viewport);
  await page.locator('.management-page-header').getByRole('button', { name: '返回工作模式', exact: true }).click();
  await page.getByRole('button', { name: '打开管理模式' }).click();
  await expect(input).toHaveValue('');
  await input.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/model-access-mobile.png' });
});
