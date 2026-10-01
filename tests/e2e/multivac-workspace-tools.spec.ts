import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Project, WorkspaceScene } from '@multivac/contracts';
import { fakeApiRoot, openPanel, resetE2eState, workspaceRail } from './test-state.js';

/**
 * 全局 Multivac 的工作区操作工具（Fake 按消息脚本“内部工具：<名称>#<toolCallId> {JSON 参数}”调用，走真实的注册表、
 * 会话服务、账本与工作台推送）：“切到项目 Y”“把 X 放到第二栏”“并排数调到 3”“打开模型设置”在发起窗口生效，
 * 与界面操作一致；另一个窗口不被切换页面，只同步现场；窄屏时不切换，回执说明已更新保存的现场。
 */

const home = (page: Page) => page.locator('.work-surface').first();
const sidebar = (page: Page) => page.locator('.multivac-sidebar');
const workspaceBar = (page: Page) => page.locator('.workspace-page');
const currentWorkspace = (page: Page) => workspaceRail(page).locator('.rail-folder.active .rail-folder-toggle .nav-label');
const panelTitles = (page: Page) => page.locator('.conversation-panel h2');
const receipt = (scope: Locator, toolCallId: string) => scope.locator(`.tool-receipt[data-tool-call-id="${toolCallId}"]`);
const managementTitle = (page: Page) => page.locator('main.management-page:visible h1');

function panel(page: Page, title: string): Locator {
  return page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

async function send(scope: Locator, text: string): Promise<void> {
  const draft = scope.getByLabel('Multivac 草稿');
  await draft.fill(text);
  await draft.press('Enter');
}

async function openWindow(page: Page): Promise<void> {
  await page.goto('/');
  await expect(home(page).getByLabel('Multivac 草稿')).toBeEditable();
}

/** 按顺序新建会话（新建的排在会话列表前面，空出的栏按这个顺序补位）。 */
async function createSessions(request: APIRequestContext, titles: string[], workspaceId?: string): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const title of titles) {
    const sessionId = `ws-tools-${crypto.randomUUID()}`;
    expect((await request.post(`${fakeApiRoot}/api/sessions`, {
      data: { sessionId, title, ...(workspaceId ? { workspaceId } : {}) },
    })).status()).toBe(201);
    ids[title] = sessionId;
  }
  return ids;
}

async function createProject(request: APIRequestContext, name: string): Promise<Project> {
  const response = await request.post(`${fakeApiRoot}/api/projects`, { data: { name } });
  expect(response.status()).toBe(201);
  return (await response.json() as { project: Project }).project;
}

async function scene(request: APIRequestContext, workspaceId = 'default'): Promise<WorkspaceScene> {
  return await (await request.get(`${fakeApiRoot}/api/workspaces/${workspaceId}/scene`)).json() as WorkspaceScene;
}

test.beforeEach(async ({ request }) => {
  await resetE2eState(request);
  const current = await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json() as { revision: number };
  await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
    data: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: current.revision },
  });
});

test('“切到项目 Y”：发起窗口从首页切到项目的工作区，另一个窗口不被切换；工作区链接可以点开切过去', async ({ page, context, request }) => {
  const project = await createProject(request, '调研项目');
  await createSessions(request, ['项目会话'], project.projectId);
  await openWindow(page);
  // 另一个窗口停在默认工作区。
  const other = await context.newPage();
  await openWindow(other);
  await openPanel(other, 'workspace');
  await expect(currentWorkspace(other)).toHaveText('默认工作区');

  const toolCallId = `e2e-switch-${Date.now()}`;
  await send(home(page), `切到项目调研项目\n内部工具：switch_workspace#${toolCallId} {"workspaceId":"${project.projectId}"}`);

  // 发起窗口切到项目工作区，输入焦点交给它的当前会话；回执写明切到了哪里。
  await expect(workspaceBar(page)).toBeVisible();
  await expect(currentWorkspace(page)).toHaveText('调研项目');
  await expect(panel(page, '项目会话').getByLabel('Multivac 草稿')).toBeFocused();
  const card = receipt(page.locator('body'), toolCallId).first();
  await expect(card.locator('strong')).toHaveText('已切到工作区「调研项目」');

  // 另一个窗口不被切换。
  await expect(currentWorkspace(other)).toHaveText('默认工作区');
  await expect(panelTitles(other)).toHaveCount(0);

  // 回到首页：回复与工具行中的工作区可以点开（切到该工作区，与导航同一路径）。
  await openPanel(page, 'home');
  const listId = `e2e-list-${Date.now()}`;
  await send(home(page), `有哪些工作区\n内部工具：list_workspaces#${listId}`);
  const reply = home(page).locator('article.chat-row.assistant').filter({ hasText: '共 2 个工作区' });
  await expect(reply.getByRole('button', { name: '默认工作区' })).toBeVisible();
  await reply.getByRole('button', { name: '默认工作区' }).click();
  await expect(currentWorkspace(page)).toHaveText('默认工作区');
  await openPanel(page, 'home');
  await home(page).locator('.run-trace').filter({ has: page.locator(`[data-tool-call-id="${listId}"]`) }).locator('summary').click();
  await home(page).locator(`.run-trace-tool[data-tool-call-id="${listId}"]`).getByRole('button', { name: '调研项目' }).click();
  await expect(currentWorkspace(page)).toHaveText('调研项目');
});

