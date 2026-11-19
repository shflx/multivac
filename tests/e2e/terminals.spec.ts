import type { ProjectTerminal } from '@multivac/contracts';
import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState, ensureWorkspaceRail, selectWorkspaceLayout } from './test-state.js';
const view = (page: Page) => page.locator('.terminal-view');
async function command(page: Page, text: string) {
  await view(page).locator('.xterm-helper-textarea').focus(); await page.keyboard.insertText(text); await page.keyboard.press('Enter');
}
/** 按终端行读取；innerText 会将行内定位的文本片段误当作额外换行。 */
async function output(page: Page) { return (await view(page).locator('.xterm-rows > div').allTextContents()).join('\n'); }
/** 标题栏“更多”菜单中的操作。 */
async function menuAction(page: Page, name: string) {
  await view(page).getByRole('button', { name: /」的更多操作$/ }).click(); await view(page).getByRole('menuitem', { name, exact: true }).click();
}
test('日常终端：无项目时新建、核对 pwd、刷新接回、跨工作区跳转及关闭', async ({ page, request }) => {
  test.skip(process.platform !== 'darwin' || process.arch !== 'arm64');
  test.setTimeout(60_000);
  await resetE2eState(request);
  const projects = await request.get(`${fakeApiRoot}/api/projects`);
  expect((await projects.json()).projects).toEqual([]);
  const session = await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId: 'daily-terminal-session', title: '日常会话' } });
  expect(session.ok()).toBe(true);
  const list = async (workspaceId = 'default'): Promise<ProjectTerminal[]> => {
    const response = await request.post(`${fakeApiRoot}/api/terminals/list`, { headers: { origin: fakeApiRoot }, data: { workspaceId } });
    expect(response.ok()).toBe(true);
    return (await response.json()).terminals;
  };

  await page.goto('/'); await openPanel(page, 'workspace'); await ensureWorkspaceRail(page);
  const daily = page.locator('[data-workspace-id="default"]');
  const create = daily.getByRole('button', { name: '在「默认工作区」新建会话或终端' });
  await create.click();
  const createMenu = page.getByRole('menu', { name: '新建' });
  for (const name of [/^会话/, /^Claude Code/, /^Codex/, /^自定义命令…/]) await expect(createMenu.getByRole('menuitem', { name })).toBeVisible();
  await createMenu.getByRole('menuitem', { name: /^空白终端/ }).click();
  await expect(view(page)).toHaveAttribute('data-connection', 'connected');
  const [record] = await list();
  expect(record!.projectId).toBeNull();
  expect(record!.directory).toMatch(/multivac-dev-155-e2e-work-[^/]+\/terminals$/);
  const row = daily.locator(`[data-terminal-id="${record!.terminalId}"]`);
  await expect(daily.locator('.rail-group-items .rail-item').first()).toHaveAttribute('data-terminal-id', record!.terminalId);

  await selectWorkspaceLayout(page, 2);
  await ensureWorkspaceRail(page);
  await row.hover(); await row.locator('.rail-more').click();
  await page.getByRole('menu', { name: '终端操作：终端' }).getByRole('menuitem', { name: '放进第 2 栏' }).click();
  await expect(view(page).locator('.slot-tag')).toHaveText('第 2 栏');
  await expect(page.locator('.workspace-page .conversation-panel:visible')).toHaveCount(1);
  await view(page).getByRole('button', { name: '放大「终端」' }).click();
  await expect(view(page).getByRole('button', { name: '返回并排' })).toBeVisible();
  await expect(page.locator('.workspace-page .conversation-panel:visible')).toHaveCount(0);
  await expect(view(page)).toHaveAttribute('data-connection', 'connected');
  await command(page, 'pwd');
  await expect.poll(async () => (await output(page)).split('\n').map(line => line.trim())).toContain(record!.directory);

  await command(page, "printf 'DAILY-%s\\n' BEFORE-REFRESH");
  await expect.poll(() => output(page)).toContain('DAILY-BEFORE-REFRESH');
  await page.reload();
  await expect(view(page)).toHaveAttribute('data-connection', 'connected');
  await expect(view(page)).toHaveAttribute('data-terminal-id', record!.terminalId);
  await expect.poll(() => output(page)).toContain('DAILY-BEFORE-REFRESH');
  expect((await list())[0]!.instanceId).toBe(record!.instanceId);
  await view(page).getByRole('button', { name: '返回并排' }).click();
  await expect(view(page).locator('.slot-tag')).toHaveText('第 2 栏');

  // 项目创建后，两种终端只出现在各自工作区。用 Command+K 从项目切回日常。
  const created = await request.post(`${fakeApiRoot}/api/projects`, { data: { name: '终端分组项目' } });
  expect(created.status()).toBe(201);
  const { project } = await created.json();
  const projectGroup = page.locator(`[data-workspace-id="${project.projectId}"]`);
  await ensureWorkspaceRail(page);
  await projectGroup.getByRole('button', { name: '在「终端分组项目」新建会话或终端' }).click();
  await createMenu.getByRole('menuitem', { name: /^空白终端/ }).click();
  await expect(projectGroup.locator('.rail-folder')).toHaveClass(/active/);
  await expect(projectGroup.locator('[data-terminal-id]')).toHaveCount(1);
  await expect(daily.locator('[data-terminal-id]')).toHaveCount(1);
  const [projectRecord] = await list(project.projectId);
  expect(projectRecord!.directory).toBe(project.directories[0].path);
  const palette = page.getByRole('dialog', { name: '跳到会话' });
  await page.keyboard.press('Meta+k');
  await palette.getByRole('combobox').fill('默认工作区 终端');
  await expect(palette.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(daily.locator('.rail-folder')).toHaveClass(/active/);
  const dailyView = page.locator(`.terminal-view[data-terminal-id="${record!.terminalId}"]`);
  await expect(dailyView).toHaveAttribute('data-connection', 'connected');

  await menuAction(page, '结束进程');
  await expect(dailyView).toContainText('用户结束');
  await dailyView.getByRole('button', { name: '重新打开终端' }).click();
  await expect(dailyView).toHaveAttribute('data-connection', 'connected');
  const [reopened] = await list();
  expect(reopened!.instanceId).not.toBe(record!.instanceId);
  expect(reopened!.directory).toBe(record!.directory);
  await menuAction(page, '关闭终端');
  await page.getByRole('dialog', { name: '关闭「终端」' }).getByRole('button', { name: '结束并关闭' }).click();
  await expect(row).toHaveCount(0);
  await page.keyboard.press('Meta+k');
  await palette.getByRole('combobox').fill('默认工作区 终端');
  await expect(palette.getByRole('option')).toHaveCount(0);
  expect(await list()).toEqual([]);
  await page.keyboard.press('Escape');

  await ensureWorkspaceRail(page);
  await create.click();
  await createMenu.getByRole('menuitem', { name: /^自定义命令…/ }).click();
  const dialog = page.getByRole('dialog', { name: '新建终端' });
  await expect(dialog.getByRole('radio', { name: '自定义命令' })).toBeChecked();
  await expect(dialog.getByLabel('终端目录')).toHaveCount(0);
  await dialog.getByLabel('终端命令').fill('/bin/echo DAILY-CUSTOM');
  await dialog.getByRole('button', { name: '启动', exact: true }).click();
  await expect.poll(() => output(page)).toContain('DAILY-CUSTOM');
  const [custom] = await list();
  expect(custom!.directory).toBe(record!.directory);
});

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
  await group.getByRole('button', { name: '在「终端验收」新建会话或终端', exact: true }).click();
  // 只有一个项目目录时，预设直接启动，不经创建卡。
  await page.getByRole('menuitem', { name: /^空白终端/ }).click();
  await expect(view(page)).toBeVisible(); await expect(view(page)).toHaveAttribute('data-owner', 'true');
  await expect(view(page).getByRole('button', { name: `终端目录：不受管控 ${project.directories[0].path}` })).toBeVisible();
  await command(page, "printf '\\nBROWSER-%s\\n' ECHO");
  await expect.poll(() => output(page)).toContain('BROWSER-ECHO');
  // 改名与会话一致，在侧栏“更多”菜单中。
  const row = page.locator('.rail-item[data-terminal-id]'); await row.hover(); await row.locator('.rail-more').click();
  await page.getByRole('menuitem', { name: '改名', exact: true }).click();
  await row.getByLabel('终端名称').fill('验收 shell'); await row.getByRole('button', { name: '保存名称' }).click();
  await expect(view(page).getByRole('heading', { name: '验收 shell', exact: true })).toBeVisible();
  await page.reload(); await expect(view(page)).toHaveAttribute('data-connection', 'connected'); await expect.poll(() => output(page)).toContain('BROWSER-ECHO');
  const second = await context.newPage(); await second.goto('/'); await openPanel(second, 'workspace'); await ensureWorkspaceRail(second);
  await second.locator('.rail-item[data-terminal-id] .rail-session-open').click();
  await expect(view(second)).toHaveAttribute('data-owner', 'false'); await expect.poll(() => output(second)).toContain('BROWSER-ECHO');
  // 没有只读状态：聚焦终端即自动接管，原窗口交出输入权。
  await view(second).locator('.xterm-helper-textarea').focus();
  await expect(view(second)).toHaveAttribute('data-owner', 'true'); await expect(view(page)).toHaveAttribute('data-owner', 'false');
  await command(second, "for i in 1 2 3 4 5 6 7 8 9 10; do printf 'OFFLINE-%s\\n' $i; sleep 0.4; done");
  await context.setOffline(true);
  await expect.poll(async () => {
    const response = await request.post(`${fakeApiRoot}/api/terminals/list`, { headers: { origin: fakeApiRoot }, data: { projectId: project.projectId } });
    return response.ok() && (await response.json()).terminals[0].unread;
  }).toBeTruthy();
  await context.setOffline(false);
  await expect.poll(() => output(second), { timeout: 10000 }).toContain('OFFLINE-10');
  const lines = (await output(second)).split('\n'); for (let i = 1; i <= 10; i++) expect(lines.filter(line => line.trim() === `OFFLINE-${i}`)).toHaveLength(1);
  // 断线释放拥有者，再次聚焦即重新接管。
  await view(second).locator('.xterm-helper-textarea').blur(); await view(second).locator('.xterm-helper-textarea').focus();
  await expect(view(second)).toHaveAttribute('data-owner', 'true');
  await menuAction(second, '终端全屏');
  await expect.poll(() => second.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await expect(view(second).getByRole('button', { name: /^终端目录：不受管控/ })).toHaveAttribute('title', /外部程序：Multivac 不管控/);
  await second.screenshot({ path: 'artifacts/terminals/browser-fullscreen.png' });
  await view(second).getByRole('button', { name: '退出终端全屏' }).click();
  await command(second, 'exit 1'); await expect(view(second)).toContainText('退出码 1');
  await second.screenshot({ path: 'artifacts/terminals/browser-exit.png' });
  await view(second).getByRole('button', { name: '重新打开终端' }).click(); await expect(view(second)).toHaveAttribute('data-connection', 'connected');
  await expect.poll(() => output(second)).not.toContain('BROWSER-ECHO');
  await menuAction(second, '关闭终端');
  const confirm = second.getByRole('dialog', { name: '关闭「验收 shell」' }); await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '取消', exact: true }).click(); await expect(view(second)).toBeVisible();
  await menuAction(second, '结束进程'); await expect(view(second)).toContainText('用户结束');
  // 关闭即移除：视图与侧栏中都不再出现。
  await view(second).getByRole('button', { name: '关闭终端', exact: true }).click(); await expect(view(second)).toHaveCount(0);
  await expect(second.locator('.rail-item[data-terminal-id]')).toHaveCount(0);
  await second.close();
});

