import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ToolAuthorizationRequest, WorkspaceSession } from '@multivac/contracts';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

/**
 * 全局 Multivac 的会话管理工具（Fake 按消息脚本“内部工具：<名称>#<toolCallId> {JSON 参数}”调用，走真实的注册表、
 * 会话服务、账本与工作台推送）：对话中新建、改名、归档、恢复会话，效果与界面操作一致，各窗口不刷新即更新；
 * 这一轮之后出现一行回执，“在工作区打开”“恢复”可用；新建后不自动跳转；运行中的会话不能经对话归档。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const home = (page: Page) => page.locator('.work-surface').first();
const sidebar = (page: Page) => page.locator('.multivac-sidebar');
const workspaceBar = (page: Page) => page.locator('.workspace-page');
const panelTitles = (page: Page) => page.locator('.conversation-panel h2');
const receipt = (scope: Locator, toolCallId: string) => scope.locator(`.tool-receipt[data-tool-call-id="${toolCallId}"]`);
const replyWith = (scope: Locator, text: string) => scope.locator('article.chat-row.assistant').filter({ hasText: text });

function panel(page: Page, title: string): Locator {
  return page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

async function send(scope: Locator, text: string): Promise<void> {
  const draft = scope.getByLabel('Multivac 草稿');
  await draft.fill(text);
  await draft.press('Enter');
}

/** 展开本轮的运行轨迹（有回复后自动收起），返回工具行。 */
async function toolRow(scope: Locator, toolCallId: string): Promise<Locator> {
  const selector = `.run-trace-tool[data-tool-call-id="${toolCallId}"]`;
  const trace = scope.locator('.run-trace').filter({ has: scope.page().locator(selector) });
  await expect(trace).toHaveCount(1);
  if (await trace.getAttribute('open') === null) await trace.locator('summary').click();
  return scope.locator(selector);
}

/** 经接口新建会话；id 每次运行都不同（重置只删除会话记录，按会话保存的页面现场与授权请求仍在）。 */
async function createSession(request: APIRequestContext, title: string): Promise<string> {
  const sessionId = `tools-${crypto.randomUUID()}`;
  expect((await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title } })).status()).toBe(201);
  return sessionId;
}

async function allSessions(request: APIRequestContext): Promise<WorkspaceSession[]> {
  const listed = await (await request.get(`${fakeApiRoot}/api/sessions?workspace=all&archived=include`)).json() as {
    sessions: WorkspaceSession[];
  };
  return listed.sessions;
}

async function sessionById(request: APIRequestContext, sessionId: string): Promise<WorkspaceSession | undefined> {
  return (await allSessions(request)).find((session) => session.sessionId === sessionId);
}

async function authorizations(request: APIRequestContext, sessionId: string): Promise<ToolAuthorizationRequest[]> {
  const response = await request.get(`${fakeApiRoot}/api/sessions/${sessionId}/authorizations`);
  return (await response.json() as { requests: ToolAuthorizationRequest[] }).requests;
}

async function openWindow(page: Page): Promise<void> {
  await page.goto('/');
  await expect(home(page).getByLabel('Multivac 草稿')).toBeEditable();
}

test.beforeEach(async ({ request }) => {
  await resetE2eState(request);
});

