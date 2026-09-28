import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';

interface CreatedProject {
  project: { projectId: string; name: string; directories: Array<{ kind: string; path: string }> };
  workspace: { workspaceId: string; name: string };
}

interface ListedSession {
  sessionId: string;
  title: string;
  workspaceId: string;
  workingDirectory: { kind: string; path: string };
}

const workspaceBar = (page: Page) => page.getByRole('toolbar', { name: '工作区' });
const switcherTrigger = (page: Page) => workspaceBar(page).getByRole('button', { name: /^工作区/ });
const switcherMenu = (page: Page) => page.getByRole('dialog', { name: '切换工作区' });
const sessionMenu = (page: Page) => page.getByRole('dialog', { name: '工作区会话' });
const sidebar = (page: Page) => page.locator('.workspace-shell .multivac-sidebar');
const sessionsPage = (page: Page) => page.getByRole('main', { name: '会话' });
const sessionList = (page: Page) => sessionsPage(page).getByRole('list', { name: '会话列表' });
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
  await workspaceBar(page).getByRole('button', { name: '新会话' }).click();
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await expect(dialog.locator('.creation-note')).toContainText(note);
  await dialog.getByLabel('会话名称').fill(title);
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).toHaveCount(0);
}

async function switchWorkspace(page: Page, name: string): Promise<void> {
  await switcherTrigger(page).click();
  await switcherMenu(page).getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await expect(switcherMenu(page)).toHaveCount(0);
  await expect(switcherTrigger(page)).toContainText(name);
}

