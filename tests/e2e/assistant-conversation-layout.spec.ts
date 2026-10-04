import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

async function publishDelta(request: APIRequestContext, messageId: string, delta: string): Promise<void> {
  const response = await request.post(`${fakeApiRoot}/api/__e2e/assistant/events/body`, {
    data: { messageId, delta },
  });
  expect(response.ok()).toBe(true);
}

function distanceToBottom(scroll: Locator): Promise<number> {
  return scroll.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
}

async function quoteFrom(page: Page, entryId: string, length: number): Promise<void> {
  await page.evaluate(({ entryId, length }) => {
    const host = document.querySelector(`[data-quote-entry-id="${CSS.escape(entryId)}"]`);
    const node = host && document.createTreeWalker(host, NodeFilter.SHOW_TEXT).nextNode();
    if (!node) throw new Error(`未找到引用来源 ${entryId}`);
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  }, { entryId, length });
  await page.getByRole('toolbar', { name: '选中内容操作' }).getByRole('button', { name: '引用', exact: true }).click();
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  const current = await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json() as {
    revision: number;
  };
  await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
    data: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: current.revision },
  });
});

for (const width of [1280, 900] as const) {
  test(`${width}px 会话页：助手无气泡、用户靠右气泡、引用紧凑、状态条收在输入区卡片内`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 860 });
    await page.goto('/');
    const draft = page.getByLabel('Multivac 草稿');
    await expect(draft).toBeEditable();

    // 助手消息正文直接排版，用户消息靠右并带浅色气泡。
    const assistantBody = page.locator('article.chat-row.assistant').last().locator('.markdown-body');
    const userRow = page.locator('article.chat-row.user').last();
    await expect(assistantBody).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(userRow).toHaveCSS('flex-direction', 'row-reverse');
    await expect(userRow.locator('p')).toHaveCSS('background-color', 'rgb(233, 237, 242)');
    // 作者名只留给辅助技术，不单独占一行。
    await expect(page.locator('.message-author').first()).toHaveCSS('clip-path', 'inset(50%)');

    // 输入区引用预览：紧凑两行、可移除，标签只给辅助技术。
    await quoteFrom(page, 'entry-072', 12);
    const preview = page.locator('.composer-quote');
    await expect(preview.locator('p')).toHaveCSS('-webkit-line-clamp', '2');
    await expect(preview.locator('span')).toHaveCSS('clip-path', 'inset(50%)');
    await expect(preview.getByRole('button', { name: '移除引用' })).toBeVisible();

    // 运行中：状态条与停止按钮都在输入区卡片内。
    expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);
    await draft.fill('确认状态条的位置');
    await page.getByLabel('发送消息').click();
    const composer = page.locator('.assistant-composer');
    const status = composer.getByRole('status');
    await expect(status).toBeVisible();
    await expect(status.getByRole('button', { name: '取消当前处理' })).toContainText('停止');

    // 发送后的用户消息：引用块与气泡等宽、无缝相接。
    const sent = page.locator('article.chat-row.user').filter({ hasText: '确认状态条的位置' });
    const quoteBox = await sent.locator('.message-quote').boundingBox();
    const bubbleBox = await sent.locator('p').boundingBox();
    expect(Math.abs(quoteBox!.width - bubbleBox!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(quoteBox!.y + quoteBox!.height - bubbleBox!.y)).toBeLessThanOrEqual(1);

    // 输入区卡片固定在会话底部，页面不出现横向溢出。
    const composerBox = await composer.boundingBox();
    expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(860);
    expect(composerBox!.y + composerBox!.height).toBeGreaterThan(860 - 60);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth))
      .toBe(false);

    expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
    await expect(status.getByText('处理完成', { exact: true })).toBeVisible();
    await expect(status.getByRole('button', { name: '取消当前处理' })).toHaveCount(0);
  });
}

test('连续同一发言人收紧间距并省去重复头像', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
  const rows = page.locator('article.chat-row');
  const previous = rows.last();
  await expect(previous).toHaveClass(/assistant/);

  await publishDelta(request, 'assistant:e2e:continued', '紧接着的第二段助手回复');
  const continued = rows.filter({ hasText: '紧接着的第二段助手回复' });
  await expect(continued).toHaveClass(/continued/);
  await expect(continued.locator('.avatar')).toHaveCSS('visibility', 'hidden');
  const gap = await page.evaluate(() => {
    const [first, second] = [...document.querySelectorAll('article.chat-row')].slice(-2);
    return second!.getBoundingClientRect().top - first!.getBoundingClientRect().bottom;
  });
  expect(gap).toBeLessThan(22);
});

