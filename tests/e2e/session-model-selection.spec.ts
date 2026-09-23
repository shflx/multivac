import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';

const root = `${fakeApiRoot}/api/assistant/model-selection`;
async function select(request: APIRequestContext, profileId: string) {
  const snapshot = await (await request.get(root)).json();
  const response = await request.post(`${root}/model`, { data: {
    commandId: randomUUID(), sessionId: 'global-coordinator', revision: snapshot.selection.revision, profileId,
  } });
  expect(response.ok()).toBe(true); return response.json();
}
async function menu(page: Page) {
  const trigger = page.getByRole('button', { name: '当前会话模型', exact: true });
  await expect(trigger).toContainText('GPT Fixture'); await trigger.click();
  return page.locator('#assistant-model-menu');
}
test.beforeEach(async ({ request }) => { await resetE2eState(request); await select(request, 'fixture-openai'); });

test('参考原型的四模型弹层保持完整分隔行、尺寸及选中状态，成功选择后收起', async ({ page }) => {
  await page.setViewportSize({ width: 382, height: 600 });
  await page.goto('/model-selector-harness.html');
  const trigger = page.getByRole('button', { name: '当前会话模型' });
  await expect(trigger).toContainText('GPT-5.2');
  await trigger.click();
  const popup = page.locator('#assistant-model-menu');
  await expect(popup).toHaveCSS('padding', '0px');
  await expect(popup).toHaveCSS('border-radius', '7px');
  const bounds = await popup.boundingBox();
  expect(bounds!.width).toBe(330);
  expect(bounds!.height).toBeGreaterThan(338);
  expect(bounds!.height).toBeLessThan(342);
  const rows = popup.locator('.model-option button');
  await expect(rows).toHaveCount(4);
  for (const row of await rows.all()) {
    expect((await row.boundingBox())!.height).toBe(48);
    await expect(row).toHaveCSS('border-bottom-width', '1px');
    await expect(row).toHaveCSS('border-radius', '0px');
  }
  await expect(popup.locator('button.selected')).toHaveCSS('background-color', 'rgb(243, 247, 244)');
  await expect(popup.getByRole('button', { name: /本地 Coding 模型/ })).toContainText('未配置');
  await expect(popup.locator('.model-selector-note')).toHaveCount(0);
  await expect(popup.locator('.model-option-status').first()).toHaveCSS('clip-path', 'inset(50%)');
  await popup.getByRole('button', { name: /GPT-4.1 mini/ }).click();
  await expect(popup).toBeHidden();
  await expect(trigger).toContainText('GPT-4.1 mini');
  await trigger.click();
  await expect(popup.getByLabel('推理等级')).toHaveValue('off');
  await popup.getByRole('button', { name: /本地 Coding 模型/ }).click();
  await expect(popup.getByRole('alert')).toContainText('有效认证');
  await expect(trigger).toContainText('GPT-4.1 mini');
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect(trigger).toBeFocused();
});

for (const width of [320, 390]) test(`${width}px 原型弹层长名称单行省略并保留完整提示，管理入口可达`, async ({ page }) => {
  await page.setViewportSize({ width, height: 600 });
  await page.goto('/model-selector-harness.html?variant=long');
  const trigger = page.getByRole('button', { name: '当前会话模型' });
  await trigger.click();
  const popup = page.locator('#assistant-model-menu');
  const header = popup.locator('.model-selector-heading strong');
  await expect(header).toHaveCSS('white-space', 'nowrap');
  await expect(header).toHaveCSS('text-overflow', 'ellipsis');
  await expect(header).toHaveAttribute('title', '很长的模型名称'.repeat(12));
  const bounds = await popup.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  for (const row of await popup.locator('.model-option button').all()) expect((await row.boundingBox())!.height).toBe(48);
  await popup.getByRole('button', { name: '管理模型配置' }).click();
  await expect(page.getByRole('heading', { name: '模型管理入口已触发' })).toBeVisible();
});

test('首屏模型读取挂起时草稿框尚未就绪，首次读取完成后快速 Enter 正常发送', async ({ page }) => {
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const entry = new Promise<void>((done) => { entered = done; });
  await page.route('**/api/assistant/model-selection', async (route) => {
    const response = await route.fetch(); entered(); await gate; await route.fulfill({ response });
  });
  try {
    await page.goto('/'); await entry;
    const draft = page.getByLabel('Multivac 草稿');
    await expect(draft).toBeDisabled(); await expect(draft).toHaveAttribute('aria-busy', 'true');
    release(); await expect(draft).toBeEditable();
    await draft.fill('首屏模型读取完成后立即发送'); await draft.press('Enter');
    await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
    await expect(draft).toHaveValue('');
  } finally { release(); }
});

