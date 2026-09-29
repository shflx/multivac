import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

/**
 * 全局 Multivac 的查询工具（Fake 按消息脚本“内部工具：<名称>[#<toolCallId>] [JSON 参数]”调用，走真实的注册表与服务）：
 * 问“有哪些项目 / X 进展如何 / 第二栏是什么”得到基于真实数据的回答；工具行写明读了哪个会话、几条；
 * 工具行与回复中的会话、项目可以点开（会话在工作区打开，项目打开设置 · 项目），已归档的先说明需要恢复。
 */

const home = (page: Page) => page.locator('.work-surface').first();
const sidebar = (page: Page) => page.locator('.multivac-sidebar');
const toolRowSelector = (toolCallId: string) => `.run-trace-tool[data-tool-call-id="${toolCallId}"]`;
const replyWith = (scope: Locator, text: string) => scope.locator('article.chat-row.assistant').filter({ hasText: text });
const panel = (page: Page, title: string) => page.locator('.conversation-panel')
  .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
const projectsPage = (page: Page) => page.getByRole('main', { name: '项目' });

async function send(scope: Locator, text: string): Promise<void> {
  const draft = scope.getByLabel('Multivac 草稿');
  await draft.fill(text);
  await draft.press('Enter');
}

/** 展开本轮的运行轨迹（有回复后自动收起），返回工具行。 */
async function toolRow(scope: Locator, toolCallId: string): Promise<Locator> {
  const trace = scope.locator('.run-trace').filter({ has: scope.page().locator(toolRowSelector(toolCallId)) });
  await expect(trace).toHaveCount(1);
  if (await trace.getAttribute('open') === null) await trace.locator('summary').click();
  return scope.locator(toolRowSelector(toolCallId));
}

async function createSession(request: APIRequestContext, sessionId: string, title: string, workspaceId?: string) {
  expect((await request.post(`${fakeApiRoot}/api/sessions`, {
    data: { sessionId, title, ...(workspaceId ? { workspaceId } : {}) },
  })).status()).toBe(201);
}

