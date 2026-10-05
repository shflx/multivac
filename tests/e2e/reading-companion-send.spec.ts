import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import { fakeApiRoot, openPanel } from './test-state.js';

async function openBook(page: Page, request: APIRequestContext, label: string, mobile = false) {
  const book = await (await request.post(`${fakeApiRoot}/api/reading/books`, { data: { commandId: crypto.randomUUID(), title: label, author: '', format: 'txt', text: `# 发送验证\n\n${label}，第一处原文供本次引用，另一处原文供下一条提问使用。\n\n${'阅读上下文应当随本轮命令固定，不影响后续输入。'.repeat(100)}` } })).json();
  const discussion = await (await request.post(`${fakeApiRoot}/api/reading/books/${book.id}/companion`)).json();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  await page.getByRole('navigation', { name: '书架' }).getByRole('button', { name: new RegExp(label) }).click();
  if (mobile) await page.setViewportSize({ width: 390, height: 740 });
  await expect(page.locator('.reading-flow p').filter({ hasText: '第一处原文' }).first()).toBeVisible();
  return { book, discussion };
}
async function quoteSelection(page: Page, start = 2, end = 10, action = '问书伴') {
  const paragraph = page.locator('.reading-flow p').filter({ hasText: '第一处原文' }).first();
  if (!await paragraph.isVisible()) await page.getByRole('button', { name: '返回正文', exact: true }).click();
  const text = await paragraph.evaluate((element, { start, end }) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode()!; const range = document.createRange();
    range.setStart(node, start); range.setEnd(node, end);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return range.toString();
  }, { start, end });
  const toolbar = page.getByRole('toolbar', { name: '选区操作' });
  if (action === '问书伴') await toolbar.getByRole('button', { name: action, exact: true }).click();
  else { await toolbar.getByRole('button', { name: '更多选区操作' }).click(); await page.getByRole('menuitem', { name: action, exact: true }).click(); }
  const companion = page.getByRole('complementary', { name: '书伴', exact: true });
  await expect(companion.getByLabel('向书伴提问')).toBeEditable();
  if (action === '问书伴') await expect(companion.locator('.reading-context-preview')).toContainText(text);
  return text;
}
async function resumeReading(page: Page) {
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  await expect(page.locator('.reading-toolbar h2')).toBeVisible();
  const toggle = page.getByRole('button', { name: '书伴', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(companion(page).getByLabel('向书伴提问')).toBeEditable();
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const turnsRoute = '**/api/sessions/*/turns';
const commandsRoute = '**/api/sessions/*/commands/*';
const companion = (page: Page) => page.getByRole('complementary', { name: '书伴', exact: true });
const refuse = (route: Route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INVALID_REQUEST', message: '本次提问未接收，请重试。' } }) });

for (const mobile of [false, true]) test(`发送立即移交正文与一次性引用，迟到的回执保留新草稿${mobile ? '（手机）' : ''}`, async ({ page, request }, testInfo) => {
  const { discussion } = await openBook(page, request, `即时发送${mobile ? '手机' : '桌面'}`, mobile);
  const excerpt = await quoteSelection(page);
  const ui = companion(page); const draft = ui.getByLabel('向书伴提问');
  const held = gate(); const bodies: Record<string, any>[] = [];
  await page.route(turnsRoute, async route => { bodies.push(route.request().postDataJSON()); await held.promise; await route.continue(); });
  await draft.fill('解释本次选区。'); await ui.getByRole('button', { name: '发送给书伴' }).click();
  await expect(draft).toHaveValue(''); await expect(draft).toBeFocused(); await expect(draft).toBeEditable();
  await expect(ui.locator('.reading-context-preview')).toHaveCount(0);
  const row = ui.locator('.reading-message.user').filter({ hasText: '解释本次选区。' });
  await expect(row).toHaveCount(1); await expect(row.getByRole('status')).toHaveText('发送中');
  await expect(row.locator('.reading-source')).toContainText(excerpt);
  expect(bodies).toHaveLength(1); expect(bodies[0]!.quote).toBeUndefined();
  expect(bodies[0]!.contextRefs[0]).toMatchObject({ referenceKind: 'selection', reference: { text: excerpt } });
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/sessions/${discussion.sessionId}/commands/${bodies[0]!.commandId}`)).json()).status).toBe('unknown');
  await draft.fill('下一条尚未发送的提问。');
  await page.screenshot({ path: testInfo.outputPath('sending.png'), animations: 'disabled' });
  held.release();
  await expect(ui.locator('.reading-message.assistant')).not.toHaveCount(0);
  await expect(row.getByRole('status')).toHaveCount(0); await expect(row).toHaveCount(1);
  await expect(draft).toHaveValue('下一条尚未发送的提问。');
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/sessions/${discussion.sessionId}/page-state`)).json()).draft).toBe('下一条尚未发送的提问。');
  await expect(ui.getByRole('button', { name: '发送给书伴' })).toBeEnabled();
  await ui.getByRole('button', { name: '发送给书伴' }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]!.contextRefs[0].referenceKind).toBe('current-page');
  expect(bodies[1]!.commandId).not.toBe(bodies[0]!.commandId);
  await expect(draft).toHaveValue(''); await expect(ui.locator('.reading-context-preview')).toHaveCount(0);
});

