import { existsSync, readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { GLOBAL_ASSISTANT_SESSION_ID, type ToolAuthorizationRequest, type WorkspaceSession } from '@multivac/contracts';
import { fakeApiRoot, openCreationDialog, openPanel, resetE2eState, setWorkspaceMode } from './test-state.js';

/**
 * 就地授权卡：Fake 的越界写入场景走真实的目录边界判定、授权服务与 SQLite，
 * 本文件全部通过界面操作决定授权，覆盖全局 Multivac（首页、工作区与管理中的侧栏）与工作会话（并排、聚焦）。
 */

const home = (page: Page) => page.locator('.work-surface').first();
const sidebar = (page: Page) => page.locator('.multivac-sidebar');
/** 侧栏收起时顶栏上的“等待你的授权”提示。 */
const attention = (page: Page) => page.getByRole('button', { name: 'Multivac 等待你的授权，打开侧栏处理' });
const workspaceBar = (page: Page) => page.locator('.workspace-page');
/** 按请求定位：全局 Multivac 的历史跨用例保留，同一会话里可能还有更早的卡片。 */
const card = (scope: Locator, request: ToolAuthorizationRequest) =>
  scope.getByRole('region', { name: /^工具授权：/u }).and(scope.locator(`[data-request-id="${request.requestId}"]`));
const toolRow = (scope: Locator, request: ToolAuthorizationRequest) =>
  scope.locator(`.run-trace-tool[data-tool-call-id="${request.toolCallId}"]`);

function panel(page: Page, title: string): Locator {
  return page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

async function authorizations(request: APIRequestContext, sessionId?: string): Promise<ToolAuthorizationRequest[]> {
  const path = sessionId ? `/api/sessions/${sessionId}/authorizations` : '/api/assistant/authorizations';
  const response = await request.get(`${fakeApiRoot}${path}`);
  expect(response.status()).toBe(200);
  return (await response.json() as { requests: ToolAuthorizationRequest[] }).requests;
}

/** 让 Agent 越界写入，等到卡片出现；返回服务端记录的请求。 */
async function startOutsideWrite(
  scope: Locator,
  request: APIRequestContext,
  sessionId?: string,
): Promise<ToolAuthorizationRequest> {
  const before = (await authorizations(request, sessionId)).length;
  const draft = scope.getByLabel('Multivac 草稿');
  await draft.fill('越界写入场景');
  await draft.press('Enter');
  await expect.poll(async () => (await authorizations(request, sessionId)).length).toBe(before + 1);
  const created = (await authorizations(request, sessionId)).at(-1)!;
  await expect(card(scope, created)).toBeVisible();
  return created;
}

/** 等待授权期间：卡片可操作，状态条只说明在等授权，轨迹与工具行都不显示执行中。 */
async function expectAwaiting(scope: Locator, pending: ToolAuthorizationRequest): Promise<void> {
  const current = card(scope, pending);
  await expect(current).toContainText(`写入 ${pending.targetPath}`);
  if (pending.sessionId === GLOBAL_ASSISTANT_SESSION_ID) {
    // 全局 Multivac 不记住授权（没有查看与撤销的位置），只能单次批准或拒绝，卡上写明原因。
    expect(pending.remember).toBeNull();
    await expect(current.getByRole('button')).toHaveText(['拒绝', '仅这一次']);
    await expect(current.getByRole('button', { name: '仅这一次' })).toHaveClass(/primary-button/);
    await expect(current.locator('.authorization-remember')).toHaveText('Multivac 的对话不记住授权决定，只能单次批准。');
  } else {
    // 不属于项目的工作会话（默认工作区）可以记在会话上，没有“本项目内”；卡上写明在哪里撤销。
    await expect(current.getByRole('button')).toHaveText(['拒绝', '仅这一次', '本会话内允许']);
    await expect(current.locator('.authorization-remember')).toContainText('可在标题栏的工作目录或“管理 · 会话”中撤销。');
  }
  await expect(scope.getByRole('status').filter({ hasText: '等待你的授权' })).toBeVisible();
  await expect(toolRow(scope, pending).locator('em')).toHaveText('待授权');
  await expect(scope.locator('.run-trace').last().locator('summary')).toContainText('等待授权');
  await expect(scope.locator('.run-trace-tool.running')).toHaveCount(0);
  await expect(scope.getByText('执行中', { exact: true })).toHaveCount(0);
  await expect(scope.getByText('思考中', { exact: true })).toHaveCount(0);
  expect(existsSync(pending.targetPath)).toBe(false);
}

/** 真实重启服务，等到新进程完成启动对账：等待中的请求已被置为失效。 */
async function restartServer(request: APIRequestContext, sessionId: string, requestId: string): Promise<void> {
  expect((await request.post(`${fakeApiRoot}/api/__e2e/restart`)).status()).toBe(202);
  // 旧进程在返回 202 后才退出，只有新进程会把这条请求置为失效。
  await expect.poll(async () => {
    try {
      const response = await request.get(`${fakeApiRoot}/api/sessions/${sessionId}/authorizations`, { timeout: 1_000 });
      if (!response.ok()) return 'unavailable';
      const requests = (await response.json() as { requests: ToolAuthorizationRequest[] }).requests;
      return requests.find((item) => item.requestId === requestId)?.status ?? 'missing';
    } catch {
      return 'unavailable';
    }
  }, { timeout: 30_000 }).toBe('invalidated');
}

async function createSession(page: Page, title: string): Promise<string> {
  await openCreationDialog(page);
  const dialog = page.getByRole('dialog', { name: '创建新会话' });
  await dialog.getByLabel('会话名称').fill(title);
  const created = page.waitForResponse((response) =>
    response.url().endsWith('/api/sessions') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).toHaveCount(0);
  return (await (await created).json() as WorkspaceSession).sessionId;
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  const current = await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json() as { revision: number };
  await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
    data: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: current.revision },
  });
  await page.goto('/');
  await expect(home(page).getByLabel('Multivac 草稿')).toBeEditable();
});

