import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ContextCompactionOperation, SessionContextResponse } from '@multivac/contracts';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

const model = { provider: 'controlled', modelId: '长模型名称'.repeat(12), source: 'base' as const, protocol: null, profileId: null };
const item = { status: 'unknown' as const, explanation: '浏览器受控数据；不代表真实提供方计数已验证。' };
const snapshot: SessionContextResponse = { state: { sessionId: 'global-coordinator', revision: 'browser-fixture',
  current: { sessionId: 'global-coordinator', revision: 'browser-fixture', model, contextWindow: 10000,
    observedAt: '2026-10-26T00:00:00.000Z', measuredAt: '2026-10-26T00:00:00.000Z', stale: false, staleReason: null,
    coverage: { systemPrompt: item, toolDefinitions: item, summary: item, toolResults: item, attachments: item },
    source: 'current-estimate', tokens: 2000, basis: 'browser-fixture-only', unavailableReason: null },
  lastRequest: null, compaction: { available: false, model, reason: '受控用例中当前执行器不支持主动压缩。' } }, operation: null };

test.beforeEach(async ({ request }) => { await resetE2eState(request); });

/** 在输入框输入 /compact，返回菜单中的内置命令选项。 */
async function slashCompact(root: Locator) {
  await root.getByLabel('Multivac 草稿').fill('/compact');
  return root.getByRole('option', { name: /compact/u });
}

test('Fake 执行器下 HTTP 查询不初始化工作会话，双宿主显示不可用并拒绝主动压缩', async ({ page, request }) => {
  const taskLookups: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/task-session/')) taskLookups.push(request.url()); });
  const id = crypto.randomUUID();
  expect((await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId: id, title: '上下文验收' } })).ok()).toBe(true);
  const base = `${fakeApiRoot}/api/sessions/${id}`;
  const context = await (await request.get(`${base}/context`)).json();
  expect(context.state.current.source).toBe('unavailable');
  expect(context.state.current.tokens).toBeNull();
  const operationId = crypto.randomUUID();
  const command = { operationId, sessionId: id, revision: context.state.revision };
  const first = await (await request.post(`${base}/context/compact`, { data: command })).json();
  expect(first.status).toBe('unavailable');
  expect(first.commitState).toBe('not-committed');
  expect(await (await request.post(`${base}/context/compact`, { data: command })).json()).toEqual(first);
  expect((await (await request.get(`${base}/context/operations/${operationId}`)).json()).operationId).toBe(operationId);
  await page.goto('/');
  const global = page.locator('.assistant-page').filter({ has: page.getByLabel('会话上下文', { exact: true }) }).first();
  await expect(await slashCompact(global)).toHaveAttribute('aria-disabled', 'true');
  await global.getByLabel('Multivac 草稿').fill('');
  await openPanel(page, 'workspace');
  const panel = page.locator(`.conversation-panel[data-session-id="${id}"]`);
  await expect(await slashCompact(panel)).toHaveAttribute('aria-disabled', 'true');
  await panel.getByLabel('Multivac 草稿').fill('');
  expect(taskLookups).toEqual([]);
  const noteId = crypto.randomUUID();
  expect((await request.post(`${fakeApiRoot}/api/notes`, { data: { id: noteId, commandId: crypto.randomUUID(), title: '排除宿主', body: '受控正文' } })).ok()).toBe(true);
  const companion = await (await request.post(`${fakeApiRoot}/api/notes/${noteId}/companion`)).json();
  expect((await request.get(`${fakeApiRoot}/api/sessions/${companion.sessionId}/context`)).status()).toBe(404);
  expect((await request.post(`${fakeApiRoot}/api/sessions/${companion.sessionId}/context/compact`, { data: {
    operationId: crypto.randomUUID(), sessionId: companion.sessionId, revision: 'unavailable',
  } })).status()).toBe(404);
});

