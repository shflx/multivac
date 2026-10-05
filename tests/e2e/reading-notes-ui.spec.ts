import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Book, BookReference, ReadingNotesState } from '@multivac/contracts';
import { openPanel, fakeApiRoot } from './test-state.js';

async function seed(request: APIRequestContext, title: string) {
  const text = '这是用于理解笔记的原文摘录。'.repeat(35) + title;
  const book: Book = await (await request.post(`${fakeApiRoot}/api/reading/books`, { data: { commandId: title, title, author: '', format: 'txt', text } })).json();
  const reference: BookReference = { bookId: book.id, version: book.version, text, start: { chapterId: 'c1', paragraphId: 'c1:p1', offset: 0 }, end: { chapterId: 'c1', paragraphId: 'c1:p1', offset: text.length } };
  let revision = 0;
  for (const [id, body] of [['short', '我记下的简短理解。'], ['long', '这里是我对这一段的理解，需要看清概念之间的关系。'.repeat(25)]]) {
    const draft = await request.post(`${fakeApiRoot}/api/reading/books/${book.id}/notes`, { data: { commandId: crypto.randomUUID(), expectedRevision: revision++, action: 'draft', draft: { id, body, reference, origin: 'user' } } });
    expect(draft.ok()).toBeTruthy();
    const saved = await request.post(`${fakeApiRoot}/api/reading/books/${book.id}/notes`, { data: { commandId: crypto.randomUUID(), expectedRevision: revision++, action: 'save' } });
    expect(saved.ok()).toBeTruthy();
  }
  return book;
}
async function open(page: Page, title: string, mobile = false) {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  if (mobile) await page.getByRole('button', { name: '读书', exact: true }).click();
  else { await openPanel(page, 'management'); await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click(); }
  await page.getByRole('navigation', { name: '书架' }).getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByLabel('页码', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '阅读笔记', exact: true }).click();
}
for (const mobile of [false, true]) {
  test(`笔记正文优先，按需展开笔记，编辑卡片明确确认删除${mobile ? '（手机）' : ''}`, async ({ page, request }, testInfo) => {
    const title = `notes-layout-${mobile}`;
    const book = await seed(request, title);
    await open(page, title, mobile);
    const panel = page.getByRole('complementary', { name: '阅读笔记', exact: true });
    const short = panel.locator('article').filter({ hasText: '我记下的简短理解。' });
    const long = panel.locator('article').filter({ hasText: '这里是我对这一段的理解' });
    await expect(short).toBeVisible();
    await expect(short.getByRole('button', { name: '展开笔记' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /删除|更多|交给/ })).toHaveCount(0);
    await expect(panel.getByText('来自书伴', { exact: false })).toHaveCount(0);
    expect(await long.evaluate(node => Boolean(node.querySelector('p')!.compareDocumentPosition(node.querySelector('blockquote')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    const quoteHeight = await long.locator('blockquote').evaluate(node => node.clientHeight);
    const previewHeight = await long.locator('.reading-note-body').evaluate(node => node.clientHeight);
    const toggle = long.getByRole('button', { name: '展开笔记', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAttribute('aria-controls', (await long.locator('.reading-note-body').getAttribute('id'))!);
    await expect(short.locator('.reading-note-actions-local')).toBeEmpty();
    const positions = async () => panel.evaluate(element => [...element.querySelectorAll('article')].map(note => {
      const actions = note.querySelector('.reading-note-actions')!.getBoundingClientRect();
      const navigation = note.querySelector('.reading-note-actions-navigation')!;
      const [locate, edit] = [...navigation.querySelectorAll('button')].map(button => button.getBoundingClientRect());
      const toggle = note.querySelector('.reading-note-actions-local button')?.getBoundingClientRect();
      const excerpt = note.querySelector('blockquote')!.getBoundingClientRect();
      return { locateX: locate!.x, editX: edit!.x, editRight: edit!.right, actionsRight: actions.right,
        toggleX: toggle?.x, actionsX: actions.x, belowExcerpt: actions.top >= excerpt.bottom,
        sameRow: Math.abs(locate!.y + locate!.height / 2 - edit!.y - edit!.height / 2) <= 0.5 &&
          (!toggle || Math.abs(toggle.y + toggle.height / 2 - locate!.y - locate!.height / 2) <= 0.5) };
    }));
    const before = await positions();
    expect(before[0]!.locateX).toBeCloseTo(before[1]!.locateX, 0);
    expect(before[0]!.editX).toBeCloseTo(before[1]!.editX, 0);
    expect(before[1]!.toggleX).toBeCloseTo(before[1]!.actionsX, 0);
    expect(before.every(position => position.belowExcerpt && position.sameRow && Math.abs(position.editRight - position.actionsRight) <= 0.5)).toBe(true);
    await toggle.click();
    await expect(long.getByRole('button', { name: '收起笔记', exact: true })).toHaveAttribute('aria-expanded', 'true');
    expect(await long.locator('.reading-note-body').evaluate(node => node.clientHeight)).toBeGreaterThan(previewHeight);
    expect(await long.locator('blockquote').evaluate(node => node.clientHeight)).toBe(quoteHeight);
    expect((await positions()).map(position => [position.locateX, position.editX])).toEqual(before.map(position => [position.locateX, position.editX]));
    await long.getByRole('button', { name: '收起笔记', exact: true }).click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(await long.locator('.reading-note-body').evaluate(node => node.clientHeight)).toBe(previewHeight);
    await page.screenshot({ path: testInfo.outputPath('notes-list.png') });
    await short.getByRole('button', { name: '编辑笔记' }).click();
    await expect(page.getByRole('button', { name: '交给 Multivac', exact: true })).toBeEnabled();
    await page.getByLabel('笔记内容').fill('尚未保存的修改');
    await expect(page.getByText('草稿已保留', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '交给 Multivac', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '删除已保存笔记', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '删除已保存笔记？', exact: true });
    await expect(confirmation).toContainText('未保存修改将一并删除');
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByLabel('笔记内容')).toHaveValue('尚未保存的修改');
    expect((await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/notes`)).json()).notes).toHaveLength(2);
    await page.getByRole('button', { name: '删除已保存笔记', exact: true }).click();
    await confirmation.getByRole('button', { name: '删除笔记', exact: true }).click();
    await expect(page.getByLabel('笔记内容')).toHaveCount(0);
    const state = await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/notes`)).json();
    expect(state.notes.map((note: { id: string }) => note.id)).toEqual(['long']);
    expect(state.draft).toBeNull();
  });
}

test('读取期间不显示空状态，失败就地重试，失效原文保留摘录', async ({ page, request }) => {
  const title = 'notes-load-retry';
  const book = await seed(request, title);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let fail = true;
  await page.route(`**/api/reading/books/${book.id}/notes`, async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    if (fail) { await held; await route.fulfill({ status: 503, json: { error: '笔记读取失败' } }); return; }
    const response = await route.fetch();
    const state = await response.json();
    state.notes[0].reference.version = 'unavailable-version';
    await route.fulfill({ response, json: state });
  });
  await open(page, title);
  const panel = page.getByRole('complementary', { name: '阅读笔记', exact: true });
  await expect(panel.getByText('正在加载阅读笔记…')).toBeVisible();
  await expect(panel.getByText('暂无阅读笔记')).toHaveCount(0);
  release();
  await expect(panel.getByRole('button', { name: '重试加载笔记' })).toBeVisible();
  await expect(panel.getByText('暂无阅读笔记')).toHaveCount(0);
  fail = false;
  await panel.getByRole('button', { name: '重试加载笔记' }).click();
  const note = panel.locator('article').filter({ hasText: '我记下的简短理解。' });
  await expect(note.getByText('原文暂不可定位，摘录已保留')).toBeVisible();
  await expect(note.getByRole('button', { name: '定位原文' })).toBeDisabled();
  await expect(note.locator('blockquote')).toContainText('引用：这是用于理解笔记的原文摘录。');
  await expect(panel.getByRole('button', { name: '重试加载笔记' })).toHaveCount(0);
});


test('三个新建入口只记录位置，字号变化后仍可返回，无引用笔记可交接', async ({ page, request }) => {
  const title = 'notes-position-only';
  const book: Book = await (await request.post(`${fakeApiRoot}/api/reading/books`, { data: {
    commandId: title, title, author: '', format: 'md', text: '# 第三章\n\n' + '这里的论证需要和前面关于信息筛选的观点比较。'.repeat(100) + '\n\n# 第四章\n\n下一章的正文。',
  } })).json();
  await open(page, title);
  await page.getByLabel('页码', { exact: true }).fill('2');
  await page.getByRole('button', { name: '跳转', exact: true }).click();
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('2');
  const panel = page.getByRole('complementary', { name: '阅读笔记', exact: true });
  const read = async () => (await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/notes`)).json()) as ReadingNotesState;
  for (const [entry, body] of [
    ['记下第一条笔记', '这里的论证和前面有些矛盾，读完这一章后再比较。'],
    ['为当前页写笔记', '阅读过程中想到的另一个观点。'],
    ['新建阅读笔记', '侧栏中新建的独立想法。'],
  ]) {
    await page.getByRole('button', { name: entry, exact: true }).click();
    const card = page.getByRole('dialog', { name: '阅读笔记草稿' });
    await expect(card.locator('blockquote')).toHaveCount(0);
    await expect(card).toContainText('第三章');
    await page.getByLabel('笔记内容').fill(body!);
    await expect(page.getByRole('button', { name: '保存笔记', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '保存笔记', exact: true }).click();
    await expect(page.getByLabel('笔记内容')).toHaveCount(0);
    const note = panel.locator('article').filter({ hasText: body! });
    await expect(note).toContainText('阅读时记下');
    await expect(note.locator('blockquote')).toHaveCount(0);
    await expect(note.getByRole('button', { name: '定位原文' })).toBeEnabled();
  }
  const saved = await read();
  expect(saved.notes).toHaveLength(3);
  expect(saved.notes.every(note => note.reference === undefined && note.location?.version === book.version)).toBe(true);
  expect(saved.notes[0]!.location!.position.offset).toBeGreaterThan(0);
  await expect(page.locator('.reading-note-mark')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '查看此处笔记' }).first()).toBeAttached();
  await page.getByRole('button', { name: '字号', exact: true }).click();
  await page.getByRole('slider', { name: '字号', exact: true }).fill('32');
  await page.getByRole('button', { name: '关闭字号设置' }).click();
  await expect(page.getByLabel('页码', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '目录', exact: true }).click();
  await page.getByRole('navigation', { name: '目录' }).getByRole('button', { name: '第四章' }).click();
  const first = panel.locator('article').filter({ hasText: saved.notes[0]!.body });
  await first.getByRole('button', { name: '定位原文' }).click();
  await expect(page.getByRole('button', { name: '返回阅读处', exact: true })).toBeVisible();
  await expect(page.locator('.reading-located')).toHaveCount(0);
  // 检查原文字偏移实际回到可见页面，不能只比较已经失效的旧页码。
  await expect.poll(() => page.evaluate(position => {
    const paragraph = document.querySelector(`[data-chapter="${position.chapterId}"][data-paragraph="${position.paragraphId}"]`)!;
    const viewport = document.querySelector('.reading-page-viewport')!.getBoundingClientRect();
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let remaining = position.offset;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (remaining < node.textContent!.length) {
        const range = document.createRange(); range.setStart(node, remaining); range.setEnd(node, remaining + 1);
        const rect = range.getBoundingClientRect();
        return rect.left >= viewport.left - 1 && rect.right <= viewport.right + 1 && rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1;
      }
      remaining -= node.textContent!.length;
    }
    return false;
  }, saved.notes[0]!.location!.position)).toBe(true);
  expect((await read()).notes.map(note => note.location)).toEqual(saved.notes.map(note => note.location));
  await first.getByRole('button', { name: '编辑笔记' }).click();
  await expect(page.getByRole('button', { name: '交给 Multivac', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '交给 Multivac', exact: true }).click();
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json()).quote).toMatchObject({
    sourceKind: 'book', text: saved.notes[0]!.body, sourceBook: saved.notes[0]!.location,
  });
  await page.getByRole('button', { name: '定位书籍原文', exact: true }).click();
  await expect(page.locator('.reading-toolbar h2')).toHaveText(`《${title}》`);
});

for (const mobile of [false, true]) {
  test(`移除引用只去掉摘录，位置与正文保存后刷新不变${mobile ? '（手机）' : ''}`, async ({ page, request }) => {
    const title = `notes-remove-quote-${mobile}`;
    const book = await seed(request, title);
    await open(page, title, mobile);
    const read = async () => (await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/notes`)).json()) as ReadingNotesState;
    const original = (await read()).notes.find(note => note.id === 'short')!;
    const panel = page.getByRole('complementary', { name: '阅读笔记', exact: true });
    await panel.locator('article').filter({ hasText: original.body }).getByRole('button', { name: '编辑笔记' }).click();
    await expect(page.getByRole('dialog', { name: '阅读笔记草稿' }).locator('blockquote')).toContainText(original.reference!.text);
    await page.getByRole('button', { name: '移除引用', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '阅读笔记草稿' }).locator('blockquote')).toHaveCount(0);
    await expect(page.getByLabel('笔记内容')).toHaveValue(original.body);
    await expect(page.getByRole('button', { name: '定位草稿原文' })).toBeEnabled();
    await expect(page.getByRole('button', { name: '保存笔记', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '保存笔记', exact: true }).click();
    await expect(page.getByLabel('笔记内容')).toHaveCount(0);
    const saved = (await read()).notes.find(note => note.id === 'short')!;
    expect(saved.location).toEqual(original.location);
    expect(saved.body).toBe(original.body);
    expect(saved.reference).toBeUndefined();
    await page.reload();
    if (mobile) await page.getByRole('button', { name: '读书', exact: true }).click();
    else { await openPanel(page, 'management'); await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '读书', exact: true }).click(); }
    await expect(page.locator('.reading-toolbar h2')).toHaveText(`《${title}》`);
    await expect(page.getByLabel('页码', { exact: true })).toBeEnabled();
    if (!await panel.isVisible()) await page.getByRole('button', { name: '阅读笔记', exact: true }).click();
    const note = panel.locator('article').filter({ hasText: original.body });
    await expect(note).toContainText('阅读时记下');
    await expect(note.locator('blockquote')).toHaveCount(0);
    await expect(note.getByRole('button', { name: '定位原文' })).toBeEnabled();
  });
}

