import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ToolAuthorizationRequest, WorkspaceScene, WorkspaceSceneState } from '@multivac/contracts';
import { fakeApiRoot, openPanel, resetE2eState, currentWorkspaceGroup, ensureWorkspaceRail, selectWorkspaceLayout, railSessionAction, workspaceRail, setWorkspaceMode } from './test-state.js';

/**
 * 工作台变更推送：两个窗口（同一浏览器上下文中的两个页面）之间的改名、归档、恢复、记住的授权与工作区现场
 * 不刷新即互相可见；Multivac 在本窗口发起的一轮中改动会话与现场（经测试控制路由模拟内部工具，走同一套服务），
 * 本窗口同样应用且不把现场写回；草稿、焦点与已打开的面板不受影响。
 *
 * 浏览器对同一主机最多 6 条 HTTP/1.1 长连接；每个窗口只有一条全局事件流（会话事件与工作台变更共用），
 * 两个页面各占一条。
 */

const workspaceBar = (page: Page) => page.locator('.workspace-page');
const sessionMenu = (page: Page) => currentWorkspaceGroup(page);
const sessionsPage = (page: Page) => page.getByRole('main', { name: '会话' });
const sessionList = (page: Page) => sessionsPage(page).getByRole('list', { name: '会话列表' });
const listTitles = (page: Page) => sessionList(page).locator('strong');
const sessionDetail = (page: Page) => sessionsPage(page).locator('.session-detail');
const panelTitles = (page: Page) => page.locator('.conversation-panel h2');

function panel(page: Page, title: string): Locator {
  return page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

function row(page: Page, title: string): Locator {
  return sessionList(page).getByRole('button').filter({ has: page.getByText(title, { exact: true }) });
}

/**
 * 经接口新建会话，返回各自的 id。id 每次运行都不同：重置只删除会话记录，按会话保存的页面现场与授权请求仍在，
 * 重复运行时不能沿用上一次的会话 id。
 */
async function createSessions(request: APIRequestContext, titles: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const title of titles) {
    const sessionId = `sync-${crypto.randomUUID()}`;
    const response = await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title } });
    expect(response.status()).toBe(201);
    ids.push(sessionId);
  }
  return ids;
}

async function readScene(request: APIRequestContext): Promise<WorkspaceScene> {
  return await (await request.get(`${fakeApiRoot}/api/workspaces/default/scene`)).json() as WorkspaceScene;
}

async function putScene(request: APIRequestContext, patch: Partial<WorkspaceSceneState>): Promise<void> {
  const current = await readScene(request);
  const response = await request.put(`${fakeApiRoot}/api/workspaces/default/scene`, { data: { ...current.scene, ...patch } });
  expect(response.ok()).toBe(true);
}

/** 打开一个窗口并等到首页可用。 */
async function openWindow(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
}

async function enterWorkspace(page: Page): Promise<void> {
  await openPanel(page, 'workspace');
  await expect(workspaceBar(page)).toBeVisible();
}

async function openSessionsPage(page: Page): Promise<void> {
  await openPanel(page, 'management');
  await expect(sessionsPage(page)).toBeVisible();
  await expect(sessionList(page)).toBeVisible();
}

/** 本窗口的 id：取自它发出的写请求头（页面现场的保存），与服务端在事件中注明的来源一致。 */
async function typeDraftAndReadWindowId(page: Page, draft: Locator, text: string): Promise<string> {
  const saving = page.waitForRequest((request) => request.method() === 'PUT' && request.url().includes('/page-state'));
  await draft.fill(text);
  const windowId = (await saving).headers()['x-multivac-window-id'];
  expect(windowId).toBeTruthy();
  return windowId!;
}

test.beforeEach(async ({ request }) => {
  await resetE2eState(request);
});