test('全局 Multivac 首页：等待授权时不显示执行中，刷新后卡片仍待授权；批准后继续执行并写入', async ({ page, request }) => {
  const pending = await startOutsideWrite(home(page), request);
  expect(pending.workingDirectory.kind).toBe('multivac');
  const current = card(home(page), pending);
  await expect(current).toContainText('允许写入工作目录外的文件？');
  await expect(current).toContainText(`本会话的工作目录是Multivac 工作目录 ${pending.workingDirectory.path}`);
  await expectAwaiting(home(page), pending);

  // 刷新页面：卡片从查询接口恢复，仍待授权、仍可操作。
  await page.reload();
  await expectAwaiting(home(page), pending);

  await card(home(page), pending).getByRole('button', { name: '仅这一次' }).click();
  await expect(card(home(page), pending)).toContainText('已批准（仅这一次）');
  await expect(card(home(page), pending).getByRole('button')).toHaveCount(0);
  await expect(home(page).getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(home(page).locator('article.chat-row.assistant').last()).toContainText(`已写入 ${pending.targetPath}`);
  await expect(toolRow(home(page), pending).locator('em')).toHaveText('已完成 · 已批准（仅这一次）');
  expect(readFileSync(pending.targetPath, 'utf8')).toBe('Fake 越界写入');
  expect((await authorizations(request)).find((item) => item.requestId === pending.requestId)?.status).toBe('approved');
});

test('侧栏里的全局 Multivac：收起时顶栏提示在等授权，工作区与管理中都能点它叫出侧栏；拒绝后 Agent 收到原因', async ({ page, request }) => {
  await openPanel(page, 'workspace');
  await createSession(page, '授权时的工作');
  // 新会话读完后把焦点交给自己的输入区；等它就绪再叫出侧栏，免得焦点随后被抢走。
  await expect(panel(page, '授权时的工作').getByLabel('Multivac 草稿')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+J');
  await expect(sidebar(page).getByLabel('Multivac 草稿')).toBeFocused();
  await expect(attention(page)).toHaveCount(0);
  const pending = await startOutsideWrite(sidebar(page), request);
  await expectAwaiting(sidebar(page), pending);
  // 侧栏开着时授权卡就在眼前，顶栏不重复提示。
  await expect(attention(page)).toHaveCount(0);

  // 等你授权时点进工作区的输入区（开始干活），侧栏不收起。
  await panel(page, '授权时的工作').getByLabel('Multivac 草稿').click();
  await expect(sidebar(page)).toBeVisible();

  // 手动收起后顶栏提示仍在等授权；首页本身显示授权卡，不提示。
  await sidebar(page).getByRole('button', { name: '收起 Multivac' }).click();
  await expect(sidebar(page)).toBeHidden();
  await expect(attention(page)).toBeVisible();
  await expect(attention(page)).toHaveText('等待你的授权');
  await openPanel(page, 'home');
  await expect(attention(page)).toHaveCount(0);
  await openPanel(page, 'management');
  await expect(attention(page)).toBeVisible();

  // 管理中点提示叫出侧栏，焦点交给侧栏输入区，授权卡就地可见；提示随之消失。
  await attention(page).click();
  await expect(sidebar(page)).toBeVisible();
  await expect(sidebar(page).getByLabel('Multivac 草稿')).toBeFocused();
  await expect(attention(page)).toHaveCount(0);
  await expectAwaiting(sidebar(page), pending);

  await card(sidebar(page), pending).getByRole('button', { name: '拒绝' }).click();
  await expect(card(sidebar(page), pending)).toContainText('已拒绝：没有执行，Multivac 已收到原因');
  await expect(card(sidebar(page), pending).getByRole('button')).toHaveCount(0);
  await expect(sidebar(page).getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(sidebar(page).locator('article.chat-row.assistant').last())
    .toContainText('没有写入：用户拒绝了这次授权');
  await expect(toolRow(sidebar(page), pending).locator('em')).toHaveText('已拒绝');
  expect(existsSync(pending.targetPath)).toBe(false);

  // 不再有待授权请求：收起后顶栏没有提示。
  await sidebar(page).getByRole('button', { name: '收起 Multivac' }).click();
  await expect(sidebar(page)).toBeHidden();
  await expect(attention(page)).toHaveCount(0);
});

test('工作会话并排：折叠的输入区说明在等授权，就地批准不切换当前会话；聚焦模式中拒绝', async ({ page, request }) => {
  await openPanel(page, 'workspace');
  const firstId = await createSession(page, '授权甲');
  const secondId = await createSession(page, '授权乙');
  await setWorkspaceMode(page, 'parallel');
  await expect(page.locator('.conversation-panel')).toHaveCount(2);
  const first = panel(page, '授权甲');
  const second = panel(page, '授权乙');

  const pending = await startOutsideWrite(second, request, secondId);
  expect(pending.workingDirectory.kind).toBe('session-temp');
  await expect(card(second, pending)).toContainText(`本会话的工作目录是临时目录 ${pending.workingDirectory.path}`);
  // 临时目录的规则写明归档后的保留与清理。
  await expect(card(second, pending)).toContainText('会话归档后，有文件的按“设置 · 偏好”保留（默认 30 天）再移到废纸篓，空目录直接删除。');
  await expectAwaiting(second, pending);

  // 切到甲：乙的输入区收起，折叠的一行里仍说明在等授权。
  await first.getByRole('button', { name: '在「授权甲」中继续' }).click();
  await expect(first).toHaveClass(/active/);
  await expect(second.locator('.assistant-composer.collapsed').getByRole('status')).toContainText('等待你的授权');

  await card(second, pending).getByRole('button', { name: '仅这一次' }).click();
  await expect(card(second, pending)).toContainText('已批准（仅这一次）');
  await expect(first).toHaveClass(/active/);
  await expect(second.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  expect(readFileSync(pending.targetPath, 'utf8')).toBe('Fake 越界写入');

  // 聚焦模式：同样就地出现、就地拒绝。
  await first.getByRole('button', { name: '放大「授权甲」' }).click();
  await expect(page.locator('.conversation-panel')).toHaveCount(1);
  const denied = await startOutsideWrite(first, request, firstId);
  await expectAwaiting(first, denied);
  await card(first, denied).getByRole('button', { name: '拒绝' }).click();
  await expect(card(first, denied)).toContainText('已拒绝');
  await expect(first.locator('article.chat-row.assistant').last()).toContainText('没有写入：用户拒绝了这次授权');
  expect(existsSync(denied.targetPath)).toBe(false);
});

test('工作会话：刷新后仍可批准；等待中服务重启后，卡片显示已失效且不可操作，轨迹不再显示运行中', async ({ page, request }) => {
  test.setTimeout(60_000);
  await openPanel(page, 'workspace');
  const sessionId = await createSession(page, '授权刷新');
  const scope = panel(page, '授权刷新');

  const approved = await startOutsideWrite(scope, request, sessionId);
  await page.reload();
  await openPanel(page, 'workspace');
  await expectAwaiting(scope, approved);
  await card(scope, approved).getByRole('button', { name: '仅这一次' }).click();
  await expect(card(scope, approved)).toContainText('已批准（仅这一次）');
  await expect(scope.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();

  const interrupted = await startOutsideWrite(scope, request, sessionId);
  await expectAwaiting(scope, interrupted);
  await restartServer(request, sessionId, interrupted.requestId);
  await page.reload();
  await openPanel(page, 'workspace');

  const invalidated = scope.locator(`[data-request-id="${interrupted.requestId}"]`);
  await expect(invalidated).toContainText('已失效：服务已重启，原来的等待无法恢复，没有执行');
  await expect(invalidated.getByRole('button')).toHaveCount(0);
  await expect(scope.locator(`[data-tool-call-id="${interrupted.toolCallId}"].run-trace-tool em`)).toHaveText('已失效');
  await expect(scope.getByText('等待你的授权')).toHaveCount(0);
  await expect(scope.getByText('思考中', { exact: true })).toHaveCount(0);
  // 中断的一轮随命令对账结束：轨迹不再运行，也不给出用时。
  await expect(scope.locator('.run-trace').last().locator('summary')).toContainText('已结束');
  await expect(scope.getByRole('button', { name: '取消当前处理' })).toHaveCount(0);
  expect(existsSync(interrupted.targetPath)).toBe(false);
  // Fake 的消息历史只在内存中，重启后更早的一轮不在窗口里；它的请求记录仍是批准。
  expect((await authorizations(request, sessionId)).map((item) => item.status)).toEqual(['approved', 'invalidated']);
});

test('另一处已作出决定时，界面上的决定提示冲突原因，卡片按服务端状态显示结果', async ({ page, request }) => {
  const pending = await startOutsideWrite(home(page), request);

  // 断开本页的事件流后刷新：卡片从查询接口恢复为待授权，但收不到之后的状态变化。
  let releaseEvents!: () => void;
  const eventsHeld = new Promise<void>((resolve) => { releaseEvents = resolve; });
  await page.route(/\/api\/events\?/u, async (route) => {
    await eventsHeld;
    await route.continue().catch(() => {});
  });
  await page.reload();
  await expect(card(home(page), pending).getByRole('button', { name: '仅这一次' })).toBeEnabled();

  // 另一个窗口先拒绝了这次请求。
  const decided = await request.post(`${fakeApiRoot}/api/assistant/authorizations/${pending.requestId}/decision`, {
    data: { decision: 'deny' },
  });
  expect(decided.status()).toBe(200);

  await card(home(page), pending).getByRole('button', { name: '仅这一次' }).click();
  await expect(card(home(page), pending).getByRole('alert')).toHaveText('授权请求已拒绝，不能改为另一个决定。');
  await expect(card(home(page), pending)).toContainText('已拒绝：没有执行，Multivac 已收到原因');
  await expect(card(home(page), pending).getByRole('button')).toHaveCount(0);
  expect(existsSync(pending.targetPath)).toBe(false);

  releaseEvents();
  await page.unroute(/\/api\/events\?/u);
});

test('等待超时后卡片显示已过期，状态条说明原因；等待中停止本轮，卡片显示已取消', async ({ page, request }) => {
  expect((await request.post(`${fakeApiRoot}/api/__e2e/tool-authorization`, { data: { timeoutMs: 1_500 } })).ok()).toBe(true);
  const expiring = await startOutsideWrite(home(page), request);
  await expectAwaiting(home(page), expiring);
  await expect(card(home(page), expiring)).toContainText('已过期：等待超时，本轮已结束，没有执行', { timeout: 10_000 });
  await expect(home(page).getByRole('status')).toHaveText('授权等待超时，本轮已结束');
  await expect(toolRow(home(page), expiring).locator('em')).toHaveText('已过期');

  expect((await request.post(`${fakeApiRoot}/api/__e2e/tool-authorization`, { data: { timeoutMs: null } })).ok()).toBe(true);
  const stopped = await startOutsideWrite(home(page), request);
  await expectAwaiting(home(page), stopped);
  await home(page).getByRole('button', { name: '取消当前处理' }).click();
  await expect(card(home(page), stopped)).toContainText('已取消：本轮已停止，没有执行');
  await expect(home(page).getByRole('status').getByText('处理已取消', { exact: true })).toBeVisible();
  await expect(toolRow(home(page), stopped).locator('em')).toHaveText('已取消');
  expect(existsSync(expiring.targetPath) || existsSync(stopped.targetPath)).toBe(false);
});