test('运行中上翻阅读不被拉回；自己发送后回到底部并持续跟随', async ({ page, request }) => {
  await page.goto('/');
  const draft = page.getByLabel('Multivac 草稿');
  await expect(draft).toBeEditable();
  const scroll = page.locator('.message-scroll');

  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);
  await draft.fill('开始一段较长的运行');
  await page.getByLabel('发送消息').click();
  await expect(page.getByRole('button', { name: '取消当前处理' })).toBeVisible();

  // 贴近底部时新内容继续跟随。
  await publishDelta(request, 'assistant:e2e:follow', '运行中的回复');
  await publishDelta(request, 'assistant:e2e:follow', '\n跟随中的正文'.repeat(60));
  await expect.poll(() => distanceToBottom(scroll)).toBeLessThanOrEqual(2);

  // 上翻阅读后，运行中的新内容不再把视图拉回底部。
  await scroll.hover();
  await page.mouse.wheel(0, -600);
  await expect.poll(() => distanceToBottom(scroll)).toBeGreaterThan(100);
  const readingTop = await scroll.evaluate((element) => element.scrollTop);
  await publishDelta(request, 'assistant:e2e:follow', '\n上翻期间追加'.repeat(20));
  await expect(page.locator('article.chat-row.assistant').filter({ hasText: '上翻期间追加' })).toHaveCount(1);
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(readingTop, 0);

  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();

  // 自己发送后回到底部，并继续跟随后续内容。
  await draft.fill('发送后恢复跟随');
  await page.getByLabel('发送消息').click();
  await expect(page.locator('article.chat-row.user').filter({ hasText: '发送后恢复跟随' })).toHaveCount(1);
  await expect.poll(() => distanceToBottom(scroll)).toBeLessThanOrEqual(2);
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await publishDelta(request, 'assistant:e2e:after-send', '\n发送后的新内容'.repeat(40));
  await expect(page.locator('article.chat-row.assistant').filter({ hasText: '发送后的新内容' })).toHaveCount(1);
  await expect.poll(() => distanceToBottom(scroll)).toBeLessThanOrEqual(2);
});

test('轨迹内容与可视区尺寸变化时继续贴底，上翻后保留阅读位置', async ({ page, request }) => {
  await page.goto('/');
  const draft = page.getByLabel('Multivac 草稿');
  await expect(draft).toBeEditable();
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);
  await draft.fill('多步工具场景：验证轨迹滚动');
  await draft.press('Enter');
  const scroll = page.locator('.message-scroll');
  const trace = page.locator('.run-trace').filter({ has: page.locator('[data-tool-call-id="tool-multi-read"]') });
  await expect(trace.locator('.run-trace-tool')).toHaveCount(2);
  await expect(trace).toHaveAttribute('open', '');
  await expect.poll(() => distanceToBottom(scroll)).toBeLessThanOrEqual(2);
  await expect(scroll).toHaveCSS('mask-image', 'none');

  // 单独改变轨迹高度，不产生正文更新，复现持续思考时的尺寸变化。
  const thought = trace.locator('.run-trace-thought').first();
  await thought.evaluate((element) => { element.textContent += '\n持续思考中的内容'.repeat(100); });
  await expect.poll(() => distanceToBottom(scroll)).toBeLessThanOrEqual(2);
  await page.setViewportSize({ width: 1280, height: 650 });
  await expect.poll(() => distanceToBottom(scroll)).toBeLessThanOrEqual(2);

  await scroll.hover();
  await page.mouse.wheel(0, -500);
  await expect.poll(() => distanceToBottom(scroll)).toBeGreaterThan(100);
  const readingTop = await scroll.evaluate((element) => element.scrollTop);
  await thought.evaluate((element) => { element.textContent += '\n继续增长的思考'.repeat(30); });
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(readingTop, 0);

  // 回到底部后，正文出现引起轨迹自动收起，也继续贴底。
  await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => distanceToBottom(scroll)).toBeLessThanOrEqual(2);
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(trace).not.toHaveAttribute('open', '');
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect.poll(() => distanceToBottom(scroll)).toBeLessThanOrEqual(2);
});

