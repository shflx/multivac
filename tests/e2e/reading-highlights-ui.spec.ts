import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Book, BookReference, ReadingAnnotation } from '@multivac/contracts';
import { fakeApiRoot, openPanel } from './test-state.js';

async function seed(request: APIRequestContext, title: string) {
  const book: Book = await (await request.post(`${fakeApiRoot}/api/reading/books`, { data: {
    commandId: title, title, author: '', format: 'md', text: '# 第三章\n\n简短划线。这里开始是一段用于回顾论证关系的划线摘录。' + '摘录正文应当可选取，展开后能阅读完整内容。'.repeat(55) + '\n\n# 第四章\n\n靠后的划线。' + title,
  } })).json();
  const chapter = book.chapters.find(c => c.title === '第三章')!;
  const paragraph = chapter.paragraphs[0]!;
  const later = book.chapters.find(c => c.title === '第四章')!;
  const reference = (chapterId: string, paragraphId: string, text: string, start: number, end: number): BookReference => ({ bookId: book.id, version: book.version, start: { chapterId, paragraphId, offset: start }, end: { chapterId, paragraphId, offset: end }, text: text.slice(start, end) });
  const refs = {
    short: reference(chapter.id, paragraph.id, paragraph.text, 0, 5),
    long: reference(chapter.id, paragraph.id, paragraph.text, 5, paragraph.text.length),
    later: reference(later.id, later.paragraphs[0]!.id, later.paragraphs[0]!.text, 0, later.paragraphs[0]!.text.length),
  };
  for (const id of ['later', 'long', 'short'] as const) {
    const response = await request.post(`${fakeApiRoot}/api/reading/books/${book.id}/annotations`, { data: { commandId: `${title}-${id}`, id: `${title}-${id}`, expectedRevision: 0, action: 'save', kind: 'highlight', reference: refs[id], remark: id === 'short' ? '原备注' : '' } });
    expect(response.ok()).toBe(true);
  }
  return { book, refs };
}
async function open(page: Page, title: string, mobile = false) {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  if (mobile) await page.getByRole('button', { name: '读书', exact: true }).click();
  else { await openPanel(page, 'management'); await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click(); }
  await page.getByRole('navigation', { name: '书架' }).getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByLabel('页码', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '阅读笔记', exact: true }).click();
  await page.getByRole('tab', { name: /^划线 / }).click();
  return page.getByRole('complementary', { name: '划线', exact: true });
}

