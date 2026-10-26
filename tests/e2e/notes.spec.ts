import { expectNoteBody, replaceNoteBody } from './notes-helpers.js';
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { fakeApiRoot, openPanel } from './test-state.js';
import type { Editor } from '@tiptap/core';

const document = (page: Page) => page.locator('.notes-open-document:visible');
const markdown = (page: Page) => document(page).getByLabel('笔记正文', { exact: true });
const deleteButton = (page: Page, retry = false) => page.getByRole('complementary', { name: '笔记库' }).getByRole('button', { name: retry ? '核对并重试删除' : '删除笔记', exact: true });
async function clickDelete(page: Page, retry = false) {
  await page.locator('.notes-library-item[data-selected="true"]').hover();
  await deleteButton(page, retry).click();
}
const companion = (page: Page) => document(page).getByRole('complementary', { name: '梳理助手', exact: true });
async function openNotes(page: Page, reload = false) {
  if (reload) await page.reload();
  else await page.goto('/');
  await expect(page.getByRole('button', { name: '快捷键', exact: true })).toBeVisible();
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '笔记', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '笔记库' })).toBeVisible();
}
async function create(page: Page, title: string, body: string, withAssistant = true) {
  const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/notes');
  await page.getByRole('button', { name: '新建笔记', exact: true }).click();
  const note = await (await response).json() as { id: string; revision: number; body: string };
  await document(page).getByLabel('笔记标题', { exact: true }).fill(title);
  await replaceNoteBody(page, body); await document(page).getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(document(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  const toggle = document(page).getByRole('button', { name: '梳理助手', exact: true });
  if (withAssistant && await toggle.getAttribute('aria-pressed') === 'false') await toggle.click();
  return note.id;
}
async function note(request: APIRequestContext, id: string) { return (await request.get(`${fakeApiRoot}/api/notes/${id}`)).json() as Promise<{ id: string; title: string; body: string; revision: number }>; }

test('助手只讨论当前笔记，使用最新正文并在刷新后保留对话', async ({ page, request }, testInfo) => {
  const advancedRequests: string[] = [];
  page.on('request', request => { if (/\/api\/notes\/[^/]+\/(discussions|suggestions)(\/|$)/u.test(new URL(request.url()).pathname)) advancedRequests.push(request.url()); });
  await openNotes(page);
  const original = '# 随手记\n\n先把想法写下来，再慢慢思考。';
  const id = await create(page, `简单讨论-${crypto.randomUUID()}`, original);
  const ui = companion(page), question = ui.getByLabel('向梳理助手提问', { exact: true });
  await expect(ui.getByText('聊聊这篇笔记', { exact: true })).toBeVisible();
  await question.fill('这篇笔记表达了什么？');
  await question.press('Enter');
  await expect(ui.locator('.note-message.assistant')).toHaveCount(1);
  await expect(ui.getByRole('button', { name: '发送给梳理助手', exact: true })).toBeVisible();
  expect((await note(request, id)).body).toBe(original);
  const updated = original + '\n\n也留意那些尚未想清楚的问题。';
  await replaceNoteBody(page, updated);
  await question.fill('结合新加的内容再聊聊。');
  const snapshotResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/notes/${id}/contexts` && response.request().method() === 'POST');
  await question.press('Enter');
  const snapshot = await (await snapshotResponse).json() as { revision: number };
  await expect(ui.locator('.note-message.assistant')).toHaveCount(2);
  const saved = await note(request, id);
  expect(saved.body).toBe(updated); expect(snapshot.revision).toBe(saved.revision);
  await openNotes(page, true);
  await expect(companion(page).locator('.note-message.user')).toHaveCount(2);
  await expect(companion(page)).toContainText('结合新加的内容再聊聊。');
  await expect(companion(page).getByRole('navigation')).toHaveCount(0);
  await expect(companion(page).getByRole('button', { name: /深入|修改建议|接受|拒绝|整理结构|润色|梳理关联/u })).toHaveCount(0);
  expect(advancedRequests).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('notes-simple-chat.png'), animations: 'disabled' });
});

test('未保存正文跨笔记切换和刷新恢复，不进入服务端正文', async ({ page, request }) => {
  await openNotes(page); const title = `草稿-${crypto.randomUUID()}`;
  const id = await create(page, title, '服务端正文');
  await replaceNoteBody(page, '本机未保存正文');
  await document(page).getByRole('button', { name: '梳理助手', exact: true }).click();
  await expect(companion(page)).toBeHidden();
  await expectNoteBody(page, '本机未保存正文');
  await document(page).getByRole('button', { name: '梳理助手', exact: true }).click();
  await expect(companion(page)).toBeVisible();
  await create(page, `其他笔记-${crypto.randomUUID()}`, '另一篇的内容');
  await page.getByRole('complementary', { name: '笔记库' }).getByRole('button').filter({ hasText: title }).click();
  await expectNoteBody(page, '本机未保存正文');
  await openNotes(page, true); await expectNoteBody(page, '本机未保存正文');
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
  await replaceNoteBody(page, '第一次待保存'); await document(page).getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(document(page).getByRole('button', { name: '核对并重试保存', exact: true })).toBeEnabled();
  await expect(document(page).getByRole('button', { name: '重试保存', exact: true })).toBeVisible();
  await replaceNoteBody(page, '失败之后继续输入');
  await expect(document(page).getByRole('button', { name: '重试保存', exact: true })).toBeVisible();
  fail = false;
  await document(page).getByRole('button', { name: '核对并重试保存', exact: true }).click();
  await expect(document(page).getByRole('button', { name: '保存笔记', exact: true })).toBeEnabled();
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
  expect((await note(request, id)).body).toBe('第一次待保存');
  await expectNoteBody(page, '失败之后继续输入');
  await document(page).getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(document(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  expect((await note(request, id)).body).toBe('失败之后继续输入');
  expect(bodies[2]!.commandId).not.toBe(bodies[0]!.commandId);
});

test('段尾及空段落软换行可继续输入撤销重做，保存再加载保留未编辑原文', async ({ page, request }, testInfo) => {
  await openNotes(page);
  for (const first of ['段尾', '']) {
    const suffix = '\n\n\n末段 **保留**。 \n';
    const id = await create(page, `软换行-${first || '空段落'}-${crypto.randomUUID()}`, (first || '&nbsp;') + suffix, false);
    const body = markdown(page), paragraph = body.locator('p').first();
    await body.focus(); await body.press('ControlOrMeta+Home');
    for (let i = 0; i < first.length; i++) await body.press('ArrowRight');
    await body.press('Shift+Enter');
    const breaks = paragraph.locator('br:not(.ProseMirror-trailingBreak)');
    await expect(breaks).toHaveCount(1);
    await expect(document(page).getByRole('alert')).toHaveCount(0);
    await document(page).getByRole('button', { name: '撤销正文修改', exact: true }).click();
    await expect(breaks).toHaveCount(0);
    await document(page).getByRole('button', { name: '重做正文修改', exact: true }).click();
    await expect(breaks).toHaveCount(1);
    await page.keyboard.insertText('继续输入');
    await expect(paragraph).toHaveText(first + '继续输入');
    await document(page).getByRole('button', { name: '保存笔记', exact: true }).click();
    await expect(document(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
    const saved = await note(request, id);
    expect(saved.body).toBe(first + '<br />继续输入' + suffix);
    await openNotes(page, true);
    await expect(paragraph).toHaveText(first + '继续输入'); await expect(breaks).toHaveCount(1);
    await testInfo.attach(`soft-break-${first || 'empty'}.json`, { body: JSON.stringify(saved, null, 2), contentType: 'application/json' });
  }
});

test('含边界空格选区加粗和斜体保留选区，继续输入和保存回读正确', async ({ page, request }, testInfo) => {
  await openNotes(page);
  for (const [label, tag] of [['粗体', 'strong'], ['斜体', 'em']] as const) {
    const suffix = '\n\n\n末段 **保留**。 \n';
    const id = await create(page, `格式空格-${label}-${crypto.randomUUID()}`, '前  选中文字  后' + suffix, false);
    const body = markdown(page), paragraph = body.locator('p').first();
    await body.focus(); await body.press('ControlOrMeta+Home'); await body.press('ArrowRight');
    for (let i = 0; i < '  选中文字  '.length; i++) await body.press('Shift+ArrowRight');
    await document(page).getByRole('button', { name: label, exact: true }).click();
    await expect(paragraph.locator(tag)).toHaveText('选中文字');
    expect(await body.evaluate(() => window.getSelection()?.toString())).toBe('  选中文字  ');
    await expect(document(page).getByRole('alert')).toHaveCount(0);
    await document(page).getByRole('button', { name: '撤销正文修改', exact: true }).click(); await expect(paragraph.locator(tag)).toHaveCount(0);
    await document(page).getByRole('button', { name: '重做正文修改', exact: true }).click(); await expect(paragraph.locator(tag)).toHaveText('选中文字');
    await body.press('ArrowRight'); await page.keyboard.insertText('继续输入');
    await document(page).getByRole('button', { name: '保存笔记', exact: true }).click();
    await expect(document(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
    const saved = await note(request, id); expect(saved.body.endsWith(suffix)).toBeTruthy();
    await openNotes(page, true); await expect(paragraph.locator(tag)).toHaveText('选中文字');
    await expect(paragraph).toHaveText('前  选中文字  继续输入后');
    await testInfo.attach(`format-${tag}.json`, { body: JSON.stringify(saved, null, 2), contentType: 'application/json' });
  }
});

test('转换拒绝保留正文草稿，返回编辑恢复焦点，后续合法输入清除转换提示', async ({ page }, testInfo) => {
  await openNotes(page);
  await create(page, `转换恢复-${crypto.randomUUID()}`, '原正文', false);
  const body = markdown(page);
  const draft = () => page.evaluate(() => {
    const id = sessionStorage.getItem('multivac:active-note');
    const key = sessionStorage.getItem(`multivac:note-draft-pointer:${id}`);
    return key ? localStorage.getItem(key) : null;
  });
  const puts: string[] = [];
  page.on('request', request => { if (request.method() === 'PUT' && /\/api\/notes\//u.test(request.url())) puts.push(request.postData() ?? ''); });
  const reject = async () => {
    await body.focus(); await body.press('ControlOrMeta+Home');
    await body.press('Shift+ArrowRight'); await body.press('Shift+ArrowRight');
    await body.evaluate(element => {
      const editor = (element as HTMLElement & { editor: Editor }).editor;
      const manager = editor.markdown!, original = manager.serialize;
      manager.serialize = function () {
        manager.serialize = original;
        throw new Error('受控转换异常');
      };
    });
    await document(page).getByRole('button', { name: '粗体', exact: true }).click();
  };
  const before = await draft();
  await reject();
  await expect(document(page).getByRole('alert')).toContainText('刚才这次正文修改未写入');
  await expect(body).toHaveText('原正文'); expect(await draft()).toBe(before);
  await expect(document(page).getByRole('button', { name: '重试保存', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('note-conversion-refused.png'), animations: 'disabled' });
  await document(page).getByRole('button', { name: '返回编辑', exact: true }).click();
  await expect(body).toBeFocused(); await expect(document(page).getByRole('alert')).toHaveCount(0);
  expect(puts).toHaveLength(0); expect(await draft()).toBe(before);
  await reject();
  await body.press('ArrowRight'); await page.keyboard.insertText('合法输入');
  await expect(body).toContainText('合法输入');
  await expect(document(page).getByRole('alert')).toHaveCount(0);
  await document(page).getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(document(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  await openNotes(page, true); await expect(body).toContainText('合法输入');
  await expect(document(page).getByRole('button', { name: '返回编辑', exact: true })).toHaveCount(0);
});

test('两个窗口的正文版本冲突保留草稿并要求显式核对', async ({ page, context, request }) => {
  await openNotes(page); const title = `多窗口-${crypto.randomUUID()}`;
  const id = await create(page, title, '共同基线');
  const other = await context.newPage(); await openNotes(other);
  await other.getByRole('complementary', { name: '笔记库' }).getByRole('button').filter({ hasText: title }).click();
  await expectNoteBody(other, '共同基线');
  await replaceNoteBody(page, '窗口A的未保存正文');
  await replaceNoteBody(other, '窗口B的新正文'); await document(other).getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(document(other).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  await expect(document(page).locator('.note-conflict')).toContainText('本机草稿已保留');
  await expectNoteBody(page, '窗口A的未保存正文');
  await expect(document(page).getByRole('button', { name: '保存笔记', exact: true })).toBeDisabled();
  expect((await note(request, id)).body).toBe('窗口B的新正文'); await other.close();
});

test('选区引用提问后刷新恢复主对话，不恢复旧子层选择', async ({ page, request }) => {
  await openNotes(page); const id = await create(page, `引用讨论-${crypto.randomUUID()}`, '第一段选区。\n第二段内容。');
  const editor = markdown(page);
  await editor.focus(); await editor.press('ControlOrMeta+A'); await editor.press('ArrowLeft');
  for (let i = 0; i < 6; i++) await editor.press('Shift+ArrowRight');
  await document(page).getByRole('button', { name: '引用给助手', exact: true }).click();
  await expect(companion(page).locator('.note-companion-composer .note-quote')).toContainText('第一段选区。');
  await companion(page).getByLabel('向梳理助手提问', { exact: true }).fill('解释这段');
  const snapshotResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/notes/${id}/contexts` && response.request().method() === 'POST');
  await companion(page).getByLabel('向梳理助手提问', { exact: true }).press('Enter');
  const snapshot = await (await snapshotResponse).json() as { id: string; sessionId: string; selection: { start: number; end: number; text: string } };
  expect(snapshot.selection).toEqual({ start: 0, end: 6, text: '第一段选区。' });
  await expect(companion(page).locator('.note-message.assistant')).toHaveCount(1);
  // 旧子讨论仍留在数据库；页面固定使用主对话，不再恢复分层导航。
  const child = await (await request.post(`${fakeApiRoot}/api/notes/${id}/discussions`, { data: { commandId: crypto.randomUUID(), sessionId: crypto.randomUUID(), parentSessionId: snapshot.sessionId, source: { kind: 'selection', snapshotId: snapshot.id } } })).json() as { sessionId: string };
  await page.evaluate(({ id, childId }) => sessionStorage.setItem(`multivac:note-discussion:${id}`, childId), { id, childId: child.sessionId });
  await openNotes(page, true);
  await expect(companion(page).locator('.note-message.user')).toContainText('解释这段');
  await expect(companion(page).getByRole('navigation')).toHaveCount(0);
  const stored = await (await request.get(`${fakeApiRoot}/api/notes/${id}/discussions`)).json() as { discussions: { sessionId: string }[] };
  expect(stored.discussions.some(discussion => discussion.sessionId === child.sessionId)).toBeTruthy();
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
  await openNotes(page, true); await expectNoteBody(page, saved.body);
});


test('简单笔记助手适配实际容器，切换尺寸保留正文与提问草稿', async ({ page, request }, testInfo) => {
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
  await replaceNoteBody(page, draft);
  for (const width of [1920, 1440, 900, 1120]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 1120) {
      await page.keyboard.press('ControlOrMeta+j');
      await expect(page.locator('.management-shell.with-sidebar')).toBeVisible();
    }
    await expect(markdown(page)).toBeVisible();
    await expectNoteBody(page, draft);
    const bounds = await markdown(page).boundingBox();
    expect(bounds!.width).toBeGreaterThan(300);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => window.document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath(`notes-polished-${width}.png`), animations: 'disabled' });
    const question = companion(page).getByLabel('向梳理助手提问', { exact: true });
    await question.scrollIntoViewIfNeeded();
    await question.fill('这段还没发送的提问保留下来。');
    await expect(companion(page).getByRole('navigation')).toHaveCount(0);
  }
  await expect(companion(page).getByLabel('向梳理助手提问', { exact: true })).toHaveValue('这段还没发送的提问保留下来。');
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.getByRole('heading', { name: '管理请在桌面使用', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(markdown(page)).toBeVisible();
  await expectNoteBody(page, draft);
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
  await replaceNoteBody(page, '正文输入在撤销标题之后仍然保留。');
  await title.fill('临时标题');
  await title.press('Escape');
  await expect(title).toHaveValue(longTitle);
  await expect(markdown(page)).toBeFocused();
  await expectNoteBody(page, '正文输入在撤销标题之后仍然保留。');
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
  await expectNoteBody(page, saved.body);
});