test('两个窗口之间：改名、归档、恢复不刷新即互相可见；另一个窗口的草稿、焦点与已打开的面板不受影响', async ({ page, context, request }) => {
  const [a, b] = await createSessions(request, ['同步甲', '同步乙']);
  await putScene(request, { slots: [a!, b!], focusedSessionId: a!, viewMode: 'parallel' });

  // 窗口 A：工作区并排两栏，在“同步甲”里写着草稿，焦点在输入区。
  await openWindow(page);
  await enterWorkspace(page);
  await expect(panelTitles(page)).toHaveText(['同步甲', '同步乙']);
  const draft = panel(page, '同步甲').getByLabel('Multivac 草稿');
  await draft.fill('写到一半的草稿');
  await expect(draft).toBeFocused();

  // 窗口 B：管理 · 会话页。
  const other = await context.newPage();
  await openWindow(other);
  await openSessionsPage(other);
  await expect(listTitles(other)).toHaveText(['同步乙', '同步甲']);

  // B 改名：A 的栏标题随之更新，草稿与焦点原样。
  await row(other, '同步甲').click();
  await sessionDetail(other).getByRole('button', { name: '改名' }).click();
  const input = sessionDetail(other).getByLabel('会话名称');
  await input.fill('同步甲（改名）');
  await input.press('Enter');
  await expect(panelTitles(page)).toHaveText(['同步甲（改名）', '同步乙']);
  const renamedDraft = panel(page, '同步甲（改名）').getByLabel('Multivac 草稿');
  await expect(renamedDraft).toHaveValue('写到一半的草稿');
  await expect(renamedDraft).toBeFocused();

  // B 归档“同步乙”：A 的第二栏随之移出，第一栏（草稿、焦点）不动。
  await row(other, '同步乙').click();
  await sessionDetail(other).getByRole('button', { name: '归档' }).click();
  await other.getByRole('dialog', { name: '归档「同步乙」' }).getByRole('button', { name: '归档', exact: true }).click();
  await expect(listTitles(other)).toHaveText(['同步甲（改名）']);
  await expect(panelTitles(page)).toHaveText(['同步甲（改名）']);
  await expect(renamedDraft).toHaveValue('写到一半的草稿');
  await expect(renamedDraft).toBeFocused();

  // A 在“已归档”区恢复它：B 的“进行中”列表不刷新就重新列出。
  await ensureWorkspaceRail(page);
  await sessionMenu(page).locator('.rail-archived-toggle').click();
  await sessionMenu(page).getByRole('button', { name: '恢复「同步乙」' }).click();
  await expect(listTitles(other)).toHaveText(['同步乙', '同步甲（改名）']);
  await expect(row(other, '同步乙')).toContainText('默认工作区 · 顶层会话');

  // A 改名：B 的列表与详情随之更新。
  await railSessionAction(page, '同步乙', '改名');
  const rename = sessionMenu(page).getByLabel('会话名称');
  await rename.fill('同步乙（A 改名）');
  await rename.press('Enter');
  await expect(listTitles(other)).toHaveText(['同步乙（A 改名）', '同步甲（改名）']);

  // 服务端与两个窗口一致；刷新后同样如此。
  await other.reload();
  await openSessionsPage(other);
  await expect(listTitles(other)).toHaveText(['同步乙（A 改名）', '同步甲（改名）']);
});

