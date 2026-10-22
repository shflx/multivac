import { expect, test, type Page } from '@playwright/test';
import { openCreationDialog, openPanel, resetE2eState } from './test-state.js';

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

test('手机 Inbox 保存修改草稿、刷新恢复、提交后保留回执且重新进入清空', async ({ page, context }, info) => {
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const create = page.getByRole('dialog', { name: '创建任务', exact: true });
  await create.getByLabel('任务名称', { exact: true }).fill('手机验收任务');
  await create.getByLabel('目标说明', { exact: true }).fill('核对手机端修改意见');
  await create.getByLabel('完成后需要我验收', { exact: true }).check();
  const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/tasks');
  await create.getByRole('button', { name: '创建任务', exact: true }).click();
  const { task } = await (await response).json(); await expect(create).toBeHidden();
  await openPanel(page, 'workspace'); await openCreationDialog(page);
  const session = page.getByRole('dialog', { name: '创建新会话', exact: true });
  await session.getByLabel('会话名称').fill('手机验收来源');
  await session.getByRole('button', { name: '创建', exact: true }).click();
  const panel = page.getByRole('region').filter({ has: page.getByRole('heading', { name: '手机验收来源', exact: true }) }).last();
  await panel.getByLabel('Multivac 草稿').fill(`内部工具：complete_task ${JSON.stringify({ taskId: task.taskId, revision: task.revision, summary: '已整理报告，请核对来源日期。' })}`);
  await panel.getByRole('button', { name: '发送消息', exact: true }).click();
  const phone = await context.newPage();
  try {
    await remoteLogin(phone, 320);
    await phone.getByRole('button', { name: 'Inbox，1 项待处理', exact: true }).click();
    await drawer(phone).getByRole('button').filter({ hasText: '手机验收任务' }).click();
    await expect(drawer(phone)).toContainText('没有后台运行或文件成果自检证据');
    await drawer(phone).getByRole('button', { name: '提出修改', exact: true }).click();
    const answer = drawer(phone).getByRole('textbox', { name: '修改意见' });
    await answer.fill('请补充来源日期和版本。');
    const saved = phone.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/state'));
    await expect(answer).toHaveValue('请补充来源日期和版本。'); await saved;
    await phone.setViewportSize({ width: 320, height: 480 });
    await answer.click();
    await expect(drawer(phone).getByRole('button', { name: '提交修改意见', exact: true })).toBeInViewport();
    await phone.screenshot({ path: info.outputPath('03-feedback-320.png'), animations: 'disabled' });
    await phone.reload();
    await phone.getByRole('button', { name: 'Inbox，1 项待处理', exact: true }).click();
    await drawer(phone).getByRole('button').filter({ hasText: '手机验收任务' }).click();
    await drawer(phone).getByRole('button', { name: '提出修改', exact: true }).click();
    await expect(answer).toHaveValue('请补充来源日期和版本。');
    await drawer(phone).getByRole('button', { name: '提交修改意见', exact: true }).click();
    await expect(drawer(phone)).toContainText('回应已保存：请补充来源日期和版本。');
    await phone.screenshot({ path: info.outputPath('04-feedback-receipt-320.png'), animations: 'disabled' });
    await drawer(phone).getByRole('button', { name: '关闭 Inbox', exact: true }).last().click();
    await phone.getByRole('button', { name: 'Inbox，0 项待处理', exact: true }).click();
    await expect(drawer(phone)).toContainText('全部处理完毕');
  } finally { await phone.close(); }
});

test('远程 Inbox 空状态在桌面两种视口保持可关闭', async ({ page }, info) => {
  await remoteLogin(page, 1440);
  for (const [width, height] of [[1440, 900], [1280, 720]]) {
    await page.setViewportSize({ width, height });
    const trigger = page.getByRole('button', { name: 'Inbox，0 项待处理', exact: true });
    await trigger.click(); await expect(drawer(page)).toContainText('全部处理完毕');
    await page.screenshot({ path: info.outputPath(`05-empty-${width}.png`), animations: 'disabled' });
    await page.keyboard.press('Escape'); await expect(drawer(page)).toBeHidden(); await expect(trigger).toBeFocused();
  }
});