test('文档直接呈现并编辑格式，搜索、专注与刷新保留草稿和助手输入', async ({ page, request }, testInfo) => {
  await openNotes(page);
  await create(page, '每周回顾', '另一篇笔记', false);
  const original = '先留下想法。\n\n## 给思考留一点空间\n\n记录**有价值的部分**。\n\n> 有机会再想一遍。\n\n- 值得继续追问的问题';
  const id = await create(page, '让想法慢慢成形', original, false);
  const draft = original + '\n\n这句话留在草稿里。';
  await replaceNoteBody(page, draft);
  const body = markdown(page);
  await expect(body.getByRole('heading', { name: '给思考留一点空间', exact: true })).toBeVisible();
  await expect(body.locator('strong')).toHaveText('有价值的部分');
  await expect(body.locator('blockquote')).toContainText('有机会再想一遍');
  await expect(document(page).getByRole('group', { name: '笔记显示模式' })).toHaveCount(0);
  await expect(document(page).getByRole('button', { name: /^(编辑|阅读)$/ })).toHaveCount(0);
  const search = page.getByRole('searchbox', { name: '搜索笔记标题', exact: true });
  await search.fill('让想法慢慢成形');
  await expect(page.locator('.notes-library-item > .note-list-open')).toHaveCount(1);
  await search.fill('不存在的笔记');
  await expect(page.getByText('没有匹配的笔记', { exact: true })).toBeVisible();
  await expectNoteBody(page, draft);
  await search.press('Escape'); await expect(search).toHaveValue('');
  await document(page).getByRole('button', { name: '梳理助手', exact: true }).click();
  const question = companion(page).getByLabel('向梳理助手提问', { exact: true });
  await question.fill('这段想法我还想继续讨论');
  await document(page).getByRole('button', { name: '专注写作', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '笔记库', exact: true })).toBeHidden();
  await expect(companion(page)).toBeHidden();
  await expect(body.locator('strong')).toHaveText('有价值的部分');
  await page.screenshot({ path: testInfo.outputPath('notes-wysiwyg-focus.png'), animations: 'disabled' });
  await document(page).getByRole('button', { name: '退出专注写作', exact: true }).click();
  await expect(question).toHaveValue('这段想法我还想继续讨论');
  expect((await note(request, id)).body).toBe(original);
  await openNotes(page, true); await expectNoteBody(page, draft);
  await expect(body.locator('strong')).toHaveText('有价值的部分');
});