test('终端创建卡：长目录不撑出卡片，命令解析错误保留输入且可保存为常用命令', async ({ page, request }, info) => {
  test.skip(process.platform !== 'darwin' || process.arch !== 'arm64');
  await resetE2eState(request);
  const name = '用于检查终端创建卡长目录和自定义命令输入的项目';
  const created = await request.post(`${fakeApiRoot}/api/projects`, { data: { name } }); expect(created.status()).toBe(201);
  await page.setViewportSize({ width: 1280, height: 720 }); await page.goto('/');
  await expect(page.getByRole('button', { name: '快捷键', exact: true })).toBeVisible();
  await openPanel(page, 'workspace'); await ensureWorkspaceRail(page);
  await page.getByRole('button', { name: `在「${name}」新建会话或终端`, exact: true }).click();
  await page.getByRole('menuitem', { name: /^自定义命令…/ }).click();
  const dialog = page.getByRole('dialog', { name: '新建终端' });
  await expect(dialog.getByRole('radio', { name: '自定义命令' })).toBeChecked();
  await dialog.getByLabel('终端命令').fill("/bin/sh -c 'broken");
  await dialog.getByLabel('保存为常用命令').check();
  await expect(dialog.getByLabel('保存为常用命令')).toBeChecked();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole('button', { name: '启动', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('命令中的引号没有闭合。');
  await expect(dialog.getByLabel('终端命令')).toHaveValue("/bin/sh -c 'broken");
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('terminal-create-invalid-command.png') });
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
});
