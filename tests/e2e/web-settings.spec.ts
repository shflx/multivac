import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

test.beforeEach(async ({ request }) => {
  await resetE2eState(request);
  const current = await (await request.get(`${fakeApiRoot}/api/web-settings`)).json();
  expect((await request.put(`${fakeApiRoot}/api/web-settings`, { data: {
    commandId: `reset-${current.revision}`, revision: current.revision, enabled: false, provider: 'deepseek', clearKey: true,
  } })).ok()).toBeTruthy();
});
async function openWeb(page: Page) {
  await page.goto('/');
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '能力', exact: true }).click();
  await page.getByRole('navigation', { name: '能力类型' }).getByRole('button', { name: '网页', exact: true }).click();
  await expect(page.getByRole('region', { name: '网页搜索与读取' })).toBeVisible();
  await expect(page.getByLabel('网页 API Key')).toBeEnabled();
}

test('网页配置：保存、刷新保留、关闭、移除密钥，响应不泄露秘密', async ({ page, request }, info) => {
  await openWeb(page);
  const card = page.getByRole('region', { name: '网页搜索与读取' });
  const toggle = card.getByRole('switch', { name: '启用网页能力' });
  await expect(toggle).not.toBeChecked();
  await card.getByLabel('网页 API Key').fill('e2e-private-key');
  await toggle.click();
  const saved = page.waitForResponse(response => response.url().endsWith('/api/web-settings') && response.request().method() === 'PUT');
  await card.getByRole('button', { name: '保存网页配置' }).click();
  const result = await (await saved).json();
  expect(result.enabled).toBe(true); expect(result.configured).toBe(true);
  expect(JSON.stringify(result)).not.toContain('e2e-private-key');
  await expect(card.getByLabel('网页 API Key')).toHaveValue('');
  await expect(card.getByText('已配置。留空保留现有密钥，填写新值可替换。')).toBeVisible();
  await openWeb(page);
  await expect(toggle).toBeChecked();
  await page.screenshot({ path: info.outputPath('web-settings.png'), fullPage: true });
  const baseline = await (await request.get(`${fakeApiRoot}/api/web-settings`)).json();
  const bad = await request.put(`${fakeApiRoot}/api/web-settings`, { data: { commandId: 'bad', revision: baseline.revision, enabled: true, provider: 'unknown', apiKey: 'secret' } });
  expect(bad.status()).toBe(400);
  await toggle.click();
  await card.getByRole('button', { name: '保存网页配置' }).click();
  await expect(card.getByRole('button', { name: '移除密钥' })).toBeEnabled();
  await card.getByRole('button', { name: '移除密钥' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '移除密钥', exact: true }).click();
  await expect(card.getByText('尚未配置。密钥仅保存在本实例，保存后不回显。')).toBeVisible();
  await expect(toggle).not.toBeChecked();
});

test('网页配置：其他窗口修改后保留草稿，禁止旧版本覆盖', async ({ page, request }) => {
  await openWeb(page);
  const key = page.getByLabel('网页 API Key');
  await key.fill('unsaved-key');
  const baseline = await (await request.get(`${fakeApiRoot}/api/web-settings`)).json();
  expect((await request.put(`${fakeApiRoot}/api/web-settings`, { data: { commandId: 'elsewhere', revision: baseline.revision, enabled: false, provider: 'deepseek', apiKey: 'other-key' } })).ok()).toBeTruthy();
  await expect(page.getByText('配置已在别处修改。草稿已保留，请放弃修改并刷新后重新核对。')).toBeVisible();
  await expect(key).toHaveValue('unsaved-key');
  await expect(page.getByRole('button', { name: '保存网页配置' })).toBeDisabled();
  await page.getByRole('button', { name: '放弃修改并刷新' }).click();
  await expect(key).toHaveValue('');
});

test('网页配置：保存回执丢失时只读核对，不重复发送密钥', async ({ page }) => {
  await openWeb(page);
  let writes = 0;
  await page.route('**/api/web-settings', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    writes++; await route.fetch(); await route.abort('failed');
  });
  await page.getByLabel('网页 API Key').fill('unknown-result-key');
  await page.getByRole('button', { name: '保存网页配置' }).click();
  const reconcile = page.getByRole('button', { name: '核对保存结果' });
  if (await reconcile.isVisible()) await reconcile.click();
  await expect(page.getByText(/已核对，配置已保存|已配置。留空保留/u).first()).toBeVisible();
  expect(writes).toBe(1);
  await expect(page.getByLabel('网页 API Key')).toHaveValue('');
});