test('长正文与标题统一滚动，切换笔记和专注保留渲染及草稿', async ({ page }) => {
  await openNotes(page);
  const body = Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 段。记录一些需要继续思考的内容。`).join('\n\n') + '\n';
  await create(page, '长文直接编辑', body, false);
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 900 });
    await markdown(page).focus(); await markdown(page).press('ControlOrMeta+End');
    await expect.poll(() => document(page).evaluate(element => Math.max(...Array.from(element.querySelectorAll('.notes-detail, .note-document-scroll'), scroller => scroller.scrollTop)))).toBeGreaterThan(300);
    await expect(markdown(page).locator('p').last()).toContainText('第 80 段');
    const geometry = await markdown(page).evaluate(element => ({ height: element.clientHeight, scroll: element.scrollHeight }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.height + 2);
    await expectNoteBody(page, body);
  }
});

test('选区浮条不挤动正文，支持键盘和关闭，专注模式引用后显示助手', async ({ page, request }, testInfo) => {
  await openNotes(page);
  const body = '让想法慢慢成形。\n\n先留下值得思考的问题，再整理其中的联系。';
  const id = await create(page, '选中文字，继续思考', body, false);
  const editor = markdown(page);
  const select = async () => {
    await editor.focus(); await editor.press('ControlOrMeta+A'); await editor.press('ArrowLeft');
    for (let i = 0; i < 6; i++) await editor.press('Shift+ArrowRight');
  };
  const before = await editor.boundingBox();
  await select();
  const bar = document(page).getByRole('toolbar', { name: '笔记选区操作' });
  await expect(bar).toBeVisible();
  expect(await editor.boundingBox()).toEqual(before);
  const bounds = (await bar.boundingBox())!;
  expect(bounds.width).toBeLessThan(100);
  await expect(bar.getByRole('button')).toHaveCount(1);
  expect(bounds.height).toBeLessThan(42);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(before!.y + 2);
  await expect(bar).not.toContainText('已选中');
  await page.screenshot({ path: testInfo.outputPath('notes-selection-bubble.png'), animations: 'disabled' });
  await editor.press('Tab');
  await expect(bar.getByRole('button', { name: '引用给助手', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();
  await expect(editor).toBeFocused();
  await expectNoteBody(page, body);
  expect(await editor.evaluate(() => window.getSelection()?.toString())).toBe(body.slice(0, 6));
  await select(); await expect(bar).toBeVisible();
  await document(page).getByLabel('笔记标题', { exact: true }).click();
  await expect(bar).toBeHidden();
  await select(); await expect(bar).toBeVisible();
  await editor.press('ArrowRight'); await expect(bar).toBeHidden();
  await document(page).getByRole('button', { name: '专注写作', exact: true }).click();
  await select(); await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: '引用给助手', exact: true }).click();
  await expect(document(page).getByRole('button', { name: '专注写作', exact: true })).toBeVisible();
  await expect(companion(page)).toBeVisible();
  await expect(companion(page).locator('.note-companion-composer .note-quote')).toContainText(body.slice(0, 6));
  await expect(bar).toBeHidden();
  expect((await note(request, id)).body).toBe(body);
});

test('拖选完成后显示浮条，长文滚动与窗口收窄时贴近可见选区', async ({ page }) => {
  await openNotes(page);
  await create(page, '长文中的选区操作', Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 段：让文字自然流动，选中需要继续讨论的部分。`).join('\n\n'), false);
  const editor = markdown(page);
  await editor.focus(); await editor.press('ControlOrMeta+A'); await editor.press('ArrowLeft');
  for (let i = 0; i < 6; i++) await editor.press('Shift+ArrowRight');
  const bar = document(page).getByRole('toolbar', { name: '笔记选区操作' });
  await expect(bar).toBeVisible();
  const scroll = document(page).locator('.note-document-scroll');
  await scroll.evaluate(element => { element.scrollTop = 500; });
  await expect(bar).toBeHidden();
  await scroll.evaluate(element => { element.scrollTop = 0; });
  await expect(bar).toBeVisible();
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(bar).toBeVisible();
  const toolbar = (await document(page).locator('.note-editor-toolbar').boundingBox())!;
  const bubble = (await bar.boundingBox())!;
  expect(bubble.x).toBeGreaterThanOrEqual(0);
  expect(bubble.x + bubble.width).toBeLessThanOrEqual(900);
  expect(bubble.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height);
  await editor.press('ArrowLeft'); await expect(bar).toBeHidden();
  const field = (await editor.boundingBox())!;
  await page.mouse.move(field.x + 2, field.y + 15);
  await page.mouse.down();
  await page.mouse.move(field.x + 90, field.y + 15, { steps: 6 });
  await expect(bar).toBeHidden();
  await page.mouse.up();
  await expect(bar).toBeVisible();
  await document(page).locator('.notes-detail').evaluate(element => { element.scrollTop = 500; });
  await expect(bar).toBeHidden();
});