test('两个窗口之间：一个窗口在授权卡上记住的授权，另一个窗口的会话页随之列出；撤销后打开着的标题栏说明不刷新即变为 0 项', async ({ page, context, request }) => {
  const [sessionId] = await createSessions(request, ['授权同步']);

  // 窗口 B 先打开会话页，看着这个会话的“本会话已允许”（此时为空）。
  const other = await context.newPage();
  await openWindow(other);
  await openSessionsPage(other);
  const grants = sessionDetail(other).getByRole('region', { name: '本会话已允许' });
  await expect(grants).toContainText('这个会话还没有记住的授权。');

  // 窗口 A 在会话中越界写入，选择“本会话内允许”：B 不刷新就列出这条授权。
  await openWindow(page);
  await enterWorkspace(page);
  const scope = panel(page, '授权同步');
  await scope.getByLabel('Multivac 草稿').fill('越界写入场景');
  await scope.getByLabel('Multivac 草稿').press('Enter');
  await expect.poll(async () => {
    const response = await request.get(`${fakeApiRoot}/api/sessions/${sessionId}/authorizations`);
    return (await response.json() as { requests: ToolAuthorizationRequest[] }).requests.length;
  }).toBe(1);
  await scope.getByRole('region', { name: /^工具授权：/u }).getByRole('button', { name: '本会话内允许' }).click();
  await expect(scope.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(grants.getByRole('listitem')).toHaveCount(1);

  // A 打开标题栏的工作目录说明并展开授权列表，保持打开。
  await scope.getByRole('button', { name: /^工作目录：/u }).click();
  const directory = page.getByRole('dialog', { name: '本会话的工作目录' });
  await directory.getByRole('button', { name: '本会话已允许 1 项' }).click();
  await expect(directory.getByRole('list', { name: '本会话已允许' }).getByRole('listitem')).toHaveCount(1);

  // B 撤销：A 打开着的说明不刷新就变为 0 项，不再列出。
  await grants.getByRole('listitem').getByRole('button', { name: '撤销' }).click();
  await other.getByRole('dialog', { name: '撤销这项授权？' }).getByRole('button', { name: '撤销', exact: true }).click();
  await expect(grants).toContainText('这个会话还没有记住的授权。');
  await expect(directory).toBeVisible();
  await expect(directory.getByRole('button', { name: '本会话已允许 0 项' })).toBeDisabled();
  await expect(directory.getByRole('list')).toHaveCount(0);
});

test('Multivac 在本窗口发起的一轮中改名会话、调整现场：界面不刷新即更新，不写回现场，草稿与焦点不受影响；之后的本地调整照常保存', async ({ page, request }) => {
  const [a, b, c] = await createSessions(request, ['现场甲', '现场乙', '现场丙']);
  await putScene(request, { parallelCount: 2, slots: [a!, b!], focusedSessionId: a!, viewMode: 'parallel' });
  await openWindow(page);
  await enterWorkspace(page);
  await expect(panelTitles(page)).toHaveText(['现场甲', '现场乙']);
  const draft = panel(page, '现场甲').getByLabel('Multivac 草稿');
  const windowId = await typeDraftAndReadWindowId(page, draft, '甲的草稿');
  await expect(draft).toBeFocused();
  const change = (data: Record<string, unknown>) =>
    request.post(`${fakeApiRoot}/api/__e2e/workbench/multivac-change`, { data: { windowId, commandId: 'e2e-turn', ...data } });

  // 改名：来源是本窗口发出的一轮，但它是 Multivac 做的，本窗口同样应用。
  expect((await change({ action: 'rename', sessionId: b, title: '现场乙（Multivac 改名）' })).ok()).toBe(true);
  await expect(panelTitles(page)).toHaveText(['现场甲', '现场乙（Multivac 改名）']);
  await expect(draft).toHaveValue('甲的草稿');
  await expect(draft).toBeFocused();

  // 现场：并排数调为 3、把“现场丙”放进第 3 栏并设为当前会话。第一栏保持挂载，
  // 新的当前会话高亮但不抢焦点；本窗口不把收到的现场写回。
  const sceneWrites: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/scene')) sceneWrites.push(request.url());
  });
  const applied = await change({
    action: 'scene', workspaceId: 'default',
    scene: { parallelCount: 3, slots: [a, b, c], focusedSessionId: c },
  });
  const appliedRevision = (await applied.json() as WorkspaceScene).revision;
  await expect(panelTitles(page)).toHaveText(['现场甲', '现场乙（Multivac 改名）', '现场丙']);
  await expect(workspaceRail(page).getByRole('radio', { name: '并排 3 栏', includeHidden: true })).toHaveAttribute('aria-checked', 'true');
  await expect(panel(page, '现场丙')).toHaveClass(/active/);
  await expect(panel(page, '现场甲')).not.toHaveClass(/active/);
  await expect(draft).toHaveValue('甲的草稿');
  await expect(draft).toBeFocused();
  await page.waitForTimeout(800);
  expect(sceneWrites).toEqual([]);
  expect((await readScene(request)).revision).toBe(appliedRevision);

  // 之后的本地调整基于新版本保存（不会因版本冲突被拒）。
  await selectWorkspaceLayout(page, 2);
  await expect.poll(async () => (await readScene(request)).scene.parallelCount).toBe(2);
  expect((await readScene(request)).revision).toBe(appliedRevision + 1);
  await expect(panelTitles(page)).toHaveText(['现场甲', '现场丙']);
});

