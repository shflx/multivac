import { expect, test, type Page } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState, ensureWorkspaceRail } from './test-state.js';
const screen = (page: Page) => page.locator('.terminal-view .xterm-rows');
for (const cli of ['claude', 'codex'] as const) test(`真实已登录 ${cli}：交互输入、刷新与第二窗口接回`, async ({ page, request, context }) => {
  test.skip(process.env.MULTIVAC_TERMINAL_CLI_E2E !== '1' || process.platform !== 'darwin' || process.arch !== 'arm64');
  test.setTimeout(60000);
  await resetE2eState(request);
  const created = await request.post(`${fakeApiRoot}/api/projects`, { data: { name: `${cli} 实机验收` } }); expect(created.status()).toBe(201);
  const { project } = await created.json();
  await page.goto('/'); await openPanel(page, 'workspace'); await ensureWorkspaceRail(page);
  const group = page.locator(`[data-workspace-id="${project.projectId}"]`);
  await group.locator('.rail-folder-toggle').click(); await group.getByRole('button', { name: /新建会话/ }).click();
  await group.getByRole('button', { name: cli === 'claude' ? 'Claude Code' : 'Codex', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `在「${cli} 实机验收」新建终端` });
  await expect(dialog.getByLabel('终端预设')).toHaveValue(cli);
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/terminals' && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '启动终端' }).click();
  const response = await responsePromise; expect(response.status()).toBe(200); const { terminal } = await response.json();
  try {
    await expect(page.locator('.terminal-view')).toContainText('已连接');
    await expect.poll(async () => (await screen(page).innerText()).length, { timeout: 20000 }).toBeGreaterThan(30);
    await page.screenshot({ path: `artifacts/terminals/${cli}-initial.png` });
    console.log(`${cli}: 已捕获真实 CLI 初始画面`);
    let text = await screen(page).innerText();
    if (/trust this|trust the|Trust this|Yes, I trust|Yes, continue|是否信任|信任此/i.test(text)) {
      await page.locator('.terminal-view .xterm-helper-textarea').focus();
      if (/❯ No, exit/.test(text)) {
        await page.keyboard.press('ArrowDown');
        await expect.poll(() => screen(page).innerText()).toMatch(/❯ Yes, I trust/);
      }
      await page.keyboard.press('Enter');
    }
    // 使用 CLI 自带 /help 验证真实交互，不发起模型工具工作。
    await expect.poll(() => screen(page).innerText(), { timeout: 20000 }).not.toMatch(/Quick safety check/);
    await page.locator('.terminal-view .xterm-helper-textarea').focus(); await page.keyboard.type('/help', { delay: 80 }); await page.keyboard.press('Enter');
    await expect.poll(() => screen(page).innerText(), { timeout: 20000 }).toMatch(cli === 'claude' ? /help|commands|shortcuts/i : /help|commands|shortcuts/i);
    await page.screenshot({ path: `artifacts/terminals/${cli}-interactive.png` });
    await page.reload(); await expect(page.locator('.terminal-view')).toContainText('已连接');
    await expect.poll(async () => (await screen(page).innerText()).length).toBeGreaterThan(30);
    await page.screenshot({ path: `artifacts/terminals/${cli}-refreshed.png` });
    const second = await context.newPage(); await second.goto('/'); await openPanel(second, 'workspace'); await ensureWorkspaceRail(second);
    await second.locator(`[data-terminal-id="${terminal.terminalId}"] button`).click();
    await expect(second.locator('.terminal-view')).toContainText('只读跟随');
    await expect.poll(async () => (await screen(second).innerText()).length).toBeGreaterThan(30);
    await second.screenshot({ path: `artifacts/terminals/${cli}-second-window.png` });
    await second.locator('.terminal-view').getByRole('button', { name: '接管终端' }).click();
    await expect(second.locator('.terminal-view')).toContainText('此窗口可输入');
    await expect(page.locator('.terminal-view')).toContainText('只读跟随'); await second.close();
  } finally {
    const stopped = await request.post(`${fakeApiRoot}/api/terminals/${terminal.terminalId}/end`, { headers: { origin: fakeApiRoot }, data: { instanceId: terminal.instanceId } }); expect([200, 409]).toContain(stopped.status());
    const actual = await request.post(`${fakeApiRoot}/api/terminals/${terminal.terminalId}/get`, { headers: { origin: fakeApiRoot }, data: {} });
    expect((await actual.json()).terminal.status).toBe('exited');
  }
});