test('版本历史只读预览并恢复为新版本，保留旧内容和刷新结果', async ({ page, request }, testInfo) => {
  await openNotes(page);
  const original = '# 最初的想法\n\n保留重要的观察。  \n🙂\n';
  const id = await create(page, '值得回看的记录', original, false);
  await document(page).getByLabel('笔记标题', { exact: true }).fill('后来整理的记录');
  await replaceNoteBody(page, '后来补充的正文。');
  await document(page).getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(document(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  await document(page).getByRole('button', { name: '版本历史', exact: true }).click();
  const history = page.getByRole('dialog', { name: '版本历史', exact: true });
  await history.getByRole('button', { name: /^v2\b/ }).click();
  await expect(history.getByRole('region', { name: '历史版本内容' })).toContainText('保留重要的观察。');
  await expectNoteBody(page, '后来补充的正文。');
  expect((await note(request, id)).revision).toBe(3);
  await page.setViewportSize({ width: 900, height: 900 });
  const bounds = (await history.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(900);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: testInfo.outputPath('note-version-history.png'), animations: 'disabled' });
  await history.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await expect(history).toBeHidden(); await expectNoteBody(page, original);
  const restored = await note(request, id);
  expect(restored.revision).toBe(4); expect(restored.title).toBe('值得回看的记录'); expect(restored.body).toBe(original);
  expect((await (await request.get(`${fakeApiRoot}/api/notes/${id}/versions/3`)).json() as { body: string }).body).toBe('后来补充的正文。');
  await openNotes(page, true); await expectNoteBody(page, original);
  await document(page).getByRole('button', { name: '版本历史', exact: true }).click();
  await expect(history.getByRole('button', { name: /^v4\b/ })).toBeVisible();
  await expect(history.getByRole('button', { name: '恢复此版本', exact: true })).toBeDisabled();
});

test('查看历史不丢草稿，未保存及并发更新时禁止恢复', async ({ page, request }) => {
  await openNotes(page); const id = await create(page, '历史与草稿保护', '原来保存的正文', false);
  await replaceNoteBody(page, '还未保存的输入');
  const trigger = document(page).getByRole('button', { name: '版本历史', exact: true });
  await trigger.click();
  const history = page.getByRole('dialog', { name: '版本历史', exact: true });
  await history.getByRole('button', { name: /^v1\b/ }).click();
  await expect(history).toContainText('请先保存当前草稿');
  await expect(history.getByRole('button', { name: '恢复此版本', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(history).toBeHidden(); await expect(trigger).toBeFocused();
  await expectNoteBody(page, '还未保存的输入');
  await trigger.click();
  await expect(history.getByRole('button', { name: /^v2\b/ })).toBeVisible();
  const updated = await request.put(`${fakeApiRoot}/api/notes/${id}`, { data: { commandId: crypto.randomUUID(), expectedRevision: 2, title: '另一窗口的标题', body: '另一窗口的新内容' } });
  expect(updated.ok()).toBeTruthy();
  await expect(document(page).locator('.note-conflict')).toBeVisible();
  await expect(history.getByRole('button', { name: /^v3\b/ })).toBeVisible();
  await history.getByRole('button', { name: /^v2\b/ }).click();
  await expect(history).toContainText('请先核对笔记的版本冲突');
  await expect(history.getByRole('button', { name: '恢复此版本', exact: true })).toBeDisabled();
  expect((await note(request, id)).body).toBe('另一窗口的新内容');
});

test('恢复已保存但响应丢失时沿用原命令核对，保留后续输入', async ({ page, request }) => {
  await openNotes(page); const id = await create(page, '恢复失败重试', '早期版本', false);
  await replaceNoteBody(page, '后来的版本'); await document(page).getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(document(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  let loseResponse = true; const commands: Record<string, unknown>[] = [];
  await page.route(`**/api/notes/${id}`, async route => {
    if (route.request().method() !== 'PUT') { await route.continue(); return; }
    commands.push(route.request().postDataJSON() as Record<string, unknown>);
    if (loseResponse) { const saved = await route.fetch(); expect(saved.ok()).toBeTruthy(); await route.abort('failed'); }
    else await route.continue();
  });
  await document(page).getByRole('button', { name: '版本历史', exact: true }).click();
  const history = page.getByRole('dialog', { name: '版本历史', exact: true });
  await history.getByRole('button', { name: /^v2\b/ }).click();
  await expect(history.getByRole('region', { name: '历史版本内容' })).toContainText('早期版本');
  await history.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await expect(history.getByRole('alert')).toContainText('恢复尚未完成');
  await history.getByRole('button', { name: '关闭版本历史', exact: true }).click();
  expect((await note(request, id)).revision).toBe(4);
  await replaceNoteBody(page, '核对之前继续写的内容'); loseResponse = false;
  expect((await request.put(`${fakeApiRoot}/api/notes/${id}`, { data: { commandId: crypto.randomUUID(), expectedRevision: 4, title: '其他窗口', body: '之后发生的并发修改' } })).ok()).toBeTruthy();
  await expect(document(page).locator('.note-conflict')).toContainText('v5');
  await document(page).getByRole('button', { name: '核对并重试保存', exact: true }).click();
  expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]);
  expect((await note(request, id)).revision).toBe(5);
  await expect(document(page).locator('.note-conflict')).toContainText('v5');
  await expectNoteBody(page, '核对之前继续写的内容');
  await expect(document(page).getByRole('button', { name: '保存笔记', exact: true })).toBeDisabled();
  await document(page).getByRole('button', { name: '核对后继续编辑本机草稿', exact: true }).click();
  await page.getByRole('dialog', { name: '以服务端最新版本继续编辑？', exact: true }).getByRole('button', { name: '保留本机内容并继续', exact: true }).click();
  await document(page).getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(document(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  expect((await note(request, id)).body).toBe('核对之前继续写的内容');
});


test('历史分页读取较早版本，快速切换时迟到内容不会替换当前预览', async ({ page, request }) => {
  await openNotes(page); const id = await create(page, '更多历史版本', '版本 2', false);
  for (let revision = 3; revision <= 24; revision++) expect((await request.put(`${fakeApiRoot}/api/notes/${id}`, { data: { commandId: crypto.randomUUID(), expectedRevision: revision - 1, title: '更多历史版本', body: `版本 ${revision}` } })).ok()).toBeTruthy();
  await expectNoteBody(page, '版本 24');
  await document(page).getByRole('button', { name: '版本历史', exact: true }).click();
  const history = page.getByRole('dialog', { name: '版本历史', exact: true });
  await history.getByRole('button', { name: '更早版本', exact: true }).click();
  await expect(history.getByRole('button', { name: /^v1\b/ })).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/notes/${id}/versions/2`, async route => { await held; await route.continue(); });
  const waiting = page.waitForRequest(request => new URL(request.url()).pathname === `/api/notes/${id}/versions/2`);
  await history.getByRole('button', { name: /^v2\b/ }).click(); await waiting;
  await history.getByRole('button', { name: /^v3\b/ }).click();
  const preview = history.getByRole('region', { name: '历史版本内容' });
  await expect(preview).toContainText('版本 3');
  const finished = page.waitForResponse(response => new URL(response.url()).pathname === `/api/notes/${id}/versions/2`);
  release(); await (await finished).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(preview).toContainText('版本 3');
  await expect(preview).not.toContainText('版本 2');
  expect((await note(request, id)).revision).toBe(24);
  await history.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await expect(history).toBeHidden();
  expect((await note(request, id)).body).toBe('版本 3');
});


test('助手按需启动，收起及切换笔记暂停模型轮询并保留提问草稿', async ({ page, request }) => {
  const titles = Array.from({ length: 6 }, (_, i) => `按需助手-${crypto.randomUUID()}-${i}`);
  for (const title of titles) expect((await request.post(`${fakeApiRoot}/api/notes`, { data: { id: crypto.randomUUID(), commandId: crypto.randomUUID(), title, body: title } })).ok()).toBeTruthy();
  let roots = 0, models = 0, globalModels = 0;
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && /^\/api\/notes\/[^/]+\/companion$/u.test(path)) roots++;
    if (request.method() === 'GET' && /^\/api\/sessions\/[^/]+\/model-selection$/u.test(path)) models++;
    if (request.method() === 'GET' && path === '/api/assistant/model-selection') globalModels++;
  });
  await openNotes(page);
  const choose = async (title: string) => {
    await page.getByRole('complementary', { name: '笔记库' }).getByRole('button').filter({ hasText: title }).click();
    await expectNoteBody(page, title);
  };
  for (const title of titles) await choose(title);
  let clock = globalModels;
  await expect.poll(() => globalModels).toBeGreaterThanOrEqual(clock + 2);
  expect(roots).toBe(0); expect(models).toBe(0);
  await document(page).getByRole('button', { name: '梳理助手', exact: true }).click();
  const question = companion(page).getByLabel('向梳理助手提问', { exact: true });
  await question.fill('保留这条尚未发送的问题');
  await expect(companion(page).getByRole('button', { name: '发送给梳理助手', exact: true })).toBeEnabled();
  expect(roots).toBe(1); expect(models).toBeGreaterThan(0);
  await document(page).getByRole('button', { name: '梳理助手', exact: true }).click();
  let paused = models; clock = globalModels;
  await expect.poll(() => globalModels).toBeGreaterThanOrEqual(clock + 2);
  expect(models).toBe(paused);
  await document(page).getByRole('button', { name: '梳理助手', exact: true }).click();
  await expect(question).toHaveValue('保留这条尚未发送的问题');
  await expect.poll(() => models).toBeGreaterThan(paused);
  await choose(titles[0]!);
  paused = models; clock = globalModels;
  await expect.poll(() => globalModels).toBeGreaterThanOrEqual(clock + 2);
  expect(models).toBe(paused);
  await choose(titles.at(-1)!);
  await expect(companion(page).getByLabel('向梳理助手提问', { exact: true })).toHaveValue('保留这条尚未发送的问题');
  expect(roots).toBe(1);
});

test('仅核对变化的正文，读取期间再更新也保留隐藏笔记的草稿和最新冲突', async ({ page, request }) => {
  const titleA = `版本核对-A-${crypto.randomUUID()}`, titleB = `版本核对-B-${crypto.randomUUID()}`;
  const idA = crypto.randomUUID(), idB = crypto.randomUUID();
  for (const [id, title] of [[idA, titleA], [idB, titleB]]) expect((await request.post(`${fakeApiRoot}/api/notes`, { data: { id, title, commandId: crypto.randomUUID(), body: title } })).ok()).toBeTruthy();
  const reads = new Map<string, number>();
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && [idA, idB].some(id => path === `/api/notes/${id}`)) reads.set(path, (reads.get(path) ?? 0) + 1);
  });
  const choose = (title: string) => page.getByRole('complementary', { name: '笔记库' }).getByRole('button').filter({ hasText: title }).click();
  await openNotes(page);
  await choose(titleA); await expectNoteBody(page, titleA);
  await choose(titleB); await expectNoteBody(page, titleB);
  await replaceNoteBody(page, 'B 的本机未保存草稿');
  await choose(titleA); await expectNoteBody(page, titleA);
  const beforeA = reads.get(`/api/notes/${idA}`) ?? 0, beforeB = reads.get(`/api/notes/${idB}`) ?? 0;
  let release!: () => void, captured!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { captured = resolve; });
  let first = true;
  await page.route(`**/api/notes/${idB}`, async route => {
    if (route.request().method() !== 'GET' || !first) { await route.continue(); return; }
    first = false;
    const response = await route.fetch(); captured(); await gate;
    await route.fulfill({ response });
  });
  try {
    expect((await request.put(`${fakeApiRoot}/api/notes/${idB}`, { data: { commandId: crypto.randomUUID(), expectedRevision: 1, title: `${titleB}-v2`, body: '服务端第二版' } })).ok()).toBeTruthy();
    await held;
    expect((await request.put(`${fakeApiRoot}/api/notes/${idB}`, { data: { commandId: crypto.randomUUID(), expectedRevision: 2, title: `${titleB}-v3`, body: '服务端第三版' } })).ok()).toBeTruthy();
    await expect(page.getByRole('complementary', { name: '笔记库' })).toContainText(`${titleB}-v3`);
    release();
    await choose(`${titleB}-v3`);
    await expect(document(page).locator('.note-conflict')).toContainText('服务端已有 v3');
    await expectNoteBody(page, 'B 的本机未保存草稿');
    expect(reads.get(`/api/notes/${idA}`)).toBe(beforeA);
    expect(reads.get(`/api/notes/${idB}`)).toBe(beforeB + 2);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('删除需明确确认，并清理正文、全部版本、本机草稿与助手引用', async ({ page, request }, testInfo) => {
  await openNotes(page);
  const otherTitle = `保留-${crypto.randomUUID()}`;
  const otherId = await create(page, otherTitle, '其他笔记正文', false);
  const title = '关于产品体验的几个想法';
  const id = await create(page, title, '第一份保存内容', false);
  await replaceNoteBody(page, '更新后的保存内容');
  await document(page).getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(document(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  const current = await note(request, id);
  const root = await (await request.post(`${fakeApiRoot}/api/notes/${id}/companion`)).json() as { sessionId: string };
  const snapshot = await (await request.post(`${fakeApiRoot}/api/notes/${id}/contexts`, { data: { commandId: crypto.randomUUID(), id: crypto.randomUUID(), sessionId: root.sessionId, revision: current.revision, selection: null } })).json() as { id: string };
  await replaceNoteBody(page, '尚未保存的内容也删除');
  const deletion = deleteButton(page);
  await expect(page.getByRole('complementary', { name: '笔记库' }).getByRole('button', { name: '删除笔记', exact: true })).toHaveCount(1);
  await expect(document(page).getByRole('button', { name: '删除笔记', exact: true })).toHaveCount(0);
  const row = page.locator('.notes-library-item[data-selected="true"]');
  const actions = row.locator('.note-list-actions');
  await document(page).hover();
  await expect(actions).toHaveCSS('opacity', '0');
  await expect(actions).toHaveCSS('pointer-events', 'none');
  const action = await deletion.boundingBox(), label = await row.locator('strong').boundingBox(), item = await row.boundingBox();
  expect(action && label && action.x >= label.x + label.width).toBeTruthy();
  expect(action && item && Math.abs(action.y + action.height / 2 - item.y - item.height / 2)).toBeLessThan(1);
  await page.screenshot({ path: testInfo.outputPath('note-list-delete.png'), animations: 'disabled' });
  await row.locator('.note-list-open').focus(); await page.keyboard.press('Tab');
  await expect(deletion).toBeFocused(); await expect(actions).toHaveCSS('opacity', '1');
  await markdown(page).focus(); await expect(actions).toHaveCSS('opacity', '0');
  await row.hover(); await expect(actions).toHaveCSS('opacity', '1');
  await page.screenshot({ path: testInfo.outputPath('note-list-delete-row-hover.png'), animations: 'disabled' });
  await document(page).hover(); await expect(actions).toHaveCSS('opacity', '0');
  await row.hover();
  await deletion.hover();
  await expect(deletion).toHaveCSS('color', 'rgb(185, 28, 28)');
  await page.screenshot({ path: testInfo.outputPath('note-list-delete-hover.png'), animations: 'disabled' });
  await deletion.click();
  let dialog = page.getByRole('dialog', { name: '删除这篇笔记？' });
  await expect(dialog).toContainText('全部历史版本');
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expectNoteBody(page, '尚未保存的内容也删除');
  expect((await note(request, id)).revision).toBe(current.revision);
  await deletion.click(); dialog = page.getByRole('dialog', { name: '删除这篇笔记？' });
  await dialog.getByRole('button', { name: '删除笔记', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '笔记库' }).getByRole('button').filter({ hasText: title })).toHaveCount(0);
  await expectNoteBody(page, '其他笔记正文');
  for (let revision = 1; revision <= current.revision; revision++) expect((await request.get(`${fakeApiRoot}/api/notes/${id}/versions/${revision}`)).status()).toBe(404);
  expect((await request.get(`${fakeApiRoot}/api/notes/${id}`)).status()).toBe(404);
  expect((await request.get(`${fakeApiRoot}/api/notes/${id}/versions`)).status()).toBe(404);
  expect((await request.get(`${fakeApiRoot}/api/sessions/${root.sessionId}/session`)).status()).toBe(404);
  expect((await request.post(`${fakeApiRoot}/api/sessions/${root.sessionId}/restore`)).status()).toBe(400);
  expect((await request.post(`${fakeApiRoot}/api/notes/${id}/contexts`, { data: { commandId: crypto.randomUUID(), id: snapshot.id, sessionId: root.sessionId, revision: current.revision, selection: null } })).status()).toBe(404);
  expect(await page.evaluate(id => {
    const keys = Object.keys(localStorage).filter(key => key.startsWith('multivac:note-draft:'));
    return keys.some(key => JSON.parse(localStorage.getItem(key) ?? 'null')?.base?.id === id);
  }, id)).toBe(false);
  expect((await note(request, otherId)).body).toBe('其他笔记正文');
  await openNotes(page, true); await expectNoteBody(page, '其他笔记正文');
});

test('删除响应丢失时保持原命令，核对期间暂停编辑，重试不会恢复历史', async ({ page, request }) => {
  await openNotes(page);
  await create(page, `保留备用-${crypto.randomUUID()}`, '备用正文', false);
  const id = await create(page, `删除核对-${crypto.randomUUID()}`, '待删除正文', false);
  let blockLists = true, lost = true;
  const commands: unknown[] = [];
  await page.route('**/api/notes', async route => {
    if (blockLists && route.request().method() === 'GET') await route.abort(); else await route.continue();
  });
  await page.route(`**/api/notes/${id}`, async route => {
    if (route.request().method() !== 'DELETE') { await route.continue(); return; }
    commands.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (lost) { lost = false; await route.abort(); } else await route.fulfill({ response });
  });
  try {
    await clickDelete(page);
    await page.getByRole('dialog', { name: '删除这篇笔记？' }).getByRole('button', { name: '删除笔记', exact: true }).click();
    await expect(deleteButton(page, true)).toBeEnabled();
    await expect(markdown(page)).not.toBeEditable();
    expect((await request.get(`${fakeApiRoot}/api/notes/${id}`)).status()).toBe(404);
    blockLists = false;
    await clickDelete(page, true);
    await expectNoteBody(page, '备用正文');
    expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]);
    expect((await request.get(`${fakeApiRoot}/api/notes/${id}/versions`)).status()).toBe(404);
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

test('确认期间正文更新时拒绝旧版本删除，重新核对后才删除', async ({ page, request }) => {
  await openNotes(page);
  const id = await create(page, `删除并发-${crypto.randomUUID()}`, '旧内容', false);
  const original = await note(request, id);
  await clickDelete(page);
  expect((await request.put(`${fakeApiRoot}/api/notes/${id}`, { data: { commandId: crypto.randomUUID(), expectedRevision: original.revision, title: original.title, body: '确认期间的新内容' } })).ok()).toBeTruthy();
  await page.getByRole('dialog', { name: '删除这篇笔记？' }).getByRole('button', { name: '删除笔记', exact: true }).click();
  await expect(document(page)).toContainText('笔记版本已变化');
  expect((await note(request, id)).body).toBe('确认期间的新内容');
  await expectNoteBody(page, '确认期间的新内容');
  await clickDelete(page);
  await page.getByRole('dialog', { name: '删除这篇笔记？' }).getByRole('button', { name: '删除笔记', exact: true }).click();
  await expect.poll(async () => (await request.get(`${fakeApiRoot}/api/notes/${id}`)).status()).toBe(404);
});

test('助手运行时拒绝删除，结束后删除同步关闭另一窗口的旧草稿', async ({ page, context, request }) => {
  await openNotes(page); const title = `删除运行-${crypto.randomUUID()}`;
  const id = await create(page, title, '运行期间的正文');
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBeTruthy();
  try {
    const question = companion(page).getByLabel('向梳理助手提问', { exact: true });
    await question.fill('讨论一下这篇笔记'); await question.press('Enter');
    await expect(companion(page).getByRole('button', { name: '停止梳理助手', exact: true })).toBeVisible();
    const saved = await note(request, id);
    expect((await request.delete(`${fakeApiRoot}/api/notes/${id}`, { data: { commandId: crypto.randomUUID(), expectedRevision: saved.revision } })).status()).toBe(409);
    expect((await note(request, id)).body).toBe(saved.body);
    await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`);
    await expect(companion(page).getByRole('button', { name: '发送给梳理助手', exact: true })).toBeVisible();
    const other = await context.newPage(); await openNotes(other);
    await other.getByRole('complementary', { name: '笔记库' }).getByRole('button').filter({ hasText: title }).click();
    await replaceNoteBody(other, '另一窗口的未保存内容');
    await clickDelete(page);
    await page.getByRole('dialog', { name: '删除这篇笔记？' }).getByRole('button', { name: '删除笔记', exact: true }).click();
    await expect(other.getByRole('complementary', { name: '笔记库' }).getByRole('button').filter({ hasText: title })).toHaveCount(0);
    expect(await other.getByLabel('笔记正文', { exact: true }).evaluateAll(elements => elements.map(element => element.textContent))).not.toContain('另一窗口的未保存内容');
    expect(await other.evaluate(id => sessionStorage.getItem(`multivac:note-draft-pointer:${id}`), id)).toBeNull();
  } finally { await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`); }
});

test('另一窗口删除后，迟到保存回执不能写回已清理的本机正文', async ({ page, request }) => {
  await openNotes(page);
  await create(page, `迟到保留-${crypto.randomUUID()}`, '仍然保留的正文', false);
  const id = await create(page, `迟到删除-${crypto.randomUUID()}`, '原来的正文', false);
  let release!: () => void, captured!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { captured = resolve; });
  let savedRevision = 0;
  await page.route(`**/api/notes/${id}`, async route => {
    if (route.request().method() !== 'PUT') { await route.continue(); return; }
    const response = await route.fetch(); savedRevision = (await response.json() as { revision: number }).revision;
    captured(); await gate; await route.fulfill({ response });
  });
  try {
    await replaceNoteBody(page, '保存已提交但响应尚未返回的正文');
    await document(page).getByRole('button', { name: '保存笔记', exact: true }).click(); await held;
    expect((await request.delete(`${fakeApiRoot}/api/notes/${id}`, { data: { commandId: crypto.randomUUID(), expectedRevision: savedRevision } })).ok()).toBeTruthy();
    await expectNoteBody(page, '仍然保留的正文');
    const receipt = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === `/api/notes/${id}`);
    release(); await (await receipt).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(id => Object.keys(localStorage).filter(key => key.startsWith('multivac:note-draft:')).some(key => JSON.parse(localStorage.getItem(key) ?? 'null')?.base?.id === id), id)).toBe(false);
    expect((await request.get(`${fakeApiRoot}/api/notes/${id}/versions`)).status()).toBe(404);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('富文本直接输入、格式操作和撤销重做保存为 Markdown，刷新保留格式', async ({ page, request }, testInfo) => {
  await openNotes(page);
  const id = await create(page, '直接写作与格式', '保留这些文字。\n\n其他段落  保持空白。  \n', false);
  const body = markdown(page);
  await body.focus(); await body.press('ControlOrMeta+A'); await body.press('ArrowLeft');
  for (let index = 0; index < 4; index++) await body.press('Shift+ArrowRight');
  await document(page).getByRole('button', { name: '粗体', exact: true }).click();
  await expect(body.locator('strong')).toHaveText('保留这些');
  await body.press('ControlOrMeta+s');
  await expect(document(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  expect((await note(request, id)).body).toBe('**保留这些**文字。\n\n其他段落  保持空白。  \n');
  await document(page).getByRole('button', { name: '撤销正文修改' }).click();
  await expect(body.locator('strong')).toHaveCount(0);
  await document(page).getByRole('button', { name: '重做正文修改' }).click();
  await expect(body.locator('strong')).toHaveText('保留这些');
  await body.press('ArrowRight');
  await document(page).getByRole('combobox', { name: '段落样式' }).selectOption('2');
  await expect(body.getByRole('heading', { level: 2 })).toContainText('保留这些文字。');
  await body.press('ControlOrMeta+s');
  await expect(document(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  expect((await note(request, id)).body).toBe('## **保留这些**文字。\n\n其他段落  保持空白。  \n');
  await openNotes(page, true);
  await expect(body.getByRole('heading', { level: 2 })).toContainText('保留这些文字。');
  await expect(body.locator('strong')).toHaveText('保留这些');
  await page.screenshot({ path: testInfo.outputPath('notes-rich-text.png'), animations: 'disabled' });
});

test('渲染选区含 emoji 与跨格式文字，助手引用核对 Markdown 原文偏移', async ({ page, request }) => {
  await openNotes(page);
  const source = '# 当前笔记\n\n开头 **粗体🙂** 与 [链接](https://example.com)，结尾。';
  const id = await create(page, '渲染正文中的引用', source, false);
  await markdown(page).locator('strong').evaluate(element => {
    const range = window.document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    window.document.dispatchEvent(new Event('selectionchange'));
  });
  const snapshotResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/notes/${id}/contexts` && response.request().method() === 'POST');
  await document(page).getByRole('button', { name: '引用给助手', exact: true }).click();
  const snapshot = await (await snapshotResponse).json() as { selection: { start: number; end: number; text: string } };
  expect(snapshot.selection).toEqual({ start: source.indexOf('粗体'), end: source.indexOf('粗体') + 4, text: '粗体🙂' });
  expect(source.slice(snapshot.selection.start, snapshot.selection.end)).toBe(snapshot.selection.text);
  await expect(companion(page).locator('.note-quote')).toContainText('粗体🙂');
  expect((await note(request, id)).body).toBe(source);
});

test('任务列表和表格可直接编辑，HTML 与外部图片不执行或自动加载', async ({ page, request }) => {
  await openNotes(page);
  const external: string[] = [];
  page.on('request', request => { if (request.url().startsWith('https://note-wysiwyg.invalid/')) external.push(request.url()); });
  const source = '- [ ] 待办事项\n- [x] 已完成\n\n| 名称 | 说明 |\n| :--- | ---: |\n| 第一行 | 可编辑 |\n\n![外部图片](https://note-wysiwyg.invalid/image.png)\n\n<script>window.__noteScript = true</script>';
  const id = await create(page, '结构化的记录', source, false);
  const body = markdown(page);
  await expect(body.locator('table')).toBeVisible();
  await expect(body.getByRole('checkbox')).toHaveCount(2);
  await body.getByRole('checkbox').first().check();
  await body.getByRole('cell', { name: '可编辑', exact: true }).click();
  await body.getByRole('cell', { name: '可编辑', exact: true }).locator('p').evaluate(element => { const selection = window.getSelection()!; selection.collapse(element.firstChild, element.textContent!.length); window.document.dispatchEvent(new Event('selectionchange')); });
  await page.keyboard.type('内容');
  await body.press('ControlOrMeta+s');
  await expect(document(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  const saved = await note(request, id);
  expect(saved.body).toContain('- [x] 待办事项');
  expect(saved.body).toContain('可编辑内容');
  expect(saved.body).toContain('![外部图片](https://note-wysiwyg.invalid/image.png)');
  expect(saved.body).toContain('<script>window.__noteScript = true</script>');
  expect(await page.evaluate(() => '__noteScript' in window)).toBe(false);
  expect(external).toEqual([]);
  await openNotes(page, true);
  await expect(body.getByRole('checkbox').first()).toBeChecked();
  await expect(body.getByRole('cell', { name: '可编辑内容', exact: true })).toBeVisible();
  expect(external).toEqual([]);
});

test('Markdown 输入快捷语法直接变成标题，复制粘贴保留文字格式', async ({ page, request }) => {
  await openNotes(page);
  const id = await create(page, '从空白开始写', '', false);
  const body = markdown(page);
  await body.click(); await body.pressSequentially('## '); await body.pressSequentially('写下灵感');
  await expect(body.getByRole('heading', { level: 2 })).toHaveText('写下灵感');
  await body.press('Enter'); await body.press('ControlOrMeta+b'); await body.pressSequentially('值得保留'); await body.press('ControlOrMeta+b');
  await expect(body.locator('strong')).toHaveText('值得保留');
  const copied = await body.locator('strong').evaluate(element => {
    const range = window.document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    window.document.dispatchEvent(new Event('selectionchange'));
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }));
    return clipboardData.getData('text/plain');
  });
  expect(copied).toBe('**值得保留**');
  await body.press('ControlOrMeta+End'); await body.press('Enter');
  await body.evaluate((element, value) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', value);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, copied);
  await expect(body.locator('strong')).toHaveCount(2);
  await body.press('ControlOrMeta+s');
  await expect(document(page).getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  const saved = await note(request, id);
  expect(saved.body).toContain('## 写下灵感');
  expect(saved.body.match(/\*\*值得保留\*\*/g)).toHaveLength(2);
});

test('正文达到字数上限时拒绝新增内容，保留完整已存正文', async ({ page, request }) => {
  await openNotes(page);
  const source = '字'.repeat(100000);
  const id = await create(page, '字数上限', source, false);
  const before = await note(request, id);
  await markdown(page).focus(); await markdown(page).press('ControlOrMeta+End'); await markdown(page).pressSequentially('新增');
  await expect(document(page).getByRole('alert')).toContainText('正文不能超过 100,000 个字符');
  expect(await markdown(page).textContent()).toBe(source);
  await expectNoteBody(page, source);
  expect(await note(request, id)).toEqual(before);
});
