import { expect, test, type Locator, type Page } from '@playwright/test';
import type { CurrentViewSnapshot } from '@multivac/contracts';
import { fakeApiRoot, openPanel, resetE2eState, ensureWorkspaceRail, selectWorkspaceLayout, setWorkspaceMode } from './test-state.js';

/** 发送真实快照并经 Fake 调用真实查询工具；不向终端输入。 */
async function inspectView(page: Page, scope: Locator, turnPath = '/api/assistant/turns'): Promise<CurrentViewSnapshot> {
  const callId = crypto.randomUUID();
  const finished = page.waitForResponse(response => new URL(response.url()).pathname === turnPath && response.request().postData()?.includes(callId) === true);
  const sent = page.waitForRequest(request => new URL(request.url()).pathname === turnPath && request.method() === 'POST');
  const composer = scope.getByLabel('Multivac 草稿');
  await composer.fill(`内部工具：get_current_view#${callId}`);
  await composer.press('Enter');
  const request = await sent;
  expect((await finished).ok()).toBe(true);
  await expect(scope.locator('article.chat-row.assistant').last()).toContainText('当前面板：');
  await expect(scope.getByRole('button', { name: '取消当前处理', exact: true })).toHaveCount(0);
  return request.postDataJSON().view;
}

const sidebar = (page: Page) => page.locator('.multivac-sidebar');
const home = (page: Page) => page.locator('.work-surface').first();

test('终端快照：可见且选中才报告，切回会话、管理、首页或窄屏不遗留终端焦点', async ({ page, request }) => {
  test.skip(process.platform !== 'darwin' || process.arch !== 'arm64');
  test.setTimeout(45000);
  await resetE2eState(request);
  const created = await request.post(`${fakeApiRoot}/api/projects`, { data: { name: '终端快照验收' } });
  expect(created.status()).toBe(201);
  const { project } = await created.json();
  const opened = await request.post(`${fakeApiRoot}/api/terminals`, { headers: { origin: fakeApiRoot }, data: {
    projectId: project.projectId, directory: project.directories[0].path, preset: { kind: 'blank' }, size: { cols: 80, rows: 24 }, title: '可见焦点终端',
  } });
  expect(opened.ok()).toBe(true);
  const { terminal } = await opened.json();
  const sessionId = 'terminal-snapshot-work';
  expect((await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: '并排会话', workspaceId: project.projectId } })).status()).toBe(201);
  // 并排保留一个会话和一个终端；初始只有会话被选中。
  await page.addInitScript(({ workspaceId, terminalId }) => {
    localStorage.setItem('multivac.workspace.current', workspaceId);
    sessionStorage.setItem('multivac.terminal-columns', JSON.stringify({ [workspaceId]: { 1: terminalId } }));
    sessionStorage.setItem('multivac.selected-terminal', 'null');
  }, { workspaceId: project.projectId, terminalId: terminal.terminalId });
  try {
    await page.goto('/');
    await expect(home(page).getByLabel('Multivac 草稿')).toBeEditable();
    await openPanel(page, 'workspace');
    await ensureWorkspaceRail(page);
    const group = page.locator(`[data-workspace-id="${project.projectId}"]`);
    await group.locator('.rail-folder-toggle').click();
    await selectWorkspaceLayout(page, 2);
    await expect(page.locator('.terminal-view')).toBeVisible();
    const conversation = page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: '并排会话', exact: true }) });
    await expect(conversation).toBeVisible();
    await conversation.getByRole('heading', { name: '并排会话', exact: true }).click();
    await page.keyboard.press('ControlOrMeta+J');
    expect((await inspectView(page, sidebar(page))).workspace?.terminalId).toBeUndefined();
    // 终端可见且选中，向侧栏发送时仍保留工作区的对象焦点。
    await page.locator('.terminal-view').getByRole('heading', { name: '可见焦点终端', exact: true }).click();
    expect((await inspectView(page, sidebar(page))).workspace?.terminalId).toBe(terminal.terminalId);
    await expect(sidebar(page).locator('article.chat-row.assistant').last()).toContainText('当前焦点终端：');
    await expect(sidebar(page).locator('article.chat-row.assistant').last()).not.toContainText('当前焦点会话：');
    await conversation.getByRole('heading', { name: '并排会话', exact: true }).click();
    expect((await inspectView(page, sidebar(page))).workspace?.terminalId).toBeUndefined();
    const workView = await inspectView(page, conversation, `/api/sessions/${sessionId}/turns`);
    expect(workView.workspace?.terminalId).toBeUndefined();
    await expect(conversation.locator('article.chat-row.assistant').last()).toContainText('当前面板：工作区');
    // 单独查看终端也报告；离开工作区后清除快照中的终端字段。
    await setWorkspaceMode(page, 'focus');
    await group.locator(`[data-terminal-id="${terminal.terminalId}"] .rail-session-open`).click();
    await expect(page.locator('.terminal-view')).toHaveClass(/focused/);
    await expect(conversation).toBeHidden();
    expect((await inspectView(page, sidebar(page))).workspace?.terminalId).toBe(terminal.terminalId);
    await openPanel(page, 'management');
    expect((await inspectView(page, sidebar(page))).workspace?.terminalId).toBeUndefined();
    await openPanel(page, 'home');
    expect((await inspectView(page, home(page))).workspace?.terminalId).toBeUndefined();
    await openPanel(page, 'workspace');
    await expect(page.locator('.terminal-view')).toBeVisible();
    await page.setViewportSize({ width: 700, height: 900 });
    const notice = page.getByRole('region', { name: '工作区请在桌面使用' });
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: '回到 Multivac', exact: true }).click();
    const narrow = await inspectView(page, home(page));
    expect(narrow.narrow).toBe(true);
    expect(narrow.workspace?.terminalId).toBeUndefined();
  } finally {
    await request.post(`${fakeApiRoot}/api/terminals/${terminal.terminalId}/end`, { headers: { origin: fakeApiRoot }, data: { instanceId: terminal.instanceId } });
  }
});
