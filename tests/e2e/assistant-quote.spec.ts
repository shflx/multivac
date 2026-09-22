import { expect, test, type Page } from '@playwright/test';
import type { AssistantSessionPageResponse } from '@multivac/contracts';
import { fakeApiRoot, resetE2eState } from './test-state.js';

const assistantEntry = 'entry-072';
const quoted = '消息仍从 Pi active branch 读取';

/** 用 Range 建立选区，覆盖鼠标与键盘两种入口共用的 selectionchange 路径。 */
async function selectWithin(page: Page, entryId: string, needle: string): Promise<void> {
  await page.evaluate(({ entryId, needle }) => {
    const host = document.querySelector(`[data-quote-entry-id="${CSS.escape(entryId)}"]`);
    if (!host) throw new Error(`未找到引用来源 ${entryId}`);
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent?.indexOf(needle) ?? -1;
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error(`未在 ${entryId} 中找到选区文本`);
  }, { entryId, needle });
}

async function selectAcrossMessages(page: Page): Promise<void> {
  await page.evaluate(() => {
    const hosts = [...document.querySelectorAll('[data-quote-entry-id]')].slice(-2);
    if (hosts.length < 2) throw new Error('可见消息不足两条。');
    const range = document.createRange();
    range.setStartBefore(hosts[0]!);
    range.setEndAfter(hosts[1]!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

function sessionPage(request: Page['request']): Promise<AssistantSessionPageResponse> {
  return request.get(`${fakeApiRoot}/api/assistant/session?limit=100`)
    .then((response) => response.json() as Promise<AssistantSessionPageResponse>);
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  const current = await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json() as {
    revision: number;
  };
  await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
    data: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: current.revision },
  });
  await page.goto('/');
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
});

test('引用助手正文后追问：模型收到引用，用户消息展示引用块，刷新后仍在', async ({ page, request }) => {
  await selectWithin(page, assistantEntry, quoted);

  const toolbar = page.getByRole('toolbar', { name: '选中内容操作' });
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole('button', { name: '引用', exact: true }).click();

  // 引用进入输入区预览，焦点回到输入框。
  const preview = page.locator('.composer-quote');
  await expect(preview).toBeVisible();
  await expect(preview.locator('p')).toHaveText(quoted);
  await expect(toolbar).toHaveCount(0);
  const draft = page.getByLabel('Multivac 草稿');
  await expect(draft).toBeFocused();
  await expect(draft).toHaveAttribute('placeholder', '基于这段内容继续讨论…');

  // 只有引用、没有非空追问时不允许发送。
  await expect(page.getByLabel('发送消息')).toBeDisabled();

  await draft.fill('这一步具体怎么校准？');
  await page.getByLabel('发送消息').click();
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();

  const snapshot = await sessionPage(request);
  const submitted = snapshot.messages.find((message) => message.text === '这一步具体怎么校准？');
  expect(submitted?.quote).toEqual({
    sourcePiSessionId: snapshot.piSessionId,
    sourcePiEntryId: assistantEntry,
    sourceRole: 'assistant',
    text: quoted,
  });

  const sentRow = page.locator('article.chat-row.user').filter({ hasText: '这一步具体怎么校准？' });
  await expect(sentRow.locator('.message-quote')).toHaveText(quoted);
  // 发送成功后草稿与引用一并清空。
  await expect(draft).toHaveValue('');
  await expect(page.locator('.composer-quote')).toHaveCount(0);

  await page.reload();
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
  await expect(sentRow.locator('.message-quote')).toHaveText(quoted);
});

test('添加、替换与移除引用都不改动草稿', async ({ page }) => {
  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill('已经写了一半的追问');

  await selectWithin(page, assistantEntry, quoted);
  await page.getByRole('toolbar', { name: '选中内容操作' }).getByRole('button', { name: '引用', exact: true }).click();
  await expect(page.locator('.composer-quote p')).toHaveText(quoted);
  await expect(draft).toHaveValue('已经写了一半的追问');

  // 再次引用替换当前引用，不追加第二条。
  await selectWithin(page, assistantEntry, '已记录当前进度');
  await page.getByRole('toolbar', { name: '选中内容操作' }).getByRole('button', { name: '引用', exact: true }).click();
  await expect(page.locator('.composer-quote')).toHaveCount(1);
  await expect(page.locator('.composer-quote p')).toHaveText('已记录当前进度');
  await expect(draft).toHaveValue('已经写了一半的追问');

  await page.getByRole('button', { name: '移除引用' }).click();
  await expect(page.locator('.composer-quote')).toHaveCount(0);
  await expect(draft).toHaveValue('已经写了一半的追问');
  await expect(draft).toHaveAttribute('placeholder', '发送消息给 Multivac…');
});

test('未发送的引用与草稿一起保存，刷新后恢复', async ({ page, request }) => {
  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill('稍后再问');
  await selectWithin(page, assistantEntry, quoted);
  await page.getByRole('toolbar', { name: '选中内容操作' }).getByRole('button', { name: '引用', exact: true }).click();
  await expect(page.getByText('草稿已保存')).toBeVisible();

  const stored = await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json() as {
    draft: string;
    quote: { sourcePiEntryId: string; text: string } | null;
  };
  expect(stored.draft).toBe('稍后再问');
  expect(stored.quote?.sourcePiEntryId).toBe(assistantEntry);
  expect(stored.quote?.text).toBe(quoted);

  await page.reload();
  await expect(page.getByLabel('Multivac 草稿')).toHaveValue('稍后再问');
  await expect(page.locator('.composer-quote p')).toHaveText(quoted);
});

test('跨消息选区与输入框选区都不提供引用入口', async ({ page }) => {
  await selectAcrossMessages(page);
  await expect(page.getByRole('toolbar', { name: '选中内容操作' })).toHaveCount(0);

  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill('输入区里的文字不应成为引用来源');
  await draft.selectText();
  await expect(page.getByRole('toolbar', { name: '选中内容操作' })).toHaveCount(0);
});

test('关闭工具条与清空选区都不残留引用入口', async ({ page }) => {
  await selectWithin(page, assistantEntry, quoted);
  const toolbar = page.getByRole('toolbar', { name: '选中内容操作' });
  await expect(toolbar).toBeVisible();
  await page.getByRole('button', { name: '关闭引用工具条' }).click();
  await expect(toolbar).toHaveCount(0);
  await expect(page.locator('.composer-quote')).toHaveCount(0);

  await selectWithin(page, assistantEntry, quoted);
  await expect(toolbar).toBeVisible();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect(toolbar).toHaveCount(0);
});

test('引用正文按纯文本展示，保留换行且不渲染 HTML 或远程图片', async ({ page, request }) => {
  const current = await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json() as {
    revision: number;
  };
  const snapshot = await sessionPage(request);
  const text = '第一行\n<img src="https://evil.example/pixel.png" onerror="alert(1)">\n  第三行保留缩进';
  await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
    data: {
      draft: '这段是什么意思？',
      anchorEntryId: null,
      anchorOffsetPx: 0,
      quote: {
        sourcePiSessionId: snapshot.piSessionId,
        sourcePiEntryId: assistantEntry,
        sourceRole: 'assistant',
        text,
      },
      revision: current.revision,
    },
  });

  await page.reload();
  await expect(page.getByLabel('Multivac 草稿')).toHaveValue('这段是什么意思？');
  const preview = page.locator('.composer-quote p');
  await expect(preview).toHaveText(text);
  expect(await preview.locator('img').count()).toBe(0);
});