test('选区笔记保存选中文字，主动引用当前页与移除引用不改笔记位置', async ({ page, request }) => {
  const title = 'notes-optional-selection';
  const text = '讨论具体措辞时，只需要引用这一小句原文。'.repeat(40);
  const book: Book = await (await request.post(`${fakeApiRoot}/api/reading/books`, { data: { commandId: title, title, author: '', format: 'txt', text } })).json();
  await open(page, title);
  await page.evaluate(() => {
    const node = document.querySelector('.reading-flow p')!.firstChild!.firstChild!;
    const range = document.createRange(); range.setStart(node, 2); range.setEnd(node, 16);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.getByRole('toolbar', { name: '选区操作' }).getByRole('button', { name: '写笔记', exact: true }).click();
  const card = page.getByRole('dialog', { name: '阅读笔记草稿' });
  await expect(card.locator('blockquote')).toHaveText(`引用：${text.slice(2, 16)}`);
  await page.getByLabel('笔记内容').fill('我的理解是，作者在这里强调了范围。');
  const read = async () => (await (await request.get(`${fakeApiRoot}/api/reading/books/${book.id}/notes`)).json()) as ReadingNotesState;
  await expect.poll(async () => (await read()).draft?.body).toBe('我的理解是，作者在这里强调了范围。');
  const original = (await read()).draft!;
  expect(original.reference!.start).toEqual(original.location!.position);
  await page.getByRole('button', { name: '移除引用' }).click();
  await page.getByRole('button', { name: '引用当前页', exact: true }).click();
  await expect(card.locator('blockquote')).not.toHaveText(`引用：${text.slice(2, 16)}`);
  await expect.poll(async () => (await read()).draft?.reference?.start.offset).toBe(0);
  expect((await read()).draft!.location).toEqual(original.location);
  await page.getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(page.getByLabel('笔记内容')).toHaveCount(0);
  const saved = (await read()).notes[0]!;
  expect(saved.location).toEqual(original.location);
  expect(saved.reference!.text.length).toBeGreaterThan(original.reference!.text.length);
  await page.getByRole('complementary', { name: '阅读笔记', exact: true }).getByRole('button', { name: '定位原文' }).click();
  await expect(page.locator('.reading-located').first()).toBeVisible();
});