async function sessionMenuTitles(page: Page) {
  await workspaceBar(page).getByRole('button', { name: /^会话/ }).click();
  const titles = await sessionMenu(page).locator('.scene-row .conversation-menu-name strong').allTextContents();
  await workspaceBar(page).getByRole('button', { name: /^会话/ }).click();
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
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(switcherTrigger(page)).toContainText('默认工作区');

  // 默认工作区：两个会话，并排 3 栏、隐藏式布局之外的调整都属于现场。
  await createSession(page, '随手提问', '新会话不属于任何项目，在自己的临时目录里工作。');
  await createSession(page, '临时探索', '临时目录');
  await workspaceBar(page).getByRole('combobox', { name: '并排数' }).selectOption('3');
  await expect(page.locator('.conversation-panel')).toHaveCount(2);

  // 切换菜单：项目工作区在前、默认工作区在最后，每项写明目录与会话数。
  await switcherTrigger(page).click();
  const options = switcherMenu(page).locator('.workspace-option');
  await expect(options.locator('strong')).toHaveText(['技术研究', 'Multivac 开发', '默认工作区']);
  await expect(options.nth(0)).toContainText(`项目托管目录 · ${researchDir}`);
  await expect(options.nth(0)).toContainText('0 个会话');
  await expect(options.nth(1)).toContainText(`挂载目录 · ${mountedRoot}`);
  await expect(options.nth(2)).toContainText('不属于项目 · 各会话使用临时目录');
  await expect(options.nth(2)).toContainText('2 个会话');
  await expect(options.nth(2)).toHaveAttribute('aria-current', 'true');
  // 新建项目与项目设置的入口不在本菜单中出现（尚未实现）。
  await expect(switcherMenu(page).getByRole('button', { name: /新建项目|项目设置/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(switcherMenu(page)).toHaveCount(0);
  await expect(switcherTrigger(page)).toBeFocused();

  // 项目工作区：只有它自己的会话；新建的会话以项目目录为工作目录，同一项目的会话共用它。
  await switchWorkspace(page, '技术研究');
  await expect(page.getByRole('heading', { name: '技术研究还没有会话' })).toBeVisible();
  await expect(workspaceBar(page).getByRole('combobox', { name: '并排数' })).toHaveValue('2');
  await createSession(page, '资料整理', researchDir);
  await createSession(page, '论文精读', '新会话属于项目“技术研究”');
  expect(await sessionMenuTitles(page)).toEqual(['论文精读', '资料整理']);
  await workspaceBar(page).getByRole('button', { name: '并排', exact: true }).click();
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
  await sidebar(page).getByRole('button', { name: '展开 Multivac' }).click();
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
  await expect(workspaceBar(page).getByRole('combobox', { name: '并排数' })).toHaveValue('3');
  await expect(page.locator('.conversation-panel')).toHaveCount(2);
  expect(await sessionMenuTitles(page)).toEqual(['临时探索', '随手提问']);

  // 再切回项目：并排两栏与当前会话原样恢复。
  await switchWorkspace(page, '技术研究');
  await expect(page.locator('.conversation-panel')).toHaveCount(2);
  await expect(panel(page, '资料整理')).toHaveClass(/active/);

  // 刷新后回到上次所在的工作区，现场由服务端恢复。
  await page.reload();
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(switcherTrigger(page)).toContainText('技术研究');
  await expect(page.locator('.conversation-panel')).toHaveCount(2);
  await expect(panel(page, '资料整理')).toHaveClass(/active/);
  await switchWorkspace(page, '默认工作区');
  await expect(workspaceBar(page).getByRole('combobox', { name: '并排数' })).toHaveValue('3');
});

test('管理 · 会话按工作区筛选；在工作区打开先切到会话所在的工作区；栈式子会话留在父会话的工作区', async ({ page, request }) => {
  const research = await createProject(request, '技术研究');
  const researchDir = research.project.directories[0]!.path;
  await createSessionByApi(request, 'plain-1', '随手提问');
  await createSessionByApi(request, 'research-1', '资料整理', research.workspace.workspaceId);
  await createSessionByApi(request, 'research-2', '论文精读', research.workspace.workspaceId);
  await page.reload();

  await page.getByRole('button', { name: '打开管理' }).click();
  await expect(sessionList(page)).toBeVisible();
  const filter = sessionsPage(page).getByRole('combobox', { name: '按工作区筛选' });
  await expect(filter.locator('option')).toHaveText(['全部工作区', '技术研究', '默认工作区']);
  await expect(sessionList(page).locator('strong')).toHaveText(['论文精读', '资料整理', '随手提问']);
  await expect(row(page, '资料整理')).toContainText('技术研究 · 顶层会话');
  await expect(row(page, '随手提问')).toContainText('默认工作区 · 顶层会话');

  await filter.selectOption({ label: '技术研究' });
  await expect(sessionList(page).locator('strong')).toHaveText(['论文精读', '资料整理']);
  await row(page, '资料整理').click();
  await expect(detail(page)).toContainText('技术研究');
  await expect(detail(page)).toContainText('项目托管目录');
  await expect(detail(page).locator('code')).toHaveText(researchDir);
  await filter.selectOption({ label: '默认工作区' });
  await expect(sessionList(page).locator('strong')).toHaveText(['随手提问']);
  await filter.selectOption({ label: '技术研究' });

  // 在工作区打开：工作区从未打开过，当前是默认工作区，先切到项目工作区再聚焦。
  await row(page, '资料整理').click();
  await detail(page).getByRole('button', { name: '在工作区打开' }).click();
  await expect(page.locator('.app-shell')).toHaveClass(/work-mode/);
  await expect(switcherTrigger(page)).toContainText('技术研究');
  await expect(page.locator('.conversation-panel')).toHaveCount(1);
  await expect(panel(page, '资料整理')).toBeVisible();
  await expect(panel(page, '资料整理').getByLabel('Multivac 草稿')).toBeFocused();

  // 栈式深入：子会话留在项目工作区，与父会话共用项目目录。
  await panel(page, '资料整理').getByLabel('Multivac 草稿').fill('列出要读的资料');
  await panel(page, '资料整理').getByLabel('发送消息').click();
  await expect(panel(page, '资料整理').getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await selectInPanels(page, 'Fake Multivac 已处理当前消息');
  await page.getByRole('toolbar', { name: '选中内容操作' }).getByRole('button', { name: '深入一层' }).click();
  await expect(panel(page, 'Fake Multivac 已处理当前消息')).toBeVisible();
  const child = (await listSessions(request)).find((session) => session.title === 'Fake Multivac 已处理当前消息');
  expect(child?.workspaceId).toBe(research.workspace.workspaceId);
  expect(child?.workingDirectory).toEqual({ kind: 'project-managed', path: researchDir });

  // 再从会话页打开默认工作区的会话：切回默认工作区。
  await page.getByRole('button', { name: '打开管理' }).click();
  await filter.selectOption({ label: '默认工作区' });
  await row(page, '随手提问').click();
  await detail(page).getByRole('button', { name: '在工作区打开' }).click();
  await expect(switcherTrigger(page)).toContainText('默认工作区');
  await expect(panel(page, '随手提问')).toBeVisible();
  await expect(page.locator('.conversation-panel')).toHaveCount(1);

  // 项目工作区的会话列表里有子会话；它的现场保留了离开时的聚焦。
  await switchWorkspace(page, '技术研究');
  await expect(page.locator('.conversation-panel')).toHaveCount(1);
  await expect(panel(page, 'Fake Multivac 已处理当前消息')).toBeVisible();
  expect(await sessionMenuTitles(page)).toEqual(['Fake Multivac 已处理当前消息', '论文精读', '资料整理']);
});
