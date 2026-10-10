import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

test.beforeEach(async ({ request }) => { await resetE2eState(request); });
async function openPreferences(page: Page) {
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '偏好' }).click();
}
const diagnostics = (page: Page) => page.getByRole('main', { name: '偏好' }).getByRole('region', { name: '诊断', exact: true });

test('执行诊断默认开启，关闭与重开立即保存、跨窗口同步并在刷新后保留', async ({ page, context, request }) => {
  const other = await context.newPage();
  await openPreferences(page); await openPreferences(other);
  const select = diagnostics(page).getByRole('combobox', { name: '执行诊断' });
  await expect(select).toHaveValue('true');
  await expect(diagnostics(page)).toContainText('关闭后停止采集并保留已有日志');
  await select.selectOption('false');
  await expect(diagnostics(page).getByRole('status')).toHaveText('已保存');
  await expect(diagnostics(other).getByRole('combobox', { name: '执行诊断' })).toHaveValue('false');
  expect((await (await request.get(`${fakeApiRoot}/api/preferences`)).json()).preferences.executionDiagnosticsEnabled).toBe(false);
  await openPreferences(page); await expect(diagnostics(page).getByRole('combobox', { name: '执行诊断' })).toHaveValue('false');
  await diagnostics(page).getByRole('combobox', { name: '执行诊断' }).selectOption('true');
  await expect(diagnostics(other).getByRole('combobox', { name: '执行诊断' })).toHaveValue('true');
  expect((await (await request.get(`${fakeApiRoot}/api/preferences`)).json()).preferences.executionDiagnosticsEnabled).toBe(true);
  await other.close();
});

test('执行诊断保存失败显示行内原因，控件保留已保存的值', async ({ page, request }) => {
  await openPreferences(page);
  await page.route('**/api/preferences', route => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '诊断偏好保存失败。' } }) })
    : route.continue());
  const select = diagnostics(page).getByRole('combobox', { name: '执行诊断' });
  await select.selectOption('false');
  await expect(diagnostics(page).getByRole('alert')).toHaveText('诊断偏好保存失败。');
  await expect(select).toHaveValue('true'); await expect(select).toHaveAttribute('aria-invalid', 'true');
  expect((await (await request.get(`${fakeApiRoot}/api/preferences`)).json()).preferences.executionDiagnosticsEnabled).toBe(true);
});