async function sessionArchivedAt(request: APIRequestContext, sessionId: string): Promise<string | null | undefined> {
  const listed = await (await request.get(`${fakeApiRoot}/api/sessions?workspace=all&archived=include`)).json() as {
    sessions: Array<{ sessionId: string; archivedAt: string | null }>;
  };
  return listed.sessions.find((session) => session.sessionId === sessionId)?.archivedAt;
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

test('“有哪些项目”：回答来自真实项目，工具行与回复中的项目可以点开设置 · 项目', async ({ page, request }) => {
  const created = await request.post(`${fakeApiRoot}/api/projects`, { data: { name: '查询项目', defaultConstraints: '只改文档。' } });
  expect(created.status()).toBe(201);
  const toolCallId = `e2e-projects-${Date.now()}`;
  await send(home(page), `有哪些项目？\n内部工具：list_projects#${toolCallId}`);

  const reply = replyWith(home(page), '共 1 个项目：');
  await expect(reply).toContainText('默认约束：只改文档。');
  const row = await toolRow(home(page), toolCallId);
  await expect(row.locator('span').first()).toHaveText('列出项目');
  await expect(row.locator('em')).toHaveText('已完成 · 共 1 个项目');

  // 工具行上的项目标签：打开设置 · 项目并选中它。
  await row.locator('.run-trace-refs').getByRole('button', { name: '查询项目' }).click();
  await expect(projectsPage(page)).toBeVisible();
  await expect(projectsPage(page).locator('.project-detail').getByRole('heading', { name: '查询项目' })).toBeVisible();

  // 回复正文中的项目链接同样可以点开。
  await openPanel(page, 'home');
  await reply.getByRole('button', { name: '查询项目' }).click();
  await expect(projectsPage(page).locator('.project-detail').getByRole('heading', { name: '查询项目' })).toBeVisible();
});

test('“X 进展如何”：读取会话最近的正文（不含思考），工具行写明读了哪个会话、几条；链接在工作区打开它', async ({ page, request }) => {
  await createSession(request, 'progress-a', '接口调研');
  const sent = await request.post(`${fakeApiRoot}/api/sessions/progress-a/turns`, {
    data: { commandId: `progress-${Date.now()}`, assistantSessionId: 'progress-a', text: '先把接口列一下', contextRefs: [] },
  });
  expect((await sent.json() as { terminalOutcome: string }).terminalOutcome).toBe('succeeded');

  const toolCallId = `e2e-read-${Date.now()}`;
  await send(home(page), `接口调研进展如何？\n内部工具：read_session_recent#${toolCallId} {"sessionId":"progress-a"}`);
  const reply = replyWith(home(page), '最近 2 条消息');
  await expect(reply).toContainText('用户（');
  await expect(reply).toContainText('先把接口列一下');
  await expect(reply).toContainText('助手（');
  await expect(reply).toContainText('Fake Multivac 已处理当前消息。');
  // 工作会话的思考内容不在读取结果里。
  await expect(reply).not.toContainText('正在梳理当前请求需要核对的范围');

  const row = await toolRow(home(page), toolCallId);
  await expect(row.locator('span').first()).toHaveText('读取会话 progress-a');
  await expect(row.locator('em')).toHaveText('已完成 · 读取「接口调研」最近 2 条');
  await expect(row.locator('.run-trace-refs').getByRole('button', { name: '接口调研' })).toBeVisible();

  // 回复中的会话链接：切到工作区并聚焦这个会话。
  await reply.getByRole('button', { name: '接口调研' }).first().click();
  await expect(page.getByRole('toolbar', { name: '工作区' })).toBeVisible();
  await expect(panel(page, '接口调研')).toBeVisible();
  await expect(panel(page, '接口调研').getByLabel('Multivac 草稿')).toBeFocused();

  // 刷新：工具行的结果摘要与对象从服务端的工具记录恢复。
  await page.reload();
  await openPanel(page, 'home');
  const restored = await toolRow(home(page), toolCallId);
  await expect(restored.locator('em')).toHaveText('已完成 · 读取「接口调研」最近 2 条');
  await expect(restored.locator('.run-trace-refs').getByRole('button', { name: '接口调研' })).toBeVisible();
});

test('“第二栏是什么”：侧栏发送时带上当前视图，回答写明各栏的会话；拿不到视图时如实说明', async ({ page, request }) => {
  await createSession(request, 'view-a', '甲方案');
  await createSession(request, 'view-b', '乙方案');
  await openPanel(page, 'workspace');
  // 并排 2 栏：空出的栏按会话列表（新的在前）补位。
  await expect(page.locator('.conversation-panel')).toHaveCount(2);
  await expect(panel(page, '乙方案')).toBeVisible();

  await page.keyboard.press('ControlOrMeta+J');
  await expect(sidebar(page).getByLabel('Multivac 草稿')).toBeFocused();
  const toolCallId = `e2e-view-${Date.now()}`;
  await send(sidebar(page), `第二栏是什么？\n内部工具：get_current_view#${toolCallId}`);
  const reply = replyWith(sidebar(page), '当前面板：工作区');
  await expect(reply).toContainText('当前工作区：「默认工作区」（id: default）');
  await expect(reply).toContainText('第 1 栏：乙方案');
  await expect(reply).toContainText('第 2 栏：甲方案');
  const row = await toolRow(sidebar(page), toolCallId);
  await expect(row.locator('em')).toHaveText('已完成 · 工作区「默认工作区」· 并排 2 栏');

  // 回复中的“第 2 栏”会话链接：聚焦它（已在工作区中）。
  await reply.getByRole('button', { name: '甲方案' }).first().click();
  await expect(panel(page, '甲方案').getByLabel('Multivac 草稿')).toBeFocused();

  // 不是从界面发出的消息没有当前视图：工具失败并说明拿不到，不猜测。
  const response = await request.post(`${fakeApiRoot}/api/assistant/turns`, {
    data: {
      commandId: `no-view-${Date.now()}`, assistantSessionId: 'global-coordinator', contextRefs: [],
      text: '这个是什么\n内部工具：get_current_view',
    },
  });
  expect((await response.json() as { terminalOutcome: string }).terminalOutcome).toBe('succeeded');
  await expect(replyWith(sidebar(page), '拿不到发起这条消息的窗口的当前视图')).toHaveCount(1);
});

test('已归档的会话：链接先说明需要恢复，取消不恢复；确认后恢复并在工作区打开', async ({ page, request }) => {
  await createSession(request, 'archived-a', '旧的方案');
  expect((await request.post(`${fakeApiRoot}/api/sessions/archived-a/archive`)).ok()).toBe(true);

  const toolCallId = `e2e-archived-${Date.now()}`;
  await send(home(page), `有哪些归档的会话？\n内部工具：list_sessions#${toolCallId} {"status":"archived"}`);
  const reply = replyWith(home(page), '符合条件的会话共 1 个');
  await expect(reply).toContainText('已归档（归档于');
  const row = await toolRow(home(page), toolCallId);
  await expect(row.locator('span').first()).toHaveText('列出会话');
  await expect(row.locator('em')).toHaveText('已完成 · 找到 1 个会话');

  const chip = row.locator('.run-trace-refs').getByRole('button', { name: /旧的方案/ });
  await expect(chip).toContainText('已归档');
  await chip.click();
  const card = page.getByRole('dialog', { name: '「旧的方案」已归档' });
  await expect(card).toContainText('需要先恢复，才能在工作区打开');
  await card.getByRole('button', { name: '取消' }).click();
  await expect(card).toHaveCount(0);
  expect(await sessionArchivedAt(request, 'archived-a')).not.toBeNull();
  await expect(page.getByRole('toolbar', { name: '工作区' })).toBeHidden();

  await reply.getByRole('button', { name: /旧的方案/ }).click();
  await page.getByRole('dialog', { name: '「旧的方案」已归档' }).getByRole('button', { name: '恢复并打开' }).click();
  await expect(panel(page, '旧的方案')).toBeVisible();
  expect(await sessionArchivedAt(request, 'archived-a')).toBeNull();
});
