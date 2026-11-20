import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    // 真实浏览器调用只读 query，直接阅读当前受管理 shell 的权威画面；不输入终端。
    const screenTurn = page.waitForResponse(response => new URL(response.url()).pathname === '/api/assistant/turns' &&
      response.request().postData()?.includes('read_terminal_screen') === true);
    await sidebar(page).getByLabel('Multivac 草稿').fill(`内部工具：read_terminal_screen ${JSON.stringify({ terminalId: terminal.terminalId })}`);
    await sidebar(page).getByLabel('Multivac 草稿').press('Enter');
    expect((await screenTurn).ok()).toBe(true);
    await expect(sidebar(page).locator('article.chat-row.assistant').last()).toContainText('authoritative-text');
    await expect(sidebar(page).getByRole('button', { name: '取消当前处理', exact: true })).toHaveCount(0);
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

test('最近原地接回项目终端，与会话分栏并按各自目录工作', async ({ page, request }) => {
  test.skip(process.platform !== 'darwin' || process.arch !== 'arm64');
  test.setTimeout(60_000);
  await resetE2eState(request);
  const attachment = realpathSync(mkdtempSync(join(tmpdir(), 'multivac-recent-terminal-')));
  const headers = { origin: fakeApiRoot };
  const options = { headers };
  const terminalPath = `${fakeApiRoot}/api/terminals`;
  const size = { cols: 80, rows: 24 };
  try {
    const created = await request.post(`${fakeApiRoot}/api/projects`, { data: { name: '最近多目录项目' } });
    expect(created.status()).toBe(201);
    const { project } = await created.json();
    const owner = project.projectId;
    const primary = project.directories[0].path;
    expect((await request.patch(`${fakeApiRoot}/api/projects/${owner}`, { data: { directories: [primary, attachment] } })).ok()).toBe(true);
    const list = async (workspaceId: string) => {
      const response = await request.post(`${terminalPath}/list`, { ...options, data: { workspaceId } });
      expect(response.ok()).toBe(true);
      return (await response.json()).terminals;
    };
    const dailyCreated = await request.post(terminalPath, { ...options, data: {
      workspaceId: 'default', preset: { kind: 'custom', executable: '/usr/bin/true', argv: [] }, size, title: '已退出日常终端',
    } });
    expect(dailyCreated.ok()).toBe(true);
    const { terminal: daily } = await dailyCreated.json();
    await expect.poll(async () => (await list('default'))[0]?.status).toBe('exited');
    const sessionId = 'recent-terminal-neighbor';
    const sessionTitle = '最近并排会话';
    expect((await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: sessionTitle, workspaceId: owner } })).status()).toBe(201);
    const terminalTitle = '附加目录终端';
    const opened = await request.post(terminalPath, { ...options, data: {
      projectId: owner, directory: attachment, preset: { kind: 'blank' }, size, title: terminalTitle,
    } });
    expect(opened.ok()).toBe(true);
    const { terminal } = await opened.json();

    await page.goto('/');
    await openPanel(page, 'workspace');
    await ensureWorkspaceRail(page);
    const recent = page.locator('[data-workspace-id="recent"]');
    const projectGroup = page.locator(`[data-workspace-id="${owner}"]`);
    const selectGroup = async (group: Locator) => {
      await ensureWorkspaceRail(page);
      await group.locator('.rail-folder-toggle').click();
      await expect(group.locator('.rail-folder')).toHaveClass(/active/);
    };
    const assign = async (group: Locator, slot: number) => {
      await ensureWorkspaceRail(page);
      await group.getByRole('button', { name: `更多「${terminalTitle}」` }).click();
      await page.getByRole('menuitem', { name: `放进第 ${slot} 栏` }).click();
    };
    const terminalPane = page.locator(`.terminal-view[data-terminal-id="${terminal.terminalId}"]`);
    const slot = terminalPane.locator('.slot-tag');
    const sessionPane = page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: sessionTitle }) });
    let check = 0;
    const pwd = async (path: string) => {
      await expect(terminalPane).toHaveAttribute('data-connection', 'connected');
      await terminalPane.locator('.xterm-helper-textarea').focus();
      const suffix = `-END-${++check}`;
      await page.keyboard.insertText(`printf '\\n%s%s%s\\n' 'CWD-' "$(pwd -P)" '${suffix}'`);
      await page.keyboard.press('Enter');
      // 窄栏可能换行，标记只匹配本次命令的结果。
      await expect.poll(async () => (await terminalPane.locator('.xterm-rows > div').allTextContents()).map(line => line.trim()).join('')).toContain(`CWD-${path}${suffix}`);
    };
    const mixed = recent.locator('.rail-item');
    await expect(mixed).toHaveCount(3);
    await expect(mixed.nth(0)).toHaveAttribute('data-terminal-id', terminal.terminalId);
    await expect(mixed.nth(0).locator('.rail-owner')).toHaveText('最近多目录项目');
    await expect(mixed.nth(1)).toHaveAttribute('data-session-id', sessionId);
    await expect(mixed.nth(2)).toHaveAttribute('data-terminal-id', daily.terminalId);
    await expect(mixed.nth(2)).toHaveClass(/ended/);

    await selectGroup(projectGroup);
    await assign(projectGroup, 1);
    await expect(slot).toHaveText('第 1 栏');
    await pwd(attachment);
    await page.keyboard.insertText('cd /');
    await page.keyboard.press('Enter');
    await pwd('/');

    await ensureWorkspaceRail(page);
    await recent.getByRole('button', { name: terminalTitle, exact: true }).click();
    await expect(recent.locator('.rail-folder')).toHaveClass(/active/);
    await expect(terminalPane).toHaveClass(/focused/);
    await pwd('/');
    expect((await list(owner))[0].instanceId).toBe(terminal.instanceId);
    await assign(recent, 2);
    await expect(slot).toHaveText('第 2 栏');
    await expect(sessionPane.locator('.slot-tag')).toHaveText('第 1 栏');
    await expect(sessionPane.getByRole('button', { name: `工作目录：项目托管目录 ${primary}` })).toBeVisible();
    await expect(terminalPane.getByRole('button', { name: `终端目录：不受管控 ${attachment}` })).toBeVisible();

    await selectGroup(projectGroup);
    await expect(slot).toHaveText('第 1 栏');
    await selectGroup(recent);
    await expect(slot).toHaveText('第 2 栏');
    await terminalPane.getByRole('heading', { name: terminalTitle }).click();
    await page.keyboard.press('ControlOrMeta+J');
    const snapshot = await inspectView(page, sidebar(page));
    expect(snapshot.workspace?.workspaceId).toBe('recent');
    expect(snapshot.workspace?.terminalId).toBe(terminal.terminalId);
    await expect(sidebar(page).locator('article.chat-row.assistant').last()).toContainText(`"workspaceId":"${owner}"`);
    await terminalPane.getByRole('button', { name: `放大「${terminalTitle}」` }).click();
    await expect(sessionPane).toHaveCount(0);
    await selectGroup(projectGroup);
    await expect(slot).toHaveText('第 1 栏');
    await selectGroup(recent);
    await expect(terminalPane).toHaveClass(/focused/);
    await terminalPane.getByRole('button', { name: '返回并排' }).click();
    await expect(sessionPane).toBeVisible();

    expect((await request.post(`${terminalPath}/${terminal.terminalId}/end`, { ...options, data: { instanceId: terminal.instanceId } })).ok()).toBe(true);
    await expect(recent.locator(`[data-terminal-id="${terminal.terminalId}"]`)).toHaveClass(/ended/);
    await terminalPane.getByRole('button', { name: '重新打开终端' }).click();
    await expect.poll(async () => (await list(owner))[0]?.instanceId).not.toBe(terminal.instanceId);
    await pwd(attachment);
    const [reopened] = await list(owner);
    expect(reopened.projectId).toBe(owner);
    expect(reopened.directory).toBe(attachment);
    expect((await request.post(`${terminalPath}/${terminal.terminalId}/close`, { ...options, data: { instanceId: reopened.instanceId, confirmRunning: true } })).ok()).toBe(true);
    await expect(recent.locator(`[data-terminal-id="${terminal.terminalId}"]`)).toHaveCount(0);
    await expect(terminalPane).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('multivac.terminal-columns') ?? '{}').recent)).toEqual({});
  } finally {
    try { await resetE2eState(request); }
    finally { rmSync(attachment, { recursive: true, force: true }); }
  }
});
