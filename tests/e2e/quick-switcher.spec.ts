import { expect, test } from '@playwright/test';
import { fakeApiRoot, openModelSettings, openPanel, resetE2eState } from './test-state.js';

test.beforeEach(async ({ request }) => { await resetE2eState(request); });

test('快速跳转去重真实会话，键盘跨工作区导航、归档过滤和焦点返回', async ({ page, request }) => {
  const project = await (await request.post(`${fakeApiRoot}/api/projects`, { data: { name: '接口项目' } })).json();
  for (const data of [{ sessionId: 'jump-default', title: '默认接口' }, { sessionId: 'jump-project', title: 'API 导航', workspaceId: project.workspace.workspaceId }]) expect((await request.post(`${fakeApiRoot}/api/sessions`, { data })).ok()).toBe(true);
  await page.goto('/');
  await page.keyboard.press('ControlOrMeta+K');
  await expect(page.getByRole('dialog', { name: '跳到会话' })).toHaveCount(0);
  await openPanel(page, 'workspace');
  const composer = page.locator('.conversation-panel.active').getByLabel('Multivac 草稿');
  await composer.fill('跨项目保留的草稿');
  await page.keyboard.press('ControlOrMeta+K');
  const palette = page.getByRole('dialog', { name: '跳到会话' });
  await expect(palette.getByRole('option')).toHaveCount(2);
  await expect(palette.getByRole('combobox')).toBeFocused();
  await palette.getByRole('combobox').fill('api 项目');
  await expect(palette.getByRole('option')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/quick-switcher.png' });
  await page.keyboard.press('Enter');
  await expect(page.locator('.conversation-panel.active h2')).toHaveText('API 导航');
  await page.keyboard.press('ControlOrMeta+K');
  await palette.getByRole('combobox').fill('默认接口');
  await page.keyboard.press('Enter');
  await expect(composer).toHaveValue('跨项目保留的草稿');
  await composer.focus();
  await page.keyboard.press('ControlOrMeta+K');
  await palette.getByRole('combobox').fill('不存在的内容');
  await expect(palette.getByRole('option')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(composer).toBeFocused();
  expect((await request.post(`${fakeApiRoot}/api/sessions/jump-project/archive`)).ok()).toBe(true);
  await page.keyboard.press('ControlOrMeta+K');
  await expect(palette.getByRole('option')).toHaveCount(1);
});

test('管理快速跳转沿注册页面导航，未保存修改先确认', async ({ page }) => {
  await page.goto('/');
  await openModelSettings(page);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('显示名称').fill('未保存的模型');
  await page.keyboard.press('ControlOrMeta+K');
  const palette = page.getByRole('dialog', { name: '跳到页面' });
  await palette.getByRole('combobox').fill('最近');
  await expect(palette.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('dialog', { name: '放弃未保存的更改？' });
  await confirm.getByRole('button', { name: '继续编辑' }).click();
  await expect(page.getByLabel('显示名称')).toHaveValue('未保存的模型');
  await page.keyboard.press('ControlOrMeta+K');
  await palette.getByRole('combobox').fill('最近');
  await page.keyboard.press('Enter');
  await confirm.getByRole('button', { name: '放弃并离开' }).click();
  await expect(page.getByRole('heading', { name: '偏好', level: 1 })).toBeVisible();
});

test('侧栏收起时顶部展示最近五个真实会话，按活动排序并去重，键盘可直接跳转', async ({ page, request }, testInfo) => {
  const project = await (await request.post(`${fakeApiRoot}/api/projects`, { data: { name: '跳转项目' } })).json();
  for (let index = 0; index < 7; index += 1) {
    const response = await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId: `recent-jump-${index}`, title: `最近跳转 ${index}`, ...(index % 2 ? { workspaceId: project.workspace.workspaceId } : {}) } });
    expect(response.ok()).toBeTruthy();
  }
  expect((await request.post(`${fakeApiRoot}/api/sessions/recent-jump-6/archive`)).ok()).toBeTruthy();
  // 侧栏“最近”的天数偏好不影响快速跳转的最近五项。
  expect((await request.patch(`${fakeApiRoot}/api/preferences`, { data: { recentDays: 0 } })).ok()).toBeTruthy();
  await page.goto('/'); await openPanel(page, 'workspace');
  await page.keyboard.press('ControlOrMeta+K');
  const palette = page.getByRole('dialog', { name: '跳到会话' });
  await palette.getByRole('combobox').fill('最近跳转 0');
  await expect(palette.getByRole('option').filter({ hasText: '最近跳转 0' })).toBeVisible();
  await page.keyboard.press('Enter');
  const panel = page.locator('.conversation-panel[data-session-id="recent-jump-0"]');
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel('Multivac 草稿')).toBeFocused();
  await panel.getByLabel('Multivac 草稿').fill('让较早创建的会话产生最新活动');
  await panel.getByLabel('发送消息').click();
  await expect(panel.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await panel.getByLabel('Multivac 草稿').fill('保留当前草稿');
  const rail = page.getByRole('complementary', { name: '工作区会话导航' });
  if (await rail.isVisible()) await page.keyboard.press('ControlOrMeta+B');
  await expect(rail).toBeHidden();
  await page.keyboard.press('ControlOrMeta+K');
  await expect(palette.getByRole('option')).toHaveCount(6);
  await expect(palette.locator('.palette-group').first()).toHaveText('最近会话5');
  const titles = palette.getByRole('option').locator('strong');
  await expect(titles).toHaveText(['最近跳转 0', '最近跳转 5', '最近跳转 4', '最近跳转 3', '最近跳转 2', '最近跳转 1']);
  await expect(palette.getByRole('option').nth(1)).toContainText('跳转项目');
  await expect(palette).not.toContainText('最近跳转 6');
  await page.screenshot({ path: testInfo.outputPath('recent-five.png') });
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(page.locator('.conversation-panel.active h2')).toHaveText('最近跳转 5');
  await expect(rail).toBeHidden();
  await page.keyboard.press('ControlOrMeta+K');
  await palette.getByRole('combobox').fill('最近跳转 0');
  await expect(palette.getByRole('option')).toHaveCount(1);
  await expect(palette.locator('.palette-group')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(panel.getByLabel('Multivac 草稿')).toHaveValue('保留当前草稿');
});
