import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { fakeApiRoot, openPanel } from './test-state.js';

const document = (page: Page) => page.locator('.notes-open-document:visible');
const markdown = (page: Page) => document(page).getByLabel('Markdown 正文', { exact: true });
const companion = (page: Page) => document(page).getByRole('complementary', { name: '梳理助手', exact: true });
async function openNotes(page: Page, reload = false) {
  if (reload) await page.reload();
  else await page.goto('/');
  await expect(page.getByRole('button', { name: '快捷键', exact: true })).toBeVisible();
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '笔记', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '笔记库' })).toBeVisible();
}
async function create(page: Page, title: string, body: string) {
  const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/notes');
  await page.getByRole('button', { name: '新建笔记', exact: true }).click();
  const note = await (await response).json() as { id: string; revision: number; body: string };
  await document(page).getByLabel('笔记标题', { exact: true }).fill(title);
  await markdown(page).fill(body); await document(page).getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(document(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  return note.id;
}
async function note(request: APIRequestContext, id: string) { return (await request.get(`${fakeApiRoot}/api/notes/${id}`)).json() as Promise<{ id: string; title: string; body: string; revision: number }>; }

test('新建编辑、建议生成不改正文、拒绝及接受、刷新恢复决定（受控模型夹具）', async ({ page, request }, testInfo) => {
  await openNotes(page);
  const original = '# 笔记\n\n第一段待润色。\n\n第二段保留。';
  const id = await create(page, `笔记闭环-${crypto.randomUUID()}`, original);
  const root = await (await request.post(`${fakeApiRoot}/api/notes/${id}/companion`)).json() as { sessionId: string };
  const ui = companion(page);
  await expect(ui.getByRole('button', { name: '生成修改建议', exact: true })).toBeEnabled();
  await ui.getByRole('button', { name: '生成修改建议', exact: true }).click();
  await expect(ui.locator('.note-message.assistant')).not.toHaveCount(0);
  await expect(ui.getByRole('button', { name: '生成修改建议', exact: true })).toBeEnabled();
  // 测试控制路由只在Fake E2E注册；生产路径仍由真实Pi输出。
  const response = await request.post(`${fakeApiRoot}/api/__e2e/assistant/events/body`, { data: {
    sessionId: root.sessionId, messageId: `note-test-${crypto.randomUUID()}`, completed: true,
    delta: '```json\n' + JSON.stringify({ suggestions: [
      { reason: '改进第一段表述', before: '第一段待润色。', after: '第一段已润色。' },
      { reason: '调整第二段表述', before: '第二段保留。', after: '第二段也修改。' },
    ] }) + '\n```',
  } }); expect(response.ok()).toBeTruthy();
  await ui.getByRole('button', { name: '查看修改建议', exact: true }).click();
  await expect(ui.locator('.note-suggestion')).toHaveCount(2);
  expect((await note(request, id)).body).toBe(original);
  await ui.locator('.note-suggestion').filter({ hasText: '调整第二段表述' }).getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(ui.locator('.note-suggestion').filter({ hasText: '调整第二段表述' })).toContainText('已拒绝');
  expect((await note(request, id)).body).toBe(original);
  await ui.locator('.note-suggestion').filter({ hasText: '改进第一段表述' }).getByRole('button', { name: '接受', exact: true }).click();
  await expect(markdown(page)).toHaveValue(original.replace('第一段待润色。', '第一段已润色。'));
  await openNotes(page, true);
  await expect(markdown(page)).toHaveValue(original.replace('第一段待润色。', '第一段已润色。'));
  await expect(companion(page).locator('.note-suggestion').filter({ hasText: '改进第一段表述' })).toContainText('已接受');
  await expect(companion(page).locator('.note-suggestion').filter({ hasText: '调整第二段表述' })).toContainText('已拒绝');
  await page.screenshot({ path: testInfo.outputPath('notes-three-columns.png'), animations: 'disabled' });
});

test('未保存正文跨笔记切换和刷新恢复，不进入服务端正文', async ({ page, request }) => {
  await openNotes(page); const title = `草稿-${crypto.randomUUID()}`;
  const id = await create(page, title, '服务端正文');
  await markdown(page).fill('本机未保存正文');
  await document(page).getByRole('button', { name: '梳理助手', exact: true }).click();
  await expect(companion(page)).toBeHidden();
  await expect(markdown(page)).toHaveValue('本机未保存正文');
  await document(page).getByRole('button', { name: '梳理助手', exact: true }).click();
  await expect(companion(page)).toBeVisible();
  await create(page, `其他笔记-${crypto.randomUUID()}`, '另一篇的内容');
  await page.getByRole('complementary', { name: '笔记库' }).getByRole('button').filter({ hasText: title }).click();
  await expect(markdown(page)).toHaveValue('本机未保存正文');
  await openNotes(page, true); await expect(markdown(page)).toHaveValue('本机未保存正文');
  expect((await note(request, id)).body).toBe('服务端正文');
});

test('保存失败保持原命令，迟到重试不丢后来输入', async ({ page, request }) => {
  await openNotes(page); const id = await create(page, `失败重试-${crypto.randomUUID()}`, '原正文');
  const bodies: Record<string, unknown>[] = []; let fail = true;
  await page.route(`**/api/notes/${id}`, async route => {
    if (route.request().method() !== 'PUT') { await route.continue(); return; }
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    if (fail) await route.abort('failed'); else await route.continue();
  });
  await markdown(page).fill('第一次待保存'); await document(page).getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(document(page).getByRole('button', { name: '核对并重试保存', exact: true })).toBeEnabled();
  await markdown(page).fill('失败之后继续输入'); fail = false;
  await document(page).getByRole('button', { name: '核对并重试保存', exact: true }).click();
  await expect(document(page).getByRole('button', { name: '保存笔记', exact: true })).toBeEnabled();
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
  expect((await note(request, id)).body).toBe('第一次待保存');
  await expect(markdown(page)).toHaveValue('失败之后继续输入');
  await document(page).getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(document(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  expect((await note(request, id)).body).toBe('失败之后继续输入');
  expect(bodies[2]!.commandId).not.toBe(bodies[0]!.commandId);
});

test('两个窗口的正文版本冲突保留草稿并要求显式核对', async ({ page, context, request }) => {
  await openNotes(page); const title = `多窗口-${crypto.randomUUID()}`;
  const id = await create(page, title, '共同基线');
  const other = await context.newPage(); await openNotes(other);
  await other.getByRole('complementary', { name: '笔记库' }).getByRole('button').filter({ hasText: title }).click();
  await expect(markdown(other)).toHaveValue('共同基线');
  await markdown(page).fill('窗口A的未保存正文');
  await markdown(other).fill('窗口B的新正文'); await document(other).getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(document(other).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  await expect(document(page).locator('.note-conflict')).toContainText('本机草稿已保留');
  await expect(markdown(page)).toHaveValue('窗口A的未保存正文');
  await expect(document(page).getByRole('button', { name: '保存笔记', exact: true })).toBeDisabled();
  expect((await note(request, id)).body).toBe('窗口B的新正文'); await other.close();
});

test('选区引用、深入及返回、刷新恢复讨论层级（受控模型夹具）', async ({ page }) => {
  await openNotes(page); await create(page, `分层-${crypto.randomUUID()}`, '第一段选区。\n第二段内容。');
  const select = async () => {
    const editor = markdown(page);
    await editor.focus();
    await editor.press('ControlOrMeta+A');
    await editor.press('ArrowLeft');
    for (let i = 0; i < 6; i++) await editor.press('Shift+ArrowRight');
    await expect(document(page).getByRole('toolbar', { name: '笔记选区操作' })).toBeVisible();
  };
  await select(); await document(page).getByRole('button', { name: '引用给助手', exact: true }).click();
  await expect(companion(page).locator('.note-companion-composer .note-quote')).toContainText('第一段选区。');
  await companion(page).getByLabel('向梳理助手提问', { exact: true }).fill('解释这段');
  await companion(page).getByLabel('向梳理助手提问', { exact: true }).press('Enter');
  await expect(companion(page).locator('.note-message.user')).toContainText('带选区');
  await expect(companion(page).locator('.note-message.assistant')).not.toHaveCount(0);
  await expect(companion(page).getByRole('button', { name: '生成修改建议', exact: true })).toBeEnabled();
  await select(); await document(page).getByRole('toolbar', { name: '笔记选区操作' }).getByRole('button', { name: '深入一层', exact: true }).click();
  await expect(companion(page).getByRole('button', { name: '返回上一层', exact: true })).toBeVisible();
  await expect(companion(page).locator('.note-thread:visible > .note-quote')).toContainText('第一段选区。');
  await openNotes(page, true); await expect(companion(page).getByRole('button', { name: '返回上一层', exact: true })).toBeVisible();
  await companion(page).getByRole('button', { name: '返回上一层', exact: true }).click();
  await expect(companion(page).locator('.note-thread:visible .note-message.user')).toContainText('解释这段');
});

test('服务重启后正文、版本和分层主题从数据库恢复', async ({ page, request }) => {
  await openNotes(page); const id = await create(page, `重启-${crypto.randomUUID()}`, '重启后保留正文。');
  const saved = await note(request, id);
  const root = await (await request.post(`${fakeApiRoot}/api/notes/${id}/companion`)).json() as { sessionId: string };
  const frozen = await (await request.post(`${fakeApiRoot}/api/notes/${id}/contexts`, { data: { commandId: crypto.randomUUID(), id: crypto.randomUUID(), sessionId: root.sessionId, revision: saved.revision, selection: { start: 0, end: 3, text: '重启后' } } })).json() as { id: string };
  const child = await (await request.post(`${fakeApiRoot}/api/notes/${id}/discussions`, { data: { commandId: crypto.randomUUID(), sessionId: crypto.randomUUID(), parentSessionId: root.sessionId, source: { kind: 'selection', snapshotId: frozen.id } } })).json() as { sessionId: string };
  expect((await request.post(`${fakeApiRoot}/api/__e2e/restart`)).status()).toBe(202);
  // 沿用现有重启用例的等待：避免202返回后、旧进程退出前读到旧服务的200。
  await new Promise(resolve => setTimeout(resolve, 300));
  await expect.poll(async () => { try { return (await request.get(`${fakeApiRoot}/api/notes/${id}`, { timeout: 1000 })).status(); } catch { return 0; } }, { timeout: 30000 }).toBe(200);
  expect(await note(request, id)).toEqual(saved);
  const restored = await (await request.get(`${fakeApiRoot}/api/notes/${id}/discussions`)).json() as { discussions: { sessionId: string; topic: { text: string } | null }[] };
  expect(restored.discussions.find(d => d.sessionId === child.sessionId)?.topic?.text).toBe('重启后');
  await openNotes(page, true); await expect(markdown(page)).toHaveValue(saved.body);
});


test('笔记界面适配实际容器，讨论弹层支持键盘且不裁切，切换尺寸保留输入', async ({ page, request }, testInfo) => {
  await openNotes(page);
  await create(page, '随手记 · 灵感和问题', '留下想法，也记录尚待回答的问题。');
  await create(page, '工作随想 · 留一点思考的空间', '把零散观察写下来，再慢慢整理。');
  const body = '# 产品方向\n\n让记录保持轻松，让整理发生在需要的时候。\n\n## 接下来想清楚的事\n\n- 哪些内容值得长期保留？\n- 如何从想法走向具体行动？\n\n先写下来，再和梳理助手一起讨论。';
  const id = await create(page, '产品想法 · 从记录到行动', body);
  const saved = await note(request, id);
  const root = await (await request.post(`${fakeApiRoot}/api/notes/${id}/companion`)).json() as { sessionId: string };
  const frozen = await (await request.post(`${fakeApiRoot}/api/notes/${id}/contexts`, { data: { commandId: crypto.randomUUID(), id: crypto.randomUUID(), sessionId: root.sessionId, revision: saved.revision, selection: { start: 0, end: 6, text: body.slice(0, 6) } } })).json() as { id: string };
  expect((await request.post(`${fakeApiRoot}/api/notes/${id}/discussions`, { data: { commandId: crypto.randomUUID(), sessionId: crypto.randomUUID(), parentSessionId: root.sessionId, source: { kind: 'selection', snapshotId: frozen.id } } })).ok()).toBeTruthy();
  const draft = body + '\n\n这段输入还没有保存。';
  await markdown(page).fill(draft);
  for (const width of [1920, 1440, 900, 1120]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 1120) {
      await page.keyboard.press('ControlOrMeta+j');
      await expect(page.locator('.management-shell.with-sidebar')).toBeVisible();
    }
    await expect(markdown(page)).toBeVisible();
    await expect(markdown(page)).toHaveValue(draft);
    const bounds = await markdown(page).boundingBox();
    expect(bounds!.width).toBeGreaterThan(300);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => window.document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath(`notes-polished-${width}.png`), animations: 'disabled' });
    const picker = companion(page).getByRole('button', { name: /^恢复笔记讨论/ });
    await picker.scrollIntoViewIfNeeded();
    await picker.press('ArrowDown');
    const menu = page.getByRole('listbox', { name: '恢复笔记讨论' });
    await expect(menu.getByRole('option')).toHaveCount(2);
    const menuBounds = await menu.boundingBox();
    expect(menuBounds!.x).toBeGreaterThanOrEqual(0);
    expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(width);
    expect(menuBounds!.y).toBeGreaterThanOrEqual(0);
    expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(900);
    await page.screenshot({ path: testInfo.outputPath(`notes-discussion-menu-${width}.png`), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(picker).toBeFocused();
  }
  const picker = companion(page).getByRole('button', { name: /^恢复笔记讨论/ });
  await picker.click();
  await page.getByRole('listbox', { name: '恢复笔记讨论' }).getByRole('option').filter({ hasText: '独立讨论' }).click();
  await expect(companion(page).getByRole('button', { name: '返回上一层', exact: true })).toBeVisible();
  await expect(picker).toBeFocused();
  await expect(markdown(page)).toHaveValue(draft);
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.getByRole('heading', { name: '管理请在桌面使用', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(markdown(page)).toBeVisible();
  await expect(markdown(page)).toHaveValue(draft);
});

test('标题可换行编辑并用 Enter 和 Esc 结束，正文与提问框无黑色描边，快捷保存保留草稿', async ({ page, request }, testInfo) => {
  await openNotes(page);
  const originalTitle = `标题编辑-${crypto.randomUUID()}`;
  const id = await create(page, originalTitle, '正文内容保持独立。');
  const title = document(page).getByLabel('笔记标题', { exact: true });
  const longTitle = '把零散的想法写下来，让记录有足够的空间，再慢慢梳理成能够理解和使用的内容';
  await title.fill(longTitle);
  await expect(document(page).locator('.note-title-hint')).toBeVisible();
  const size = await title.evaluate(element => ({ height: element.clientHeight, scroll: element.scrollHeight, line: Number.parseFloat(getComputedStyle(element).lineHeight) }));
  expect(size.height).toBeGreaterThan(size.line * 1.8);
  expect(size.scroll).toBeLessThanOrEqual(size.height + 2);
  expect(await title.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('none');
  await page.screenshot({ path: testInfo.outputPath('notes-title-editing.png'), animations: 'disabled' });
  await title.press('Enter');
  await expect(markdown(page)).toBeFocused();
  expect((await note(request, id)).title).toBe(originalTitle);
  await markdown(page).fill('正文输入在撤销标题之后仍然保留。');
  await title.fill('临时标题');
  await title.press('Escape');
  await expect(title).toHaveValue(longTitle);
  await expect(markdown(page)).toBeFocused();
  await expect(markdown(page)).toHaveValue('正文输入在撤销标题之后仍然保留。');
  await expect(document(page).locator('.note-editing-indicator')).toBeVisible();
  expect(await markdown(page).evaluate(element => getComputedStyle(element).outlineStyle)).toBe('none');
  await page.screenshot({ path: testInfo.outputPath('notes-body-editing.png'), animations: 'disabled' });
  await markdown(page).press('ControlOrMeta+s');
  await expect(document(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  const saved = await note(request, id);
  expect(saved.title).toBe(longTitle);
  expect(saved.body).toBe('正文输入在撤销标题之后仍然保留。');
  const question = companion(page).getByLabel('向梳理助手提问', { exact: true });
  await question.click();
  await expect(question).toBeFocused();
  expect(await question.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('none');
  await openNotes(page, true);
  await expect(title).toHaveValue(longTitle);
  await expect(markdown(page)).toHaveValue(saved.body);
});
