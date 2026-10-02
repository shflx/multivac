import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { fakeApiRoot, openCreationDialog, openPanel, resetE2eState, workspaceRail, currentWorkspaceGroup, ensureWorkspaceRail, setWorkspaceMode, selectWorkspaceLayout } from './test-state.js';

interface CreatedProject {
  project: { projectId: string; name: string; directories: Array<{ kind: string; path: string }> };
  workspace: { workspaceId: string; name: string };
}

interface ListedSession {
  sessionId: string;
  title: string;
  workspaceId: string;
  workingDirectory: { kind: string; path: string };
  archivedAt: string | null;
}

const workspaceBar = (page: Page) => page.locator('.workspace-page');
const switcherTrigger = (page: Page) => workspaceRail(page).locator('.rail-folder.active .rail-folder-toggle');
const switcherMenu = (page: Page) => workspaceRail(page);
const sessionMenu = (page: Page) => currentWorkspaceGroup(page);
const sidebar = (page: Page) => page.locator('.multivac-sidebar');
const sessionsPage = (page: Page) => page.getByRole('main', { name: '归档' });
const sessionList = (page: Page) => sessionsPage(page).getByRole('list', { name: '归档会话列表' });
const detail = (page: Page) => sessionsPage(page).locator('.session-detail');

function panel(page: Page, title: string) {
  return page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

function row(page: Page, title: string) {
  return sessionList(page).getByRole('button').filter({ has: page.getByText(title, { exact: true }) });
}

async function createProject(request: APIRequestContext, name: string, directory?: string): Promise<CreatedProject> {
  const response = await request.post(`${fakeApiRoot}/api/projects`, { data: { name, ...(directory ? { directory } : {}) } });
  expect(response.status()).toBe(201);
  return await response.json() as CreatedProject;
}

async function createSessionByApi(request: APIRequestContext, sessionId: string, title: string, workspaceId?: string) {
  const response = await request.post(`${fakeApiRoot}/api/sessions`, {
    data: { sessionId, title, ...(workspaceId ? { workspaceId } : {}) },
  });
  expect(response.status()).toBe(201);
}

async function listSessions(request: APIRequestContext): Promise<ListedSession[]> {
  const response = await request.get(`${fakeApiRoot}/api/sessions?workspace=all&archived=include`);
  expect(response.ok()).toBe(true);
  return (await response.json() as { sessions: ListedSession[] }).sessions;
}

async function createSession(page: Page, title: string, note: string | RegExp): Promise<void> {
  await openCreationDialog(page);
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await expect(dialog.locator('.creation-note')).toContainText(note);
  await dialog.getByLabel('会话名称').fill(title);
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).toHaveCount(0);
}

async function switchWorkspace(page: Page, name: string): Promise<void> {
  await ensureWorkspaceRail(page);
  await switcherMenu(page).getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await expect(switcherTrigger(page)).toContainText(name);
}

async function sessionMenuTitles(page: Page) {
  await ensureWorkspaceRail(page);
  const titles = await sessionMenu(page).locator('.rail-item .rail-session-open .nav-label').allTextContents();
  await ensureWorkspaceRail(page);
  return titles;
}

/** 在会话面板的消息中选中一段文字。 */
async function selectInPanels(page: Page, needle: string): Promise<void> {
  await page.evaluate((text) => {
    for (const host of document.querySelectorAll('.conversation-panel [data-quote-entry-id]')) {
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = node.textContent?.indexOf(text) ?? -1;
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + text.length);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        return;
      }
    }
    throw new Error(`会话面板中未找到：${text}`);
  }, needle);
}

let mountedRoot: string;

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  // 挂载目录用测试自己的临时目录，不触碰用户主目录。
  mountedRoot = mkdtempSync(join(tmpdir(), 'multivac-e2e-mounted-'));
  await page.goto('/');
});

test.afterEach(() => {
  rmSync(mountedRoot, { recursive: true, force: true });
});