test('两个窗口看着同一个工作区：一个窗口切换当前会话，另一个窗口不刷新即跟着切换，不抢焦点也不写回', async ({ page, context, request }) => {
  const [a, b] = await createSessions(request, ['镜像甲', '镜像乙']);
  // 两个窗口都只打开一个面板（聚焦），给会话事件流留出连接余量。
  await putScene(request, { slots: [a!, b!], focusedSessionId: a!, viewMode: 'focus' });
  await openWindow(page);
  await enterWorkspace(page);
  const other = await context.newPage();
  await openWindow(other);
  // 进入工作区后照常保存一次读到的现场（内容相同，服务端不写入），等它完成再开始记录写请求。
  const initialSave = other.waitForResponse((response) =>
    response.request().method() === 'PUT' && response.url().includes('/scene'));
  await enterWorkspace(other);
  await initialSave;
  await expect(panelTitles(page)).toHaveText(['镜像甲']);
  await expect(panelTitles(other)).toHaveText(['镜像甲']);
  const before = (await readScene(request)).revision;

  // B 的焦点在工作区条的并排数上。
  const count = workspaceRail(other).getByRole('radio', { name: '聚焦：只看当前会话', includeHidden: true });
  await count.focus();
  const otherWrites: string[] = [];
  other.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/scene')) otherWrites.push(request.url());
  });

  // A 从会话列表聚焦查看“镜像乙”：B 跟着切到它，焦点仍在原处；B 不写回。
  await ensureWorkspaceRail(page);
  await sessionMenu(page).locator('.rail-item').filter({ hasText: '镜像乙' }).locator('.rail-session-open').click();
  await expect(panelTitles(page)).toHaveText(['镜像乙']);
  await expect(panelTitles(other)).toHaveText(['镜像乙']);
  await expect(count).toBeFocused();
  await expect.poll(async () => (await readScene(request)).revision).toBe(before + 1);
  await other.waitForTimeout(800);
  expect(otherWrites).toEqual([]);
  expect((await readScene(request)).revision).toBe(before + 1);
});

test('别处新建的会话补进空栏，不挤动正在显示的会话：本窗口与服务端保存的栏位顺序一致', async ({ page, request }) => {
  // 服务端保存的现场没有栏位：进入工作区时补位呈现“补位甲”，并把补位结果保存下来。
  const [first] = await createSessions(request, ['补位甲']);
  await openWindow(page);
  await enterWorkspace(page);
  await expect(panelTitles(page)).toHaveText(['补位甲']);
  await expect.poll(async () => (await readScene(request)).scene.slots).toEqual([first]);

  // 别处新建的会话只补进空栏：“补位甲”仍在第一栏，与读取已保存现场的窗口看到的一致。
  const [second] = await createSessions(request, ['补位乙']);
  await expect(panelTitles(page)).toHaveText(['补位甲', '补位乙']);
  await expect.poll(async () => (await readScene(request)).scene.slots).toEqual([first, second]);
});

test('别处的现场在本窗口的改动尚未保存时到达：以服务端为准应用，本窗口刚做的改动保留并保存在新版本之上', async ({ page, request }) => {
  const [a, b] = await createSessions(request, ['合并甲', '合并乙']);
  await putScene(request, { parallelCount: 2, slots: [a!, b!], focusedSessionId: a!, viewMode: 'parallel' });
  await openWindow(page);
  // 进入工作区后照常保存一次读到的现场（内容相同，服务端不写入），等它完成再拦截保存。
  const initialSave = page.waitForResponse((response) =>
    response.request().method() === 'PUT' && response.url().includes('/scene'));
  await enterWorkspace(page);
  await initialSave;
  await expect(panelTitles(page)).toHaveText(['合并甲', '合并乙']);

  // 本窗口的下一次保存先扣住，让别处的改动在它之前落地。
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  await page.route('**/api/workspaces/default/scene', async (route) => {
    if (route.request().method() === 'PUT' && !held) {
      held = true;
      await released;
    }
    await route.continue();
  });
  const heldSave = page.waitForRequest((request) => request.method() === 'PUT' && request.url().includes('/scene'));

  // 本窗口：聚焦查看“合并乙”（尚未保存）。
  await ensureWorkspaceRail(page);
  await sessionMenu(page).locator('.rail-item').filter({ hasText: '合并乙' }).locator('.rail-session-open').click();
  await setWorkspaceMode(page, 'focus');
  await expect(panelTitles(page)).toHaveText(['合并乙']);
  await heldSave;

  // 别处调整独立的列宽现场，本窗口的聚焦修改保留。
  await putScene(request, { widths: { 2: [0.6, 0.4] } });
  await expect(panelTitles(page)).toHaveText(['合并乙']);

  // 扣住的保存基于旧版本（冲突）：读回后把本窗口的改动保存在新版本之上，两边的改动都在。
  release();
  await expect.poll(async () => {
    const { scene } = (await readScene(request));
    return [scene.focusedSessionId, scene.viewMode, scene.widths[2]];
  }).toEqual([b, 'focus', [0.6, 0.4]]);
  await expect(panelTitles(page)).toHaveText(['合并乙']);
});
