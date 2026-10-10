import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';

test.beforeEach(async ({ request }) => { await resetE2eState(request); });

const preferencesPage = (page: Page) => page.getByRole('main', { name: '偏好' });
const budgetCard = (page: Page) => preferencesPage(page).getByRole('region', { name: '任务执行' });

async function openPreferences(page: Page): Promise<void> {
  await page.goto('/');
  await page.keyboard.press('ControlOrMeta+G');
  await page.getByRole('dialog', { name: '面板跳转' }).press('3');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '偏好' }).click();
  await expect(preferencesPage(page).getByRole('heading', { name: '偏好', level: 1 })).toBeVisible();
}

/**
 * 任务树共享的执行时长是“设置 · 偏好”：默认 6 小时、四档可选，改完即生效；
 * 新建任务按保存时的偏好取预算，已创建的任务不受影响，非法档位被服务端拒绝。
 */
test('任务执行时长偏好：默认 6 小时、修改即生效并持久，新建任务按偏好取预算', async ({ page, request }) => {
  await openPreferences(page);
  const card = budgetCard(page);
  await expect(card.getByRole('heading', { name: '任务执行', level: 2 })).toBeVisible();
  await expect(card.locator('header p')).toContainText('共享预算');

  const select = card.getByRole('combobox', { name: '执行时长上限' });
  await expect(select).toHaveValue(String(6 * 3_600_000));
  await expect(select.locator('option')).toHaveText(['30 分钟', '2 小时', '6 小时', '24 小时']);
  await expect(card.getByRole('alert')).toHaveCount(0);
  // 行说明一句话写清共享口径，作用范围收在“了解更多”里。
  await expect(card.locator('.settings-row-label small')).toContainText('任务树共享这一份时长');
  await card.locator('.settings-row-label summary', { hasText: '了解更多' }).click();
  await expect(card.locator('.settings-row-label .settings-more')).toContainText('新建任务和点击“继续任务”');

  // 新建任务默认拿到 6 小时的执行时长。
  const before = await (await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: 'budget-before', title: '默认六小时', goal: '核对默认预算' } })).json();
  expect(before.task.budget).toEqual({ maxRuns: 20, maxMillis: 6 * 3_600_000, maxOutputBytes: 16 * 1024 * 1024 });

  // 改成 2 小时：立即保存，控件旁短暂显示“已保存”。
  await select.selectOption(String(2 * 3_600_000));
  await expect(card.getByRole('status')).toHaveText('已保存');
  expect((await (await request.get(`${fakeApiRoot}/api/preferences`)).json()).preferences.taskBudgetMillis).toBe(2 * 3_600_000);

  // 之后新建的任务按新偏好取预算，已有任务保持创建时的预算。
  const after = await (await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: 'budget-after', title: '两小时', goal: '核对偏好预算' } })).json();
  expect(after.task.budget?.maxMillis).toBe(2 * 3_600_000);
  const old = await (await request.get(`${fakeApiRoot}/api/tasks/${before.task.taskId}`)).json();
  expect(old.task.budget.maxMillis).toBe(6 * 3_600_000);

  // 刷新后保持；服务端只接受固定档位。
  await page.reload();
  await page.keyboard.press('ControlOrMeta+G');
  await page.getByRole('dialog', { name: '面板跳转' }).press('3');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '偏好' }).click();
  await expect(budgetCard(page).getByRole('combobox', { name: '执行时长上限' })).toHaveValue(String(2 * 3_600_000));
  const rejected = await request.patch(`${fakeApiRoot}/api/preferences`, { data: { taskBudgetMillis: 900_000 } });
  expect(rejected.status()).toBe(400);
  expect((await rejected.json()).error.message).toContain('任务执行时长只能是');
});

test('偏好保存失败时原因写在这一行下方，控件回到已保存的值', async ({ page }) => {
  await openPreferences(page);
  const card = budgetCard(page);
  const select = card.getByRole('combobox', { name: '执行时长上限' });
  await expect(select).toHaveValue(String(6 * 3_600_000));
  await page.route('**/api/preferences', (route) => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '偏好保存失败：服务暂时不可用。' } }) })
    : route.continue());
  await select.selectOption(String(24 * 3_600_000));
  const row = card.locator('.settings-row').filter({ has: page.locator('.settings-row-label strong', { hasText: '执行时长上限' }) });
  await expect(row.getByRole('alert')).toHaveText('偏好保存失败：服务暂时不可用。');
  await expect(select).toHaveValue(String(6 * 3_600_000));
  await expect(select).toHaveAttribute('aria-invalid', 'true');
  await expect(card.getByRole('status')).toHaveCount(0);
});