for (const mobile of [false, true]) {
  test(`划线摘录可选取，四行预览按需展开，位置与单行操作对齐${mobile ? '（手机）' : ''}`, async ({ page, request }, testInfo) => {
    const title = `highlight-layout-${mobile}`;
    const { book, refs } = await seed(request, title);
    const panel = await open(page, title, mobile);
    const short = panel.locator('article').filter({ has: page.locator('.reading-highlight-excerpt', { hasText: /^简短划线。$/ }) });
    const long = panel.locator('article').filter({ hasText: '摘录正文应当可选取' });
    await expect(panel.locator('.reading-highlight-excerpt')).toHaveText([refs.short.text, refs.long.text, refs.later.text]);
    await expect(short.locator('.reading-note-meta')).toContainText('第三章');
    await expect(short.locator('.reading-note-meta')).toContainText('本页');
    await expect(panel.locator('article').last().locator('.reading-note-meta')).not.toContainText('本页');
    await expect(page.getByRole('button', { name: '新建阅读笔记', exact: true })).toHaveCount(0);
    await expect(short.getByRole('button', { name: '展开摘录' })).toHaveCount(0);
    await expect(short.locator('.reading-note-actions-local')).toBeEmpty();
    await expect(panel.getByRole('button', { name: /更多/ })).toHaveCount(0);
    await expect(short.getByRole('button', { name: '移除划线', exact: true })).toHaveAttribute('title', '移除划线');
    await expect(short.getByRole('button', { name: '定位原文', exact: true })).toHaveCount(1);
    await expect(short.getByRole('button', { name: '定位原文', exact: true }).locator('svg')).toHaveCount(0);
    const position = await page.evaluate(id => JSON.parse(localStorage.getItem(`multivac.reading.scene.${id}`)!).position, book.id);
    await short.locator('.reading-highlight-excerpt').click();
    expect(await page.evaluate(id => JSON.parse(localStorage.getItem(`multivac.reading.scene.${id}`)!).position, book.id)).toEqual(position);
    await expect(page.getByRole('button', { name: '返回阅读处', exact: true })).toHaveCount(0);
    const selected = await short.locator('.reading-highlight-excerpt').evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      const style = getComputedStyle(node);
      const ink = getComputedStyle(document.querySelector('.reading-flow')!).color;
      return { text: selection.toString(), insideButton: Boolean(node.closest('button')), selectable: style.userSelect, normalColor: style.color === ink };
    });
    expect(selected).toEqual({ text: refs.short.text, insideButton: false, selectable: 'text', normalColor: true });
    const previewHeight = await long.locator('.reading-highlight-excerpt').evaluate(node => node.clientHeight);
    const lineHeight = await long.locator('.reading-highlight-excerpt').evaluate(node => parseFloat(getComputedStyle(node).lineHeight));
    expect(previewHeight).toBeLessThanOrEqual(Math.ceil(lineHeight * 4));
    const coordinates = async () => panel.locator('article').evaluateAll(nodes => nodes.map(node => {
      const local = node.querySelector('.reading-note-actions-local')!.getBoundingClientRect();
      const [locate, note] = [...node.querySelectorAll('.reading-note-actions-navigation button')].map(button => button.getBoundingClientRect());
      const toggle = node.querySelector('.reading-note-actions-local button')?.getBoundingClientRect();
      const remove = node.querySelector('.reading-highlight-remove')!.getBoundingClientRect();
      const meta = node.querySelector('.reading-note-meta')!.getBoundingClientRect();
      return { locateX: locate!.x, noteX: note!.x, localX: local.x, toggleX: toggle?.x, sameRow: Math.abs(locate!.y - note!.y) < 1 && (!toggle || Math.abs(toggle.y - locate!.y) < 1), removeRight: remove.right, metaRight: meta.right };
    }));
    const before = await coordinates();
    expect(before[0]!.locateX).toBeCloseTo(before[1]!.locateX, 0);
    expect(before[0]!.noteX).toBeCloseTo(before[1]!.noteX, 0);
    expect(before[1]!.toggleX).toBeCloseTo(before[1]!.localX, 0);
    expect(before.every(item => item.sameRow && Math.abs(item.removeRight - item.metaRight) < 1)).toBe(true);
    const toggle = long.getByRole('button', { name: '展开摘录', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAttribute('aria-controls', (await long.locator('.reading-highlight-excerpt').getAttribute('id'))!);
    await toggle.click();
    await expect(long.getByRole('button', { name: '收起摘录', exact: true })).toHaveAttribute('aria-expanded', 'true');
    expect(await long.locator('.reading-highlight-excerpt').evaluate(node => node.clientHeight)).toBeGreaterThan(previewHeight);
    expect((await coordinates()).map(item => [item.locateX, item.noteX])).toEqual(before.map(item => [item.locateX, item.noteX]));
    await long.getByRole('button', { name: '收起摘录', exact: true }).click();
    expect(await long.locator('.reading-highlight-excerpt').evaluate(node => node.clientHeight)).toBe(previewHeight);
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('highlights-list.png') });
    await short.getByRole('button', { name: '写笔记', exact: true }).click();
    const card = page.getByRole('dialog', { name: '阅读笔记草稿' });
    await expect(card.locator('blockquote')).toHaveText(`引用：${refs.short.text}`);
    await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/notes`)).json()).draft?.location?.position).toEqual(refs.short.start);
  });
}

test('移除划线可撤销，恢复原文与备注，回应丢失时复用原命令且不重复恢复', async ({ page, request }) => {
  const title = 'highlight-undo-unknown';
  const { book, refs } = await seed(request, title);
  const panel = await open(page, title);
  const commands: { commandId: string; id: string; action: string }[] = [];
  const aborted = new Set<string>();
  await page.route(`**/api/reading/books/${book.id}/annotations`, async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const command = route.request().postDataJSON(); commands.push(command);
    if (!aborted.has(command.action)) { aborted.add(command.action); await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await panel.locator('article').first().getByRole('button', { name: '移除划线', exact: true }).click();
  const retry = page.getByRole('button', { name: '重试原标注命令', exact: true });
  await expect(retry).toBeVisible();
  await expect(panel.getByRole('button', { name: '撤销移除划线' })).toHaveCount(0);
  await retry.click();
  const undo = panel.getByRole('button', { name: '撤销移除划线', exact: true });
  await expect(undo).toBeEnabled();
  await expect(panel.locator('article')).toHaveCount(2);
  await undo.click();
  await expect(retry).toBeVisible(); await expect(undo).toBeDisabled();
  await retry.click();
  await expect(undo).toHaveCount(0);
  await expect(panel.locator('article')).toHaveCount(3);
  const records: ReadingAnnotation[] = (await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/annotations`)).json()).records;
  const restored = records.filter(record => record.reference.text === refs.short.text);
  expect(restored).toHaveLength(1); expect(restored[0]!.reference).toEqual(refs.short); expect(restored[0]!.remark).toBe('原备注');
  expect(restored[0]!.id).not.toBe(`${title}-short`);
  expect(commands.map(command => command.action)).toEqual(['delete', 'delete', 'save', 'save']);
  expect(commands[0]!.commandId).toBe(commands[1]!.commandId); expect(commands[2]!.commandId).toBe(commands[3]!.commandId);
  expect(commands[2]!.id).toBe(commands[3]!.id);
  await page.reload(); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click();
  await expect(panel.locator('.reading-highlight-excerpt').first()).toHaveText(refs.short.text);
});

