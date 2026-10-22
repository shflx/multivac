import { expect, test, type Page } from '@playwright/test';
import { resetE2eState } from './test-state.js';

/** 仅替换登录身份；Inbox 的读取、草稿和决定均走真实服务。真实 Cookie 与门禁另由 HTTP 回归覆盖。 */
async function remoteLogin(page: Page, width = 390) {
  await page.setViewportSize({ width, height: 844 });
  let authenticated = false;
  await page.route('**/api/access', route => route.fulfill({ json: { kind: 'remote', authenticated, loginEnabled: true } }));
  await page.route('**/api/access/login', route => { authenticated = true; return route.fulfill({ json: { ok: true } }); });
  await page.goto('/');
  await page.getByLabel('访问 token').fill('browser-fixture-token');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
}
const drawer = (page: Page) => page.getByRole('dialog', { name: 'Inbox', exact: true });

test.beforeEach(async ({ request }) => { await resetE2eState(request); });

test('局域网 HTTP 缺少 randomUUID 时仍可经手机 Inbox 单次授权', async ({ page, context }, info) => {
  await page.goto('/');
  const phone = await context.newPage();
  try {
    await phone.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined }));
    const errors: string[] = []; phone.on('pageerror', error => errors.push(error.message));
    const paths: string[] = []; phone.on('request', request => { const path = new URL(request.url()).pathname; if (path.startsWith('/api/')) paths.push(path); });
    await remoteLogin(phone);
    await expect(phone.getByRole('button', { name: 'Inbox，0 项待处理', exact: true })).toBeVisible();
    await page.getByLabel('Multivac 草稿').fill('越界读取场景');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByRole('region', { name: /^工具授权：/ }).last()).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Inbox，1 项待处理', exact: true })).toBeVisible({ timeout: 10000 });
    await phone.getByRole('button', { name: 'Inbox，1 项待处理', exact: true }).click();
    await drawer(phone).getByRole('button').filter({ hasText: '是否允许 read 访问' }).click();
    await expect(drawer(phone).getByRole('radio', { name: /仅这一次/ })).toBeChecked();
    await expect(drawer(phone).getByRole('radio', { name: /当前会话|当前项目/ })).toHaveCount(0);
    await phone.screenshot({ path: info.outputPath('01-authorization-390.png'), animations: 'disabled' });
    await drawer(phone).getByText('来源与补充说明', { exact: true }).click();
    await expect(drawer(phone).getByRole('button', { name: '返回来源会话' })).toHaveCount(0);
    await expect(drawer(phone)).toContainText('远程入口不提供来源跳转');
    await drawer(phone).getByRole('button', { name: '允许并继续', exact: true }).click();
    await expect(drawer(phone)).toContainText('已批准');
    await expect(page.getByRole('region', { name: /^工具授权：/ }).last()).toContainText('已批准');
    await phone.screenshot({ path: info.outputPath('02-approved-390.png'), animations: 'disabled' });
    expect(paths.filter(path => /^\/api\/(tasks|task-requests|projects|workspaces|sessions\/[^/]+\/session|artifacts)(\/|$)/.test(path))).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await phone.close(); }
});