test('对话中新建会话：建在当前工作区，不自动跳转；另一个窗口的工作区即时出现；回执“在工作区打开”可用，重放不重复新建', async ({ page, context, request }) => {
  await createSession(request, '已有会话');
  // 窗口 A 进过工作区（当前工作区是默认工作区），回到首页对 Multivac 说话。
  await openWindow(page);
  await openPanel(page, 'workspace');
  await expect(panelTitles(page)).toHaveText(['已有会话']);
  await openPanel(page, 'home');

  // 窗口 B 停在工作区：新会话由推送写回，补进空栏。
  const other = await context.newPage();
  await openWindow(other);
  await openPanel(other, 'workspace');
  await expect(panelTitles(other)).toHaveText(['已有会话']);

  const toolCallId = `e2e-create-${Date.now()}`;
  const line = `内部工具：create_session#${toolCallId} {"title":"对话新建"}`;
  // 同一条消息里重复同一个调用 id：重放只返回原结果，不会建出第二个会话。
  await send(home(page), `新建一个会话叫对话新建\n${line}\n${line}`);

  const card = receipt(home(page), toolCallId);
  await expect(card).toHaveCount(1);
  await expect(card.locator('strong')).toHaveText('已新建会话「对话新建」');
  await expect(card).toContainText('在「默认工作区」中');
  await expect(replyWith(home(page), '已在工作区「默认工作区」新建会话')).toHaveCount(1);
  const row = await toolRow(home(page), toolCallId);
  await expect(row.locator('span').first()).toHaveText('新建会话 对话新建');
  await expect(row.locator('em')).toHaveText('已完成 · 已新建「对话新建」');
  expect((await allSessions(request)).filter((session) => session.title === '对话新建')).toHaveLength(1);

  // 不自动跳转：发起窗口仍在首页；另一个窗口的工作区不刷新即出现新会话。
  await expect(workspaceBar(page)).toBeHidden();
  await expect(home(page).getByLabel('Multivac 草稿')).toBeVisible();
  await expect(panelTitles(other)).toHaveText(['已有会话', '对话新建']);

  // 回执上的“在工作区打开”：切到工作区并聚焦这个会话。
  await card.getByRole('button', { name: '在工作区打开「对话新建」' }).click();
  await expect(workspaceBar(page)).toBeVisible();
  await expect(panel(page, '对话新建').getByLabel('Multivac 草稿')).toBeFocused();

  // 刷新后回执从服务端的工具记录恢复。
  await page.reload();
  await expect(receipt(home(page), toolCallId).locator('strong')).toHaveText('已新建会话「对话新建」');
});

test('对话中改名、归档：工作区即时更新；归档回执的“恢复”可用，恢复后改为“已恢复”并可在工作区打开', async ({ page, request }) => {
  const sessionId = await createSession(request, '待整理');
  const tempDir = (await sessionById(request, sessionId))!.workingDirectory.path;
  writeFileSync(join(tempDir, 'notes.md'), '笔记');
  await openWindow(page);
  await openPanel(page, 'workspace');
  await expect(panelTitles(page)).toHaveText(['待整理']);

  // 在工作区的 Multivac 侧栏里说：栏标题不刷新即变化。
  await page.keyboard.press('ControlOrMeta+J');
  await expect(sidebar(page).getByLabel('Multivac 草稿')).toBeFocused();
  const renameId = `e2e-rename-${Date.now()}`;
  await send(sidebar(page), `改个名字\n内部工具：rename_session#${renameId} {"sessionId":"${sessionId}","title":"整理完的笔记"}`);
  await expect(receipt(sidebar(page), renameId).locator('strong')).toHaveText('已改名为「整理完的笔记」');
  await expect(receipt(sidebar(page), renameId)).toContainText('原名「待整理」');
  await expect(panelTitles(page)).toHaveText(['整理完的笔记']);

  // 归档：直接执行，会话移出栏位；回执写明临时目录的保留期，带“恢复”。
  const archiveId = `e2e-archive-${Date.now()}`;
  await send(sidebar(page), `归档它\n内部工具：archive_session#${archiveId} {"sessionId":"${sessionId}"}`);
  const archived = receipt(sidebar(page), archiveId);
  await expect(archived.locator('strong')).toHaveText('已归档「整理完的笔记」');
  await expect(archived).toContainText('临时目录里还有 1 个文件（notes.md），保留 30 天后移到废纸篓，到期前恢复会话则取消清理。');
  await expect(panelTitles(page)).toHaveCount(0);
  expect((await sessionById(request, sessionId))!.archivedAt).not.toBeNull();

  // “恢复”：直接恢复（撤回），会话补回空栏；回执改为“已恢复”，并给出“在工作区打开”。
  await archived.getByRole('button', { name: '恢复「整理完的笔记」' }).click();
  await expect(panelTitles(page)).toHaveText(['整理完的笔记']);
  await expect(archived.locator('.tool-receipt-state')).toHaveText('已恢复');
  await expect(archived.getByRole('button', { name: /^恢复/ })).toHaveCount(0);
  expect((await sessionById(request, sessionId))!.archivedAt).toBeNull();
  await archived.getByRole('button', { name: '在工作区打开「整理完的笔记」' }).click();
  await expect(panel(page, '整理完的笔记').getByLabel('Multivac 草稿')).toBeFocused();
});