test('停止后恢复历史时，过程说明留在轨迹里而不成为最终回复', async ({ page, request }) => {
  await page.goto('/');
  const draft = page.getByLabel('Multivac 草稿');
  await expect(draft).toBeEditable();
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);
  await draft.fill('多步工具场景：停止后的正文归属');
  await draft.press('Enter');
  const trace = page.locator('.run-trace').filter({ has: page.locator('[data-tool-call-id="tool-multi-read"]') });
  await expect(trace.locator('.run-trace-tool')).toHaveCount(2);
  await page.getByRole('button', { name: '取消当前处理' }).click();
  await expect(page.locator('.run-status')).toHaveClass(/cancelled/);
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await expect(trace).toBeVisible();
    await expect(page.locator('article.chat-row.assistant').filter({ hasText: '我先读一下项目约束。' })).toHaveCount(0);
    await expect(page.locator('article.chat-row.assistant').filter({ hasText: '约束已确认，再跑一下测试。' })).toHaveCount(0);
    if (await trace.getAttribute('open') === null) await trace.locator('summary').click();
    await expect(trace.locator('.run-trace-note')).toHaveCount(2);
  }
});


for (const panel of ['workspace', 'management'] as const) {
  test(`Multivac 侧栏在 ${panel} 中的长消息、代码和表格不撑出内容区`, async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
    await quoteFrom(page, 'entry-072', 20);
    await openPanel(page, panel);
    await page.keyboard.press('ControlOrMeta+J');
    const sidebar = page.getByRole('complementary', { name: 'Multivac 侧栏' });
    await expect(sidebar).toBeVisible();
    const draft = sidebar.getByLabel('Multivac 草稿');
    await expect(draft).toBeEditable();
    await draft.fill('长消息正文'.repeat(150) + 'https://example.com/' + 'a'.repeat(300));
    await sidebar.getByLabel('发送消息').click();
    await expect(sidebar.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
    await publishDelta(request, 'assistant:sidebar-width', '# 长回复\n\n' + '不可断开的标识'.repeat(60) +
      '\n\n```text\n' + 'long_code_'.repeat(100) + '\n```\n\n| 第一列 | 第二列 | 第三列 |\n| --- | --- | --- |\n| ' + 'long_cell_'.repeat(50) + ' | b | c |');
    await expect(sidebar.locator('.markdown-table-scroll')).toHaveCount(1);
    for (const dock of ['push', 'overlay']) {
      if (dock === 'overlay') await sidebar.getByLabel('改为浮在页面上').click();
      await expect.poll(() => sidebar.evaluate(root => {
        const scroll = root.querySelector('.message-scroll')!;
        const area = scroll.getBoundingClientRect();
        return [...root.querySelectorAll('.chat-row, .chat-content, .chat-content > p, .message-quote, .markdown-body, .markdown-code-block, .markdown-table-scroll')].flatMap(node => {
          const rect = node.getBoundingClientRect();
          return rect.left < area.left - 1 || rect.right > area.left + scroll.clientWidth + 1
            ? [{ className: node.className, left: rect.left - area.left, right: rect.right - area.left, available: scroll.clientWidth }] : [];
        });
      })).toEqual([]);
      // 正文只能使用两侧头像之间的区域，不能只检查是否超出侧栏外框。
      await expect.poll(() => sidebar.evaluate(root => {
        const assistantAvatar = root.querySelector('.chat-row.assistant .avatar')!.getBoundingClientRect();
        const userAvatar = root.querySelector('.chat-row.user .avatar')!.getBoundingClientRect();
        const left = assistantAvatar.right + 8;
        const right = userAvatar.left - 8;
        return [...root.querySelectorAll('.chat-content')].flatMap(content => {
          const rect = content.getBoundingClientRect();
          return rect.left < left - 1 || rect.right > right + 1
            ? [{ text: content.textContent?.slice(0, 30), left: rect.left, right: rect.right, allowedLeft: left, allowedRight: right }] : [];
        });
      })).toEqual([]);
      expect(await sidebar.locator('.message-scroll').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      // 宽代码与表格在各自区域滚动，不裁掉内容，也不撑宽整个对话。
      for (const selector of ['.markdown-body pre', '.markdown-table-scroll']) {
        const content = sidebar.locator(selector).last();
        expect(await content.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
        await content.evaluate(el => { el.scrollLeft = 100; });
        expect(await content.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
      }
    }
  });
}