test('明确拒绝自动恢复正文与引用，重试已恢复提问后一起清空', async ({ page, request }) => {
  await openBook(page, request, '拒绝后自动恢复'); const excerpt = await quoteSelection(page);
  const ui = companion(page); const draft = ui.getByLabel('向书伴提问'); const bodies: Record<string, any>[] = [];
  await page.route(turnsRoute, async route => { bodies.push(route.request().postDataJSON()); if (bodies.length === 1) await refuse(route); else await route.continue(); });
  await draft.fill('被拒绝的原始提问。'); await ui.getByRole('button', { name: '发送给书伴' }).click();
  await expect(ui.locator('.reading-send-failed')).toContainText('本次提问未接收');
  await expect(draft).toHaveValue('被拒绝的原始提问。'); await expect(ui.locator('.reading-context-preview')).toContainText(excerpt);
  await ui.getByRole('button', { name: '重试这次提问' }).click();
  await expect(draft).toHaveValue(''); await expect(ui.locator('.reading-context-preview')).toHaveCount(0);
  await expect(ui.locator('.reading-message.assistant')).not.toHaveCount(0);
  expect(bodies).toHaveLength(2); expect(bodies[1]!.commandId).not.toBe(bodies[0]!.commandId);
  expect(bodies[1]!.contextRefs).toEqual(bodies[0]!.contextRefs);
  await expect(ui.locator('.reading-send-failed')).toHaveCount(0);
});

test('从输入框重新发送已恢复提问，替换原失败条目且保留一次引用', async ({ page, request }) => {
  await openBook(page, request, '恢复后直接发送'); const excerpt = await quoteSelection(page);
  const ui = companion(page); const draft = ui.getByLabel('向书伴提问'); const bodies: Record<string, any>[] = [];
  await page.route(turnsRoute, async route => { bodies.push(route.request().postDataJSON()); if (bodies.length === 1) await refuse(route); else await route.continue(); });
  await draft.fill('自动恢复后直接重新发送。'); await ui.getByRole('button', { name: '发送给书伴' }).click();
  await expect(ui.locator('.reading-send-failed')).toBeVisible(); await expect(draft).toHaveValue('自动恢复后直接重新发送。');
  await draft.press('Enter'); await expect(ui.locator('.reading-message.assistant')).not.toHaveCount(0);
  await expect(ui.locator('.reading-send-failed')).toHaveCount(0); await expect(ui.locator('.reading-message.user')).toHaveCount(1);
  await expect(ui.locator('.reading-message.user .reading-source')).toContainText(excerpt); await expect(draft).toHaveValue('');
  expect(bodies).toHaveLength(2); expect(bodies[1]!.commandId).not.toBe(bodies[0]!.commandId);
});