test('失效划线保留摘录并独立提示，原文位置排序且空状态引导正文划线', async ({ page, request }) => {
  const title = 'highlight-invalid-empty';
  const { book, refs } = await seed(request, title);
  await page.route(`**/api/reading/books/${book.id}/annotations`, async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    const response = await route.fetch(), data = await response.json();
    const record = data.records.find((record: ReadingAnnotation) => record.reference.text === refs.short.text);
    if (record) record.reference.version = 'expired-version';
    await route.fulfill({ response, json: data });
  });
  const panel = await open(page, title);
  await expect(panel.locator('.reading-highlight-excerpt')).toHaveText([refs.long.text, refs.later.text, refs.short.text]);
  const invalid = panel.locator('article').last();
  await expect(invalid).toContainText('原文位置已失效，摘录已保留');
  await expect(invalid.getByRole('button', { name: '定位原文', exact: true })).toBeDisabled();
  await expect(invalid.getByRole('button', { name: '写笔记', exact: true })).toBeDisabled();
  await expect(invalid.locator('.reading-note-meta')).not.toContainText('本页');
  for (let remaining = 3; remaining > 0; remaining--) {
    await panel.locator('article').first().getByRole('button', { name: '移除划线', exact: true }).click();
    await expect(panel.locator('article')).toHaveCount(remaining - 1);
  }
  await expect(panel.getByText('在正文中选中文字，即可划线', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建阅读笔记', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: /^笔记 / }).click();
  await expect(page.getByRole('button', { name: '新建阅读笔记', exact: true })).toBeVisible();
});


test('全书索引排序未加载章节的划线，定位后更新本页信息', async ({ page, request }) => {
  const title = 'highlight-unloaded-chapter';
  const text = '# 第三章\n\n' + Array.from({ length: 130 }, (_, i) => `第${i}处。` + '这一段用于验证分块阅读的稳定定位。'.repeat(15)).join('\n\n') + '\n\n# 第四章\n\n尚未加载章节中的划线。';
  const book: Book = await (await request.post(`${fakeApiRoot}/api/reading/books`, { data: { commandId: title, title, author: '', format: 'md', text } })).json();
  const refs = [book.chapters.find(c => c.title === '第三章')!, book.chapters.find(c => c.title === '第四章')!].map(chapter => {
    const paragraph = chapter.paragraphs[0]!;
    return { bookId: book.id, version: book.version, start: { chapterId: chapter.id, paragraphId: paragraph.id, offset: 0 }, end: { chapterId: chapter.id, paragraphId: paragraph.id, offset: paragraph.text.length }, text: paragraph.text };
  });
  for (const [i, reference] of [...refs].reverse().entries()) {
    expect((await request.post(`${fakeApiRoot}/api/reading/books/${book.id}/annotations`, { data: { commandId: `${title}-${i}`, id: `${title}-${i}`, expectedRevision: 0, action: 'save', kind: 'highlight', reference } })).ok()).toBe(true);
  }
  const panel = await open(page, title);
  await expect(panel.locator('.reading-highlight-excerpt')).toHaveText(refs.map(reference => reference.text));
  await expect(page.locator('.reading-page-main .reading-flow')).not.toContainText(refs[1]!.text);
  const later = panel.locator('article').last();
  await expect(later.locator('.reading-note-meta')).toContainText('第四章');
  await expect(later.locator('.reading-note-meta')).not.toContainText('本页');
  await expect(later.getByRole('button', { name: '定位原文', exact: true })).toBeEnabled();
  await later.getByRole('button', { name: '定位原文', exact: true }).click();
  await expect(page.locator('.reading-page-main .reading-flow')).toContainText(refs[1]!.text);
  await expect(later.locator('.reading-note-meta')).toContainText('本页');
  await expect(page.locator('.reading-located')).toHaveText(refs[1]!.text);
  await expect(panel.locator('.reading-highlight-excerpt')).toHaveText(refs.map(reference => reference.text));
});

test('移除发生版本冲突时保留划线且不提供假撤销，重新移除后恢复最新备注', async ({ page, request }) => {
  const title = 'highlight-delete-conflict';
  const { book, refs } = await seed(request, title);
  const panel = await open(page, title);
  let intercepted = false;
  await page.route(`**/api/reading/books/${book.id}/annotations`, async route => {
    const command = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
    if (command?.action === 'delete' && !intercepted) {
      intercepted = true;
      const changed = await request.post(`${fakeApiRoot}/api/reading/books/${book.id}/annotations`, { data: { ...command, action: 'save', commandId: `${title}-other-window`, reference: refs.short, remark: '其他窗口更新后的备注' } });
      expect(changed.ok()).toBe(true);
    }
    await route.continue();
  });
  const remove = panel.locator('article').first().getByRole('button', { name: '移除划线', exact: true });
  await remove.click();
  await expect(page.locator('.reading-status')).toContainText('其他窗口修改');
  await expect(remove).toBeEnabled();
  await expect(panel.locator('article')).toHaveCount(3);
  await expect(panel.getByRole('button', { name: '撤销移除划线' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重试原标注命令' })).toHaveCount(0);
  await remove.click();
  await panel.getByRole('button', { name: '撤销移除划线' }).click();
  await expect(panel.locator('article')).toHaveCount(3);
  const records: ReadingAnnotation[] = (await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/annotations`)).json()).records;
  expect(records.find(record => record.reference.text === refs.short.text)?.remark).toBe('其他窗口更新后的备注');
});
