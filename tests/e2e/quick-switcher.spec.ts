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