test('拒绝后保留新草稿与新选区，恢复入口不覆盖，直接重试只发送旧快照', async ({ page, request }) => {
  const { discussion } = await openBook(page, request, '失败时保护后续输入'); const original = await quoteSelection(page);
  const ui = companion(page); const draft = ui.getByLabel('向书伴提问'); const held = gate(); const bodies: Record<string, any>[] = [];
  await page.route(turnsRoute, async route => { bodies.push(route.request().postDataJSON()); if (bodies.length === 1) { await held.promise; await refuse(route); } else await route.continue(); });
  await draft.fill('原始提问仍需恢复。'); await ui.getByRole('button', { name: '发送给书伴' }).click();
  await expect(draft).toHaveValue(''); await draft.fill('后续输入不能被恢复覆盖。'); const next = await quoteSelection(page, 12, 20);
  held.release(); await expect(ui.locator('.reading-send-failed')).toBeVisible();
  await expect(draft).toHaveValue('后续输入不能被恢复覆盖。'); await expect(ui.locator('.reading-context-preview')).toContainText(next);
  await expect(ui.getByRole('button', { name: '恢复这次提问' })).toBeDisabled();
  await expect(ui.locator('.reading-send-failed .reading-source')).toContainText(original);
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/sessions/${discussion.sessionId}/page-state`)).json()).draft).toBe('后续输入不能被恢复覆盖。');
  await page.reload(); await resumeReading(page); await expect(draft).toHaveValue('后续输入不能被恢复覆盖。');
  await expect(ui.locator('.reading-context-preview')).toContainText(next); await expect(ui.locator('.reading-send-failed')).toBeVisible();
  await ui.getByRole('button', { name: '重试这次提问' }).click();
  await expect(ui.locator('.reading-message.assistant')).not.toHaveCount(0);
  expect(bodies).toHaveLength(2); expect(bodies[1]!.text).toBe('原始提问仍需恢复。'); expect(bodies[1]!.contextRefs).toEqual(bodies[0]!.contextRefs);
  await expect(draft).toHaveValue('后续输入不能被恢复覆盖。'); await expect(ui.locator('.reading-context-preview')).toContainText(next);
});

test('新选区单独保护草稿版本；清空后可恢复旧正文与引用', async ({ page, request }) => {
  await openBook(page, request, '引用版本保护'); const original = await quoteSelection(page);
  const ui = companion(page); const draft = ui.getByLabel('向书伴提问'); const held = gate();
  await page.route(turnsRoute, async route => { await held.promise; await refuse(route); });
  await draft.fill('原始正文。'); await ui.getByRole('button', { name: '发送给书伴' }).click();
  await expect(draft).toHaveValue(''); const next = await quoteSelection(page, 12, 20);
  held.release(); await expect(ui.locator('.reading-send-failed')).toBeVisible(); await expect(draft).toHaveValue('');
  await expect(ui.locator('.reading-context-preview')).toContainText(next); await expect(ui.getByRole('button', { name: '恢复这次提问' })).toBeDisabled();
  await ui.getByRole('button', { name: '取消本次引用' }).click(); await ui.getByRole('button', { name: '恢复这次提问' }).click();
  await expect(draft).toHaveValue('原始正文。'); await expect(ui.locator('.reading-context-preview')).toContainText(original);
});

test('结果未知跨刷新保留回显和新草稿；原命令重试不改变正文、引用与页面快照', async ({ page, request }) => {
  await page.clock.install(); const { discussion } = await openBook(page, request, '未知发送命令恢复'); const original = await quoteSelection(page);
  const ui = companion(page); const draft = ui.getByLabel('向书伴提问'); const bodies: Record<string, any>[] = []; const queried: string[] = []; let allow = false;
  await page.route(turnsRoute, async route => { bodies.push(route.request().postDataJSON()); if (allow) await route.continue(); else await route.abort('failed'); });
  await page.route(commandsRoute, async route => { const commandId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!); queried.push(commandId); if (allow) await route.continue(); else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ commandId, status: 'unknown', receipt: null }) }); });
  await draft.fill('结果未知的原始正文。'); await ui.getByRole('button', { name: '发送给书伴' }).click();
  await expect(draft).toHaveValue(''); await draft.fill('核对期间的下一条草稿。'); const next = await quoteSelection(page, 12, 20);
  await expect(ui.getByText('正在核对发送结果', { exact: true })).toBeVisible();
  await page.clock.runFor(13_000); await expect(ui.getByRole('button', { name: '按原命令重试' })).toBeEnabled();
  expect(bodies).toHaveLength(1); await expect(ui.locator('.reading-message.user .reading-source')).toContainText(original);
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/sessions/${discussion.sessionId}/page-state`)).json()).draft).toBe('核对期间的下一条草稿。');
  await page.reload(); await resumeReading(page); await expect(draft).toHaveValue('核对期间的下一条草稿。'); await expect(ui.locator('.reading-context-preview')).toContainText(next);
  await expect(ui.locator('.reading-message.user').filter({ hasText: '结果未知的原始正文。' })).toHaveCount(1);
  await expect(ui.locator('.reading-message.user .reading-source')).toContainText(original);
  await page.clock.runFor(13_000); await expect(ui.getByRole('button', { name: '按原命令重试' })).toBeEnabled();
  allow = true; await ui.getByRole('button', { name: '按原命令重试' }).click();
  await expect(ui.locator('.reading-message.assistant')).not.toHaveCount(0);
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(new Set(queried)).toEqual(new Set([bodies[0]!.commandId]));
  await expect(draft).toHaveValue('核对期间的下一条草稿。'); await expect(ui.locator('.reading-context-preview')).toContainText(next);
  await expect(ui.locator('.reading-message.user').filter({ hasText: '结果未知的原始正文。' })).toHaveCount(1);
});

