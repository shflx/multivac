import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState, ensureWorkspaceRail } from './test-state.js';
const view = (page: Page) => page.locator('.terminal-view');
async function command(page: Page, text: string) {
  await view(page).locator('.xterm-helper-textarea').focus(); await page.keyboard.insertText(text); await page.keyboard.press('Enter');
}
async function output(page: Page) { return view(page).locator('.xterm-rows').innerText(); }
test('真实shell：新建、echo、改名、刷新、第二窗口、断网输出、接管、全屏、exit 1与重开', async ({ page, request, context }) => {
  test.skip(process.platform !== 'darwin' || process.arch !== 'arm64');
  test.setTimeout(60000);
  await resetE2eState(request);
  const response = await request.post(`${fakeApiRoot}/api/projects`, { data: { name: '终端验收' } }); expect(response.status()).toBe(201);
  const { project } = await response.json();
  const modules: string[] = []; page.on('request', request => modules.push(request.url()));
  await page.goto('/'); await openPanel(page, 'workspace'); await ensureWorkspaceRail(page);
  expect(modules.some(url => url.includes('terminal-view') || url.includes('@xterm'))).toBe(false);
  const group = page.locator(`[data-workspace-id="${project.projectId}"]`);
  await group.locator('.rail-folder-toggle').click();
  await group.getByRole('button', { name: /新建会话/ }).click();
  await group.getByRole('button', { name: '空白终端' }).click();
  const dialog = page.getByRole('dialog', { name: '在「终端验收」新建终端' });
  await expect(dialog.getByLabel('终端目录')).toHaveValue(project.directories[0].path);
  await dialog.getByRole('button', { name: '启动终端' }).click();
  await expect(view(page)).toBeVisible(); await expect(view(page)).toContainText('此窗口可输入');
  await command(page, "printf '\\nBROWSER-%s\\n' ECHO");
  await expect.poll(() => output(page)).toContain('BROWSER-ECHO');
  await view(page).getByRole('button', { name: '终端', exact: true }).click();
  await view(page).getByLabel('终端名称').fill('验收 shell'); await view(page).getByRole('button', { name: '保存名称' }).click();
  await expect(view(page).getByRole('button', { name: '验收 shell', exact: true })).toBeVisible();
  await page.reload(); await expect(view(page)).toContainText('已连接'); await expect.poll(() => output(page)).toContain('BROWSER-ECHO');
  const second = await context.newPage(); await second.goto('/'); await openPanel(second, 'workspace'); await ensureWorkspaceRail(second);
  await second.locator('.rail-item[data-terminal-id]').getByRole('button').click();
  await expect(view(second)).toContainText('只读跟随'); await expect.poll(() => output(second)).toContain('BROWSER-ECHO');
  await view(second).getByRole('button', { name: '接管终端' }).click();
  await expect(view(second)).toContainText('此窗口可输入'); await expect(view(page)).toContainText('只读跟随');
  await command(second, "for i in 1 2 3 4 5 6 7 8 9 10; do printf 'OFFLINE-%s\\n' $i; sleep 0.15; done");
  await context.setOffline(true);
  await expect.poll(async () => {
    const response = await request.post(`${fakeApiRoot}/api/terminals/list`, { headers: { origin: fakeApiRoot }, data: { projectId: project.projectId } });
    return response.ok() && (await response.json()).terminals[0].unread;
  }).toBeTruthy();
  await context.setOffline(false);
  await expect.poll(() => output(second), { timeout: 10000 }).toContain('OFFLINE-10');
  const lines = (await output(second)).split('\n'); for (let i = 1; i <= 10; i++) expect(lines.filter(line => line.trim() === `OFFLINE-${i}`)).toHaveLength(1);
  // 断线释放拥有者，明确接管后继续。
  if (await view(second).getByRole('button', { name: '接管终端' }).isVisible()) await view(second).getByRole('button', { name: '接管终端' }).click();
  await expect(view(second)).toContainText('此窗口可输入');
  await view(second).getByRole('button', { name: '终端全屏' }).click();
  await expect.poll(() => second.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await expect(view(second).getByText('外部程序，Multivac 不管控', { exact: true })).toBeVisible();
  await second.screenshot({ path: 'artifacts/terminals/browser-fullscreen.png' });
  await view(second).getByRole('button', { name: '退出终端全屏' }).click();
  await command(second, 'exit 1'); await expect(view(second)).toContainText('退出码 1');
  await second.screenshot({ path: 'artifacts/terminals/browser-exit.png' });
  await view(second).getByRole('button', { name: '重新打开终端' }).click(); await expect(view(second)).toContainText('运行中');
  await expect.poll(() => output(second)).not.toContain('BROWSER-ECHO');
  await view(second).getByRole('button', { name: '关闭终端' }).click();
  const confirm = second.getByRole('dialog', { name: '关闭「验收 shell」' }); await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '取消', exact: true }).click(); await expect(view(second)).toBeVisible();
  await view(second).getByRole('button', { name: '结束进程' }).click(); await expect(view(second)).toContainText('用户结束');
  await view(second).getByRole('button', { name: '关闭终端' }).click(); await expect(view(second)).toHaveCount(0);
  const closed = second.locator(`[data-workspace-id="${project.projectId}"] details`); await closed.locator('summary').click();
  await closed.getByRole('button', { name: '验收 shell · 重新打开' }).click(); await expect(view(second)).toContainText('已关闭');
  await view(second).getByRole('button', { name: '重新打开终端' }).click(); await expect(view(second)).toContainText('运行中');
  await view(second).getByRole('button', { name: '结束进程' }).click(); await expect(view(second)).toContainText('用户结束');
  await second.close();
});