test('实际 fake endpoint 选择模型及 Pi 等级、归一化、刷新保持选择，不重复 POST', async ({ page, request }) => {
  let writes = 0;
  page.on('request', (req) => { if (req.method() === 'POST' && req.url().includes('/model-selection/')) writes++; });
  await page.goto('/'); const popup = await menu(page);
  await popup.getByRole('button', { name: /Claude Fixture/ }).click();
  await expect(page.getByRole('button', { name: '当前会话模型' })).toContainText('Claude Fixture');
  await expect(popup).toBeHidden();
  await page.getByRole('button', { name: '当前会话模型' }).click();
  await expect(popup.getByLabel('推理等级')).toBeEnabled();
  await popup.getByLabel('推理等级').selectOption('high');
  await expect(page.getByRole('button', { name: '当前会话模型' })).toContainText('高');
  expect((await (await request.get(root)).json()).selection.thinkingLevel).toBe('high');
  await popup.getByRole('button', { name: /GPT Fixture/ }).click();
  await expect(popup).toBeHidden();
  await page.getByRole('button', { name: '当前会话模型' }).click();
  await expect(popup.getByLabel('推理等级').locator('option')).toHaveCount(1);
  await expect(popup.getByLabel('推理等级')).toHaveValue('off');
  expect(writes).toBe(3);
  await page.reload(); await menu(page);
  await expect(page.getByRole('button', { name: '当前会话模型' })).toContainText('关闭');
  expect(writes).toBe(3);
});