test('切换工作区：菜单列出项目工作区与默认工作区及目录；各自的会话与现场原样恢复，项目中新建的会话使用项目目录', async ({ page, request }) => {
  const research = await createProject(request, '技术研究');
  const code = await createProject(request, 'Multivac 开发', mountedRoot);
  const researchDir = research.project.directories[0]!.path;
  await page.reload();
  await openPanel(page, 'workspace');
  await expect(switcherTrigger(page)).toContainText('默认工作区');

  // 默认工作区：两个会话，并排 3 栏、隐藏式布局之外的调整都属于现场。
  await createSession(page, '随手提问', '新会话不属于任何项目，在自己的临时目录里工作。');
  await createSession(page, '临时探索', '临时目录');
  await selectWorkspaceLayout(page, 3);
  await expect(page.locator('.conversation-panel')).toHaveCount(2);

  // 左侧分组按项目、默认工作区排列；目录由真实项目与新建会话验证。
  await ensureWorkspaceRail(page);
  const options = workspaceRail(page).locator('.rail-group:not([data-workspace-id="recent"]) .rail-folder-toggle .nav-label');
  await expect(options).toHaveText(['技术研究', 'Multivac 开发', '默认工作区']);
  await expect(workspaceRail(page).getByRole('button', { name: '新建项目…' })).toBeVisible();

  // 项目工作区：只有它自己的会话；新建的会话以项目目录为工作目录，同一项目的会话共用它。
  await switchWorkspace(page, '技术研究');
  await expect(page.getByRole('heading', { name: '技术研究还没有会话' })).toBeVisible();
  await expect(workspaceRail(page).getByRole('radio', { name: '并排 2 栏', includeHidden: true })).toHaveAttribute('aria-checked', 'true');
  await createSession(page, '资料整理', researchDir);
  await createSession(page, '论文精读', '新会话属于项目“技术研究”');
  expect(await sessionMenuTitles(page)).toEqual(['论文精读', '资料整理']);
  await setWorkspaceMode(page, 'parallel');
  await expect(page.locator('.conversation-panel')).toHaveCount(2);
  await panel(page, '资料整理').getByRole('heading', { name: '资料整理' }).click();
  await expect(panel(page, '资料整理')).toHaveClass(/active/);
  const sessions = await listSessions(request);
  const inResearch = sessions.filter((session) => session.workspaceId === research.workspace.workspaceId);
  expect(inResearch.map((session) => session.workingDirectory)).toEqual([
    { kind: 'project-managed', path: researchDir },
    { kind: 'project-managed', path: researchDir },
  ]);
  expect(sessions.filter((session) => session.workspaceId === 'default').map((session) => session.workingDirectory.kind))
    .toEqual(['session-temp', 'session-temp']);

  // 侧栏的当前焦点会话跟随当前工作区。
  await page.keyboard.press('ControlOrMeta+J');
  await expect(sidebar(page).locator('.composer-context')).toHaveText('正在看「资料整理」，可以直接说“这个”');
  await sidebar(page).getByRole('button', { name: '收起 Multivac' }).click();

  // 挂载项目：新会话在挂载目录中工作。
  await switchWorkspace(page, 'Multivac 开发');
  await createSession(page, '修复恢复', mountedRoot);
  const mounted = (await listSessions(request)).find((session) => session.title === '修复恢复');
  expect(mounted?.workspaceId).toBe(code.workspace.workspaceId);
  expect(mounted?.workingDirectory).toEqual({ kind: 'project-mounted', path: mountedRoot });

  // 切回默认工作区：它的会话与现场（并排 3 栏）原样恢复，看不到项目里的会话。
  await switchWorkspace(page, '默认工作区');
  await expect(workspaceRail(page).getByRole('radio', { name: '并排 3 栏', includeHidden: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.conversation-panel')).toHaveCount(2);
  expect(await sessionMenuTitles(page)).toEqual(['临时探索', '随手提问']);

  // 再切回项目：并排两栏与当前会话原样恢复。
  await switchWorkspace(page, '技术研究');
  await expect(page.locator('.conversation-panel')).toHaveCount(2);
  await expect(panel(page, '资料整理')).toHaveClass(/active/);

  // 刷新后回到上次所在的工作区，现场由服务端恢复。
  await page.reload();
  await openPanel(page, 'workspace');
  await expect(switcherTrigger(page)).toContainText('技术研究');
  await expect(page.locator('.conversation-panel')).toHaveCount(2);
  await expect(panel(page, '资料整理')).toHaveClass(/active/);
  await switchWorkspace(page, '默认工作区');
  await expect(workspaceRail(page).getByRole('radio', { name: '并排 3 栏', includeHidden: true })).toHaveAttribute('aria-checked', 'true');
});

test('挂载目录在归档期间被移走：工作区与会话页恢复失败时写明原因，会话保持归档；放回后恢复成功', async ({ page, request }) => {
  const code = await createProject(request, '挂载项目', mountedRoot);
  await createSessionByApi(request, 'mounted-1', '修复恢复', code.workspace.workspaceId);
  expect((await request.post(`${fakeApiRoot}/api/sessions/mounted-1/archive`)).ok()).toBe(true);
  const away = `${mountedRoot}-moved`;
  renameSync(mountedRoot, away);
  const reason = `未能恢复：工作目录不存在（可能已被移走或删除）：${mountedRoot}。会话保持归档，目录可用后可以重试。`;
  const archived = async () => (await listSessions(request)).find((session) => session.sessionId === 'mounted-1')!;
  try {
    await page.reload();
    await openPanel(page, 'workspace');
    await switchWorkspace(page, '挂载项目');

    await ensureWorkspaceRail(page);
    await sessionMenu(page).getByRole('button', { name: '查看归档' }).click();
    await row(page, '修复恢复').click();
    await detail(page).getByRole('button', { name: '恢复', exact: true }).click();
    await expect(sessionsPage(page).getByRole('alert')).toHaveText(reason);
    expect((await archived()).archivedAt).not.toBeNull();

    // 目录放回原处后重试：恢复成功，会话离开“已归档”筛选。
    renameSync(away, mountedRoot);
    await detail(page).getByRole('button', { name: '恢复', exact: true }).click();
    await expect(row(page, '修复恢复')).toHaveCount(0);
    expect((await archived()).archivedAt).toBeNull();
  } finally {
    if (existsSync(away)) renameSync(away, mountedRoot);
  }
});