test('侧栏中“把 X 放到第二栏”“并排数调到 3”：与界面操作一致，焦点留在侧栏；另一个窗口只同步现场', async ({ page, context, request }) => {
  const ids = await createSessions(request, ['甲', '乙', '丙', '丁']);
  await openWindow(page);
  await openPanel(page, 'workspace');
  await expect(panelTitles(page)).toHaveText(['丁', '丙']);
  // 另一个窗口停在首页：不被切换，现场照常同步。
  const other = await context.newPage();
  await openWindow(other);

  await page.keyboard.press('ControlOrMeta+J');
  const draft = sidebar(page).getByLabel('Multivac 草稿');
  await expect(draft).toBeFocused();
  const placeId = `e2e-place-${Date.now()}`;
  await send(sidebar(page), `把甲放到第二栏\n内部工具：open_session#${placeId} {"sessionId":"${ids['甲']}","slot":2}`);
  await expect(panelTitles(page)).toHaveText(['丁', '甲']);
  await expect(panel(page, '甲')).toHaveClass(/\bactive\b/);
  const placed = receipt(sidebar(page), placeId);
  await expect(placed.locator('strong')).toHaveText('已把「甲」放到第 2 栏');
  await expect(placed).toContainText('原来在第 2 栏的「丙」退出显示（仍在会话列表中）');
  await expect(draft).toBeFocused();

  const countId = `e2e-count-${Date.now()}`;
  await send(sidebar(page), `并排数调到 3\n内部工具：set_parallel_count#${countId} {"count":3}`);
  await expect(panelTitles(page)).toHaveText(['丁', '甲', '丙']);
  await expect(workspaceRail(page).getByRole('radio', { name: '并排 3 栏', includeHidden: true })).toHaveAttribute('aria-checked', 'true');
  await expect(receipt(sidebar(page), countId).locator('strong')).toHaveText('已把「默认工作区」调为并排 3 栏');
  await expect(draft).toBeFocused();

  // 保存的现场与界面一致；另一个窗口仍在首页，进入工作区时看到同样的现场。
  const saved = await scene(request);
  expect(saved.scene.slots).toEqual([ids['丁'], ids['甲'], ids['丙']]);
  expect(saved.scene.focusedSessionId).toBe(ids['甲']);
  await expect(workspaceBar(other)).toBeHidden();
  await expect(home(other).getByLabel('Multivac 草稿')).toBeVisible();
  await openPanel(other, 'workspace');
  await expect(panelTitles(other)).toHaveText(['丁', '甲', '丙']);
});

test('“打开模型设置”与选中会话：发起窗口进入管理的对应页面，另一个窗口不被切换', async ({ page, context, request }) => {
  const ids = await createSessions(request, ['要查看的会话', '别的会话']);
  await openWindow(page);
  const other = await context.newPage();
  await openWindow(other);

  const modelsId = `e2e-models-${Date.now()}`;
  await send(home(page), `打开模型设置\n内部工具：open_management_page#${modelsId} {"page":"models"}`);
  await expect(managementTitle(page)).toHaveText('模型');
  await expect(workspaceBar(other)).toBeHidden();
  await expect(managementTitle(other)).toHaveCount(0);
  await expect(home(other).getByLabel('Multivac 草稿')).toBeVisible();

  // 回执上的“打开设置 · 模型”与面板跳转同一路径。
  await openPanel(page, 'home');
  await receipt(home(page), modelsId).getByRole('button', { name: '打开设置 · 模型' }).click();
  await expect(managementTitle(page)).toHaveText('模型');

  // 打开会话页并选中一个会话（即使它不符合当前筛选）。
  await openPanel(page, 'home');
  const sessionsId = `e2e-sessions-${Date.now()}`;
  await send(home(page), `打开会话页看看要查看的会话\n内部工具：open_management_page#${sessionsId} {"page":"sessions","sessionId":"${ids['要查看的会话']}"}`);
  await expect(managementTitle(page)).toHaveText('会话');
  await expect(page.locator('main.management-page:visible [aria-current="true"]')).toContainText('要查看的会话');
  await expect(managementTitle(other)).toHaveCount(0);
});

test('窄屏：不切换页面，回执说明窄屏下工作区不可用、已更新保存的现场；回到宽屏进入工作区即是新的现场', async ({ page, request }) => {
  const ids = await createSessions(request, ['甲', '乙', '丙']);
  await openWindow(page);
  await page.setViewportSize({ width: 700, height: 900 });
  await expect(page.locator('.app-shell')).toHaveClass(/narrow/);

  const toolCallId = `e2e-narrow-${Date.now()}`;
  await send(home(page), `打开甲\n内部工具：open_session#${toolCallId} {"sessionId":"${ids['甲']}"}`);
  const card = receipt(home(page), toolCallId);
  await expect(card.locator('strong')).toHaveText('已在工作区聚焦「甲」');
  await expect(card).toContainText('窄屏下工作区不可用，已更新保存的现场');
  // 仍在首页，没有出现“工作区请在桌面使用”。
  await expect(home(page).getByLabel('Multivac 草稿')).toBeVisible();
  await expect(page.getByRole('heading', { name: '工作区请在桌面使用' })).toHaveCount(0);
  const switchId = `e2e-narrow-switch-${Date.now()}`;
  await send(home(page), `切到默认工作区\n内部工具：switch_workspace#${switchId} {"workspaceId":"default"}`);
  await expect(home(page).locator('article.chat-row.assistant').filter({ hasText: '窄屏下工作区不可用，没有切换' })).toHaveCount(1);
  await expect(receipt(home(page), switchId)).toHaveCount(0);

  expect((await scene(request)).scene).toMatchObject({ focusedSessionId: ids['甲'], viewMode: 'focus' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.app-shell')).not.toHaveClass(/narrow/);
  await openPanel(page, 'workspace');
  await expect(panelTitles(page)).toHaveText(['甲']);
});