test('POST 回应丢失但服务端已接收，只核对原命令，不重复发送或恢复引用', async ({ page, request }) => {
  await openBook(page, request, '丢失回应后的核对'); const original = await quoteSelection(page);
  const ui = companion(page); const draft = ui.getByLabel('向书伴提问'); const bodies: Record<string, any>[] = [];
  await page.route(turnsRoute, async route => { bodies.push(route.request().postDataJSON()); await route.fetch(); await route.abort('failed'); });
  await draft.fill('已接收但回应丢失。'); await ui.getByRole('button', { name: '发送给书伴' }).click();
  await expect(draft).toHaveValue(''); await draft.fill('此时开始的新草稿。');
  await expect(ui.locator('.reading-message.assistant')).not.toHaveCount(0);
  await expect(ui.locator('.reading-context-preview')).toHaveCount(0); await expect(ui.locator('.reading-send-failed')).toHaveCount(0);
  const row = ui.locator('.reading-message.user').filter({ hasText: '已接收但回应丢失。' });
  await expect(row).toHaveCount(1); await expect(row.locator('.reading-source')).toContainText(original);
  await expect(draft).toHaveValue('此时开始的新草稿。'); expect(bodies).toHaveLength(1);
});

test('丢失回应和接收事件后，执行失败保留真实消息，不撤回为未发送提问', async ({ page, request }) => {
  const { discussion } = await openBook(page, request, '已接收的执行错误'); const excerpt = await quoteSelection(page);
  const ui = companion(page); const draft = ui.getByLabel('向书伴提问');
  await page.route('**/api/sessions/*/events*', route => route.abort('failed'));
  // 关闭已经建立的 SSE，再重新读取共享控制器；之后仅凭终态回执核实接收事实。
  await page.reload(); await resumeReading(page); await expect(draft).toBeEditable();
  let commandId = '';
  await page.route(turnsRoute, async route => { commandId = route.request().postDataJSON().commandId; await route.fetch(); await route.abort('failed'); });
  const text = '工具失败后最终失败：书伴执行错误不撤回提问';
  await draft.fill(text); await ui.getByRole('button', { name: '发送给书伴' }).click();
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/sessions/${discussion.sessionId}/commands/${commandId}`)).json()).receipt?.terminalOutcome).toBe('failed');
  await expect(ui.getByRole('alert')).toBeVisible();
  await expect(draft).toHaveValue(''); await expect(ui.locator('.reading-context-preview')).toHaveCount(0); await expect(ui.locator('.reading-send-failed')).toHaveCount(0);
  const row = ui.locator('.reading-message.user').filter({ hasText: text }); await expect(row).toHaveCount(1); await expect(row.locator('.reading-source')).toContainText(excerpt);
});

test('固定讨论主题持续生效，一次性选区发送后退回主题；同一选区可再次选择', async ({ page, request }) => {
  await openBook(page, request, '固定主题与一次性引用'); const theme = await quoteSelection(page, 2, 10, '单独讨论选区');
  const ui = companion(page); const draft = ui.getByLabel('向书伴提问');
  await expect(ui.locator('.reading-persistent-context')).toContainText('固定主题'); await expect(ui.locator('.reading-context-preview')).toHaveCount(0);
  const bodies: Record<string, any>[] = []; await page.route(turnsRoute, async route => { bodies.push(route.request().postDataJSON()); await route.continue(); });
  const send = async (text: string) => { await draft.fill(text); await ui.getByRole('button', { name: '发送给书伴' }).click(); await expect(ui.getByRole('button', { name: '发送给书伴' })).toBeDisabled(); await expect.poll(() => ui.locator('.reading-message.assistant').count()).toBe(bodies.length); await expect(ui.getByRole('button', { name: '停止书伴' })).toHaveCount(0); };
  await send('围绕固定主题的第一条。'); expect(bodies[0]!.contextRefs[0]).toMatchObject({ referenceKind: 'discussion', reference: { text: theme } });
  const selected = await quoteSelection(page, 12, 20); await send('本轮额外引用另一段。');
  expect(bodies[1]!.contextRefs[0]).toMatchObject({ referenceKind: 'selection', reference: { text: selected } });
  await expect(ui.locator('.reading-context-preview')).toHaveCount(0); await expect(ui.locator('.reading-persistent-context')).toContainText('固定主题');
  await send('恢复围绕固定主题。');
  expect(bodies[2]!.contextRefs[0]).toMatchObject({ referenceKind: 'discussion', reference: { text: theme } });
  await quoteSelection(page, 12, 20); await expect(ui.locator('.reading-context-preview')).toContainText(selected);
});

test('阅读大选区沿用原长度上限，并可在拒绝后完整恢复', async ({ page, request }) => {
  const label = '长选区引用不套用普通引用上限'; await openBook(page, request, label);
  const length = await page.locator('.reading-flow p').filter({ hasText: '阅读上下文应当' }).first().evaluate(element => {
    const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!; const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return new TextEncoder().encode(range.toString()).length;
  });
  expect(length).toBeGreaterThan(4096); await page.getByRole('toolbar', { name: '选区操作' }).getByRole('button', { name: '问书伴', exact: true }).click();
  const ui = companion(page); const draft = ui.getByLabel('向书伴提问'); let body: Record<string, any> | undefined;
  await page.route(turnsRoute, async route => { body = route.request().postDataJSON(); await refuse(route); });
  await draft.fill('完整解释大选区。'); await ui.getByRole('button', { name: '发送给书伴' }).click();
  await expect(ui.locator('.reading-send-failed')).toBeVisible(); await expect(draft).toHaveValue('完整解释大选区。');
  expect(new TextEncoder().encode(body!.contextRefs[0].reference.text).length).toBe(length);
  await expect(ui.locator('.reading-context-preview .reading-context-source')).toHaveAttribute('title', body!.contextRefs[0].reference.text);
});