for (const width of [320, 1440]) test(`${width}px 受控统计来源、长模型、命令提示和键盘焦点`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 800 });
  await page.route('**/api/assistant/context', route => route.fulfill({ json: snapshot }));
  await page.goto('/');
  const trigger = page.getByLabel('会话上下文', { exact: true });
  await expect(trigger).toContainText('20%');
  await trigger.focus(); await page.keyboard.press('Enter');
  const panel = page.locator('.context-panel-content:visible');
  await expect(panel).toContainText('2,000 / 10,000');
  await expect(panel).toContainText('更新');
  await expect(panel).toContainText('长模型名称');
  await expect(panel).toContainText('/compact');
  const bounds = (await panel.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: info.outputPath(`context-${width}.png`) });
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('双窗口与刷新仅查询上下文，不自动发起压缩', async ({ page, context }) => {
  let posts = 0;
  await context.route('**/api/assistant/context**', async route => {
    if (route.request().method() === 'POST') posts++;
    await route.continue();
  });
  const other = await context.newPage();
  await Promise.all([page.goto('/'), other.goto('/')]);
  for (const window of [page, other]) {
    await window.getByLabel('会话上下文', { exact: true }).click();
    await expect(await slashCompact(window.locator('.assistant-page').first())).toHaveAttribute('aria-disabled', 'true');
  }
  await page.reload();
  await page.getByLabel('会话上下文', { exact: true }).click();
  await expect(await slashCompact(page.locator('.assistant-page').first())).toHaveAttribute('aria-disabled', 'true');
  expect(posts).toBe(0);
  await other.close();
});


for (const host of ['global', 'work'] as const) test(`${host} 受控压缩交互：断线、双窗口和刷新只核对原操作`, async ({ page, context, request }) => {
  const sessionId = host === 'global' ? 'global-coordinator' : crypto.randomUUID();
  if (host === 'work') expect((await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: '压缩交互验收' } })).ok()).toBe(true);
  const base = host === 'global' ? '/api/assistant/context' : `/api/sessions/${sessionId}/context`;
  let posts = 0;
  let operation: ContextCompactionOperation | null = null;
  let completed = false;
  const current = { ...snapshot.state.current, sessionId };
  // 只验证界面状态与重连行为；原生 SDK、SQLite 和文件恢复另有联合用例。
  await context.route(`**${base}**`, async route => {
    if (route.request().method() === 'POST') {
      posts++;
      const command = route.request().postDataJSON();
      expect(command.sessionId).toBe(sessionId);
      operation = { operationId: command.operationId, sessionId, model, status: 'running', commitState: 'unknown',
        runtimeCommitRef: null, startedAt: current.observedAt, updatedAt: current.observedAt, finishedAt: null,
        before: current, after: null, error: null };
      await route.abort('failed'); // 服务端已受理，但浏览器没有收到响应。
      return;
    }
    if (route.request().url().includes('/operations/')) { await route.fulfill({ json: operation }); return; }
    const value: SessionContextResponse = { state: { ...snapshot.state, sessionId, current,
      compaction: operation && !completed ? { available: false, model, reason: '原操作仍在执行。' } : { available: true, model, reason: null } }, operation };
    await route.fulfill({ json: value });
  });
  const hostRoot = async (window: Page) => {
    if (host === 'work') await openPanel(window, 'workspace');
    return host === 'global' ? window.locator('.assistant-page').first() : window.locator(`.conversation-panel[data-session-id="${sessionId}"]`);
  };
  const details = async (root: Locator) => {
    await root.getByLabel('会话上下文', { exact: true }).click();
    return root.locator('.context-panel-content');
  };
  await page.goto('/');
  let root = await hostRoot(page);
  const compact = await slashCompact(root);
  await expect(compact).not.toHaveAttribute('aria-disabled', 'true');
  await compact.click();
  await expect(root.getByLabel('Multivac 草稿')).toHaveValue('');
  await expect(root.locator('.compact-feedback')).toContainText('正在压缩');
  await expect(await slashCompact(root)).toHaveAttribute('aria-disabled', 'true');
  await root.getByLabel('Multivac 草稿').fill('');
  const other = await context.newPage(); await other.goto('/');
  const otherRoot = await hostRoot(other);
  await expect(await slashCompact(otherRoot)).toHaveAttribute('aria-disabled', 'true');
  await otherRoot.getByLabel('Multivac 草稿').fill('');
  const otherPanel = await details(otherRoot);
  await page.reload(); root = await hostRoot(page);
  const panel = await details(root);
  await expect(panel.locator('.context-operation')).toContainText('正在压缩');
  expect(posts).toBe(1);
  completed = true;
  expect(operation).not.toBeNull();
  operation = { ...operation!, status: 'succeeded', commitState: 'committed', runtimeCommitRef: 'controlled-native-entry', finishedAt: current.observedAt,
    after: { ...current, source: 'unavailable', tokens: null, basis: null, unavailableReason: '压缩后尚无新的有效请求用量，当前占用未知。' } };
  await panel.getByRole('button', { name: '刷新状态' }).click();
  await expect(panel.locator('.context-operation')).toHaveCount(0);
  await otherPanel.getByRole('button', { name: '刷新状态' }).click();
  await expect(otherPanel.locator('.context-operation')).toHaveCount(0);
  expect(posts).toBe(1);
  await other.close();
});