test('不可用项可查看原因但不应用，管理返回保留草稿、阅读位置及输入焦点', async ({ page }) => {
  await page.goto('/');
  const draft = page.getByRole('textbox', { name: 'Multivac 草稿' });
  await draft.fill('模型管理返回现场'); await draft.focus();
  const scrollSelector = '.message-scroll';
  const top = await page.locator(scrollSelector).evaluate((element) => { element.scrollTop = 80; return element.scrollTop; });
  const popup = await menu(page);
  await popup.getByRole('button', { name: /未认证 Fixture/ }).click();
  await expect(popup.getByRole('alert')).toContainText('有效认证');
  await expect(page.getByRole('button', { name: '当前会话模型' })).toContainText('GPT Fixture');
  await popup.getByRole('button', { name: '管理模型配置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '模型', exact: true })).toBeVisible();
  await page.locator('.management-page-header').getByRole('button', { name: '返回工作模式' }).click();
  await expect(draft).toHaveValue('模型管理返回现场'); await expect(draft).toBeFocused();
  expect(await page.locator(scrollSelector).evaluate((element) => element.scrollTop)).toBeCloseTo(top, 0);
});

test('运行中模型/等级禁用并解释原因，真实服务拒绝绕过 UI 的选模', async ({ page, request }) => {
  await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`);
  try {
    await page.goto('/'); await page.getByRole('textbox', { name: 'Multivac 草稿' }).fill('重试压缩场景');
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await request.get(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`);
    const popup = await menu(page);
    await expect(popup.getByRole('button', { name: /Claude Fixture/ })).toBeDisabled();
    await expect(popup.getByLabel('推理等级')).toBeDisabled();
    await expect(popup.getByRole('status')).toContainText('运行中');
    const snapshot = await (await request.get(root)).json();
    const bypass = await request.post(`${root}/model`, { data: { commandId: randomUUID(), sessionId: 'global-coordinator',
      revision: snapshot.selection.revision, profileId: 'fixture-anthropic' } });
    expect(bypass.status()).toBe(409); expect((await bypass.json()).error).toBe('SESSION_RUNNING');
  } finally { await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`); }
});

test('实际 setter 失败与部分成功显示真实选择，不自动重发', async ({ page, request }) => {
  let writes = 0;
  page.on('request', (req) => { if (req.method() === 'POST' && req.url().endsWith('/model-selection/model')) writes++; });
  await page.goto('/'); const popup = await menu(page);
  await request.post(`${fakeApiRoot}/api/__e2e/model-selection`, { data: { failure: 'fail' } });
  await popup.getByRole('button', { name: /Claude Fixture/ }).click();
  await expect(popup.getByRole('alert')).toContainText('Pi 切换失败');
  await expect(page.getByRole('button', { name: '当前会话模型' })).toContainText('GPT Fixture');
  await request.post(`${fakeApiRoot}/api/__e2e/model-selection`, { data: { failure: 'partial' } });
  await popup.getByRole('button', { name: /Claude Fixture/ }).click();
  await expect(page.getByRole('button', { name: '当前会话模型' })).toContainText('Claude Fixture');
  await expect(popup.getByRole('alert')).toContainText('Pi 切换失败');
  await expect.poll(async () => (await (await request.get(root)).json()).selection.profileId).toBe('fixture-anthropic');
  expect(writes).toBe(2);
});

test('失败 revision 返回真实选择，丢失 POST 回应只查询原 commandId', async ({ page }) => {
  await page.goto('/'); const popup = await menu(page);
  await page.route('**/api/assistant/model-selection/model', async (route) => {
    const payload = route.request().postDataJSON(); payload.revision += 10;
    const response = await route.fetch({ postData: payload }); await route.fulfill({ response });
  });
  await popup.getByRole('button', { name: /Claude Fixture/ }).click();
  await expect(popup.getByRole('alert')).toContainText('其他位置更新');
  await expect(page.getByRole('button', { name: '当前会话模型' })).toContainText('GPT Fixture');
  await page.unroute('**/api/assistant/model-selection/model');
  let posts = 0; let commandId = '';
  await page.route('**/api/assistant/model-selection/model', async (route) => {
    posts++; commandId = route.request().postDataJSON().commandId;
    await route.fetch(); await route.abort('failed');
  });
  const reconciled = page.waitForRequest((req) => req.method() === 'GET' && req.url().endsWith(`/model-selection/commands/${commandId}`));
  await popup.getByRole('button', { name: /Claude Fixture/ }).click(); await reconciled;
  await expect(page.getByRole('button', { name: '当前会话模型' })).toContainText('Claude Fixture');
  expect(posts).toBe(1);
});

test('认证变更轮询同步引用与 send 门禁，连接未测试不是缺 auth', async ({ page, request }) => {
  await page.goto('/'); const popup = await menu(page);
  await expect(popup.locator('.model-option').filter({ hasText: 'GPT Fixture' })).toContainText('已认证 · 可用 · 连接未测试');
  const before = await (await request.get(`${fakeApiRoot}/api/model-access`)).json();
  await request.post(`${fakeApiRoot}/api/model-access/api-key`, { data: { commandId: randomUUID(), apiKey: 'selection-first-key',
    profileId: 'fixture-missing-auth', revision: before.revision, accessRevision: before.accessRevision } });
  await select(request, 'fixture-missing-auth');
  await expect(page.getByRole('button', { name: '当前会话模型' })).toContainText('未认证 Fixture');
  const access = await (await request.get(`${fakeApiRoot}/api/model-access`)).json();
  const revoked = await request.post(`${fakeApiRoot}/api/model-access/revoke-api-key`, { data: { commandId: randomUUID(),
    profileId: 'fixture-missing-auth', revision: access.revision, accessRevision: access.accessRevision } });
  expect(revoked.ok()).toBe(true);
  await expect(popup.getByRole('alert')).toContainText('失效');
  await page.getByRole('button', { name: '当前会话模型' }).click();
  await page.getByRole('textbox', { name: 'Multivac 草稿' }).fill('认证失效禁止发送');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  expect((await (await request.get(root)).json()).selection.profileId).toBe('fixture-missing-auth');
  const latest = await (await request.get(`${fakeApiRoot}/api/model-access`)).json();
  const configured = await request.post(`${fakeApiRoot}/api/model-access/api-key`, { data: { commandId: randomUUID(), apiKey: 'selection-e2e-key',
    profileId: 'fixture-missing-auth', revision: latest.revision, accessRevision: latest.accessRevision } });
  expect(configured.ok()).toBe(true);
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
});

test('空配置保留失效引用且提供管理入口，不做 mock fallback', async ({ page, request }) => {
  await request.post(`${fakeApiRoot}/api/__e2e/model-selection`, { data: { empty: true } });
  await page.goto('/');
  await page.getByRole('button', { name: '当前会话模型' }).click();
  const popup = page.locator('#assistant-model-menu');
  await expect(popup).toContainText('尚无模型配置');
  await expect(popup.getByLabel('推理等级')).toBeDisabled();
  const snapshot = await (await request.get(root)).json();
  expect(snapshot.selection.profileId).toBe('fixture-openai'); expect(snapshot.selection.availability.available).toBe(false);
  await popup.getByRole('button', { name: '管理模型配置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '模型', exact: true })).toBeVisible();
});

test('390px 窄屏上弹菜单不溢出，长名称与 provider/model ID 可阅读', async ({ page, request }) => {
  const settings = await (await request.get(`${fakeApiRoot}/api/model-settings`)).json();
  const old = settings.profiles.find((profile: { profileId: string }) => profile.profileId === 'fixture-openai');
  delete old.capabilities;
  await request.post(`${fakeApiRoot}/api/model-settings/profiles`, { data: { commandId: randomUUID(), revision: settings.revision,
    profile: { ...old, displayName: 'A'.repeat(150) } } });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.getByRole('button', { name: '当前会话模型' }).click();
  const popup = page.locator('#assistant-model-menu'); await expect(popup).toBeVisible();
  await expect(popup.locator('.model-option-copy').first()).toHaveCSS('align-items', 'stretch');
  const bounds = await popup.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  for (const selector of ['.message-stream', '.assistant-composer', '.composer-send-button']) {
    const bounds = await page.locator(selector).boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  }
  const width = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  expect(width.content).toBeLessThanOrEqual(width.viewport);
  await expect(popup.getByRole('button', { name: '管理模型配置', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/session-model-selection-mobile.png' });
});