test('对话中恢复：会话回到原工作区；临时目录已被移到废纸篓时如实说明；回执“在工作区打开”可用', async ({ page, request }) => {
  const sessionId = await createSession(request, '旧调研');
  const tempDir = (await sessionById(request, sessionId))!.workingDirectory.path;
  writeFileSync(join(tempDir, 'report.md'), '报告');
  expect((await request.post(`${fakeApiRoot}/api/sessions/${sessionId}/archive`)).ok()).toBe(true);
  // 拨快清理时钟：有文件的临时目录到期移到（测试注入的）废纸篓。
  const swept = await request.post(`${fakeApiRoot}/api/__e2e/temp-directories`, { data: { advanceMs: 31 * DAY_MS } });
  expect(swept.ok()).toBe(true);

  await openWindow(page);
  const toolCallId = `e2e-restore-${Date.now()}`;
  await send(home(page), `把旧调研恢复回来\n内部工具：restore_session#${toolCallId} {"sessionId":"${sessionId}"}`);
  const card = receipt(home(page), toolCallId);
  await expect(card.locator('strong')).toHaveText('已恢复「旧调研」');
  await expect(card).toContainText('回到工作区「默认工作区」；它的临时目录已于');
  await expect(card).toContainText('到期移到废纸篓');
  await expect(card).toContainText('已重建空的临时目录');
  expect((await sessionById(request, sessionId))!.archivedAt).toBeNull();
  // 不自动跳转；“在工作区打开”切过去并聚焦。
  await expect(workspaceBar(page)).toBeHidden();
  await card.getByRole('button', { name: '在工作区打开「旧调研」' }).click();
  await expect(panel(page, '旧调研').getByLabel('Multivac 草稿')).toBeFocused();

  // 再恢复一次：没有归档，工具失败并说明，没有回执。
  await openPanel(page, 'home');
  const againId = `e2e-restore-again-${Date.now()}`;
  await send(home(page), `再恢复一次\n内部工具：restore_session#${againId} {"sessionId":"${sessionId}"}`);
  await expect(replyWith(home(page), '没有恢复：会话「旧调研」没有归档，不需要恢复。')).toHaveCount(1);
  await expect(receipt(home(page), againId)).toHaveCount(0);
});

test('运行中（等待授权）的会话不能经对话归档：工具失败并说明原因，会话仍在', async ({ page, request }) => {
  const sessionId = await createSession(request, '等待授权');
  const commandId = `command-${crypto.randomUUID()}`;
  const turn = request.post(`${fakeApiRoot}/api/sessions/${sessionId}/turns`, {
    data: { commandId, assistantSessionId: sessionId, text: '越界写入场景', contextRefs: [] },
    timeout: 20_000,
  }).catch(() => null);
  await expect.poll(async () => (await authorizations(request, sessionId)).map((item) => item.status)).toEqual(['pending']);

  await openWindow(page);
  const toolCallId = `e2e-archive-running-${Date.now()}`;
  await send(home(page), `归档等待授权那个会话\n内部工具：archive_session#${toolCallId} {"sessionId":"${sessionId}"}`);
  await expect(replyWith(home(page), '没有完成：没有归档：会话「等待授权」正在运行（或在等待授权），运行中的会话不能归档。'))
    .toHaveCount(1);
  const row = await toolRow(home(page), toolCallId);
  await expect(row).toHaveClass(/failed/u);
  await expect(receipt(home(page), toolCallId)).toHaveCount(0);
  expect((await sessionById(request, sessionId))!.archivedAt).toBeNull();

  // 这一轮结束后（拒绝授权）就可以归档。
  const [pending] = await authorizations(request, sessionId);
  expect((await request.post(`${fakeApiRoot}/api/sessions/${sessionId}/authorizations/${pending!.requestId}/decision`, {
    data: { decision: 'deny' },
  })).ok()).toBe(true);
  await turn;
  const laterId = `e2e-archive-later-${Date.now()}`;
  await send(home(page), `现在归档\n内部工具：archive_session#${laterId} {"sessionId":"${sessionId}"}`);
  await expect(receipt(home(page), laterId).locator('strong')).toHaveText('已归档「等待授权」');
  expect((await sessionById(request, sessionId))!.archivedAt).not.toBeNull();
});
