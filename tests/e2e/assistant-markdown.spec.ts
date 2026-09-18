import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { fakeApiRoot, resetE2eState } from './test-state.js';

async function publish(request: APIRequestContext, delta: string, completed = false, messageId = 'assistant:markdown') {
  const response = await request.post(`${fakeApiRoot}/api/__e2e/assistant/events/body`, {
    data: { messageId, delta, completed },
  });
  expect(response.ok()).toBe(true);
}

function markdownRow(page: Page) {
  return page.locator('.chat-row.assistant').filter({ has: page.locator('.markdown-body h1', { hasText: 'Markdown 验证' }) });
}

const richMarkdown = `# Markdown 验证

第一段 **粗体** *斜体* ~~删除~~ 与 \`inline()\`。

第二段。

> 引用正文

- 无序一
- 无序二

1. 有序一
2. 有序二

- [x] 已完成
- [ ] 待处理

[安全链接](https://example.com/path) 与 <https://example.com/auto>

---

| 项目 | 数量 |
| :--- | ---: |
| Alpha | 2 |

\`\`\`javascript
const answer = 42;
console.log(answer);

\`\`\`
`;

test.beforeEach(async ({ request }) => {
  await resetE2eState(request);
  const current = await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json();
  expect((await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
    data: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, revision: current.revision },
  })).ok()).toBe(true);
});

test('历史 Markdown 元素、安全链接和只读任务展示，刷新不改变原文', async ({ page, request }) => {
  await publish(request, richMarkdown, true);
  await page.goto('/');
  const row = markdownRow(page);
  await expect(row).toHaveCount(1);
  await expect(row.locator('strong')).toHaveText('粗体');
  await expect(row.locator('em')).toHaveText('斜体');
  await expect(row.locator('del')).toHaveText('删除');
  await expect(row.locator('blockquote')).toContainText('引用正文');
  await expect(row.locator('ul')).toHaveCount(2);
  await expect(row.locator('ol li')).toHaveCount(2);
  await expect(row.locator('hr')).toHaveCount(1);
  await expect(row.locator('p code')).toHaveText('inline()');
  await expect(row.locator('th')).toHaveCount(2);
  await expect(row.locator('td').last()).toHaveAttribute('style', 'text-align: right;');
  const tasks = row.getByRole('checkbox');
  await expect(tasks).toHaveCount(2);
  await expect(tasks.nth(0)).toBeChecked();
  await expect(tasks.nth(0)).toBeDisabled();
  await expect(tasks.nth(1)).not.toBeChecked();
  await expect(tasks.nth(1)).toBeDisabled();
  await expect(row.getByRole('link', { name: '安全链接', exact: true })).toHaveAttribute('target', '_blank');
  await expect(row.getByRole('link', { name: '安全链接', exact: true })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(row.locator('.markdown-code-toolbar')).toContainText('javascript');
  await expect(row.locator('code .hljs-keyword')).toHaveText('const');
  const snapshot = await (await request.get(`${fakeApiRoot}/api/assistant/session`)).json();
  expect(snapshot.messages.find((message: { text: string }) => message.text === richMarkdown)).toBeTruthy();
  await page.reload();
  await expect(markdownRow(page)).toHaveCount(1);
});

test('raw HTML、危险协议和远程图片均不执行或加载，图片提供可访问安全链接', async ({ page, request }) => {
  const imageRequests: string[] = [];
  page.on('request', (event) => {
    if (event.url().includes('example.com')) imageRequests.push(event.url());
  });
  await publish(request, `# Markdown 验证

<script>window.__markdownExecuted = true</script>
<img src="https://example.com/raw.png" onerror="window.__markdownExecuted=true">
<iframe src="https://example.com/frame"></iframe>

[脚本](javascript:alert%281%29) [数据](data:text/html,test) [文件](file:///tmp/test) [VB](vbscript:msgbox%281%29)
[实体混淆](jav&#x61;script:alert%281%29) [控制混淆](java&#x09;script:alert%281%29)

![图像说明](https://example.com/image.png) ![不安全图片](javascript:alert%281%29)

[站内](/safe) [邮件](mailto:test@example.com)
`, true);
  await page.goto('/');
  const row = markdownRow(page);
  await expect(row.locator('script, img, iframe')).toHaveCount(0);
  await expect(row.getByRole('link')).toHaveCount(4);
  await expect(row.getByRole('link', { name: '图像说明' })).toHaveAttribute('href', 'https://example.com/image.png');
  await expect(row.getByRole('link', { name: '图像说明' })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(row.getByText('不安全图片', { exact: true })).toBeVisible();
  expect(await row.getByRole('link', { name: '站内', exact: true }).getAttribute('target')).toBeNull();
  expect(await row.locator('a').evaluateAll((links) => links.map((link) => link.getAttribute('href'))))
    .toEqual(['java%09script:alert%281%29', 'https://example.com/image.png', '/safe', 'mailto:test@example.com']);
  // 实体还原的 javascript 已被移除；编码的控制符也不能成为浏览器可执行协议。
  const protocols = await row.locator('a').evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).protocol));
  for (const protocol of protocols) expect(protocol).not.toMatch(/^(?:javascript|data|vbscript|file):$/i);
  expect(await page.evaluate(() => '__markdownExecuted' in window)).toBe(false);
  expect(imageRequests).toEqual([]);
});

test('退引用/列表容器、长围栏及混合行结束符复制精确，EOF 不补换行', async ({ page, request }) => {
  const examples = [
    { markdown: '> ```js\n> x\noutside', code: 'x\n' },
    { markdown: '- item\n\n  ```js\n  x\noutside', code: 'x\n' },
    { markdown: '> ```js\r\n> x\r\noutside', code: 'x\r\n' },
    { markdown: '- item\r\n\r\n  ~~~~~~js\n  x\r\n  y\noutside', code: 'x\r\ny\n' },
    { markdown: '> ``````js\r\n> a\n> b\r\noutside', code: 'a\nb\r\n' },
    { markdown: '``````js\nx\n```\ny\n``````\noutside', code: 'x\n```\ny\n' },
    { markdown: '> ```js\n> \noutside', code: '\n' },
    { markdown: '```js\n```\noutside', code: '' },
    { markdown: '> ```js\n> x', code: 'x' },
  ];
  await page.addInitScript(() => {
    const values: string[] = [];
    Object.assign(window, { __markdownCopiedValues: values });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => { values.push(value); },
    } });
  });
  await publish(request, '# Markdown 验证\n\n' + examples.map((example) => example.markdown).join('\n\n'), true);
  await page.goto('/');
  const blocks = markdownRow(page).locator('.markdown-code-block');
  await expect(blocks).toHaveCount(examples.length);
  for (let index = 0; index < examples.length; index += 1) {
    await blocks.nth(index).getByRole('button', { name: '复制代码' }).click();
    await expect(blocks.nth(index).getByRole('status')).toHaveText('已复制');
  }
  expect(await page.evaluate(() => (window as Window & { __markdownCopiedValues: string[] }).__markdownCopiedValues))
    .toEqual(examples.map((example) => example.code));
});

test('多消息同名脚注隔离，引用/回跳当前页导航且保留锚点和可访问关系', async ({ page, request, context }) => {
  for (const name of ['甲', '乙']) {
    await publish(request, `# 脚注${name}\n\n首处[^same] 再次[^same]\n\n[片段](#local) ![片段图片](#local)\n\n${'正文段落。\n\n'.repeat(45)}[^same]: ${name}的脚注 [外部](https://example.com/)`,
      true, `assistant:footnote:${name}`);
  }
  await page.goto('/');
  for (const name of ['甲', '乙']) {
    const body = page.locator('.markdown-body').filter({ has: page.getByRole('heading', { name: `脚注${name}`, exact: true }) });
    const references = body.locator('a[data-footnote-ref]');
    const backlinks = body.locator('a[data-footnote-backref]');
    await expect(references).toHaveCount(2);
    await expect(backlinks).toHaveCount(2);
    for (const label of ['片段', '片段图片']) {
      const link = body.getByRole('link', { name: label, exact: true });
      await expect(link).toHaveAttribute('href', '#local');
      expect(await link.getAttribute('target')).toBeNull();
    }
    for (let index = 0; index < 2; index += 1) {
      const reference = references.nth(index);
      const backlink = backlinks.nth(index);
      const target = (await reference.getAttribute('href'))!.slice(1);
      const referenceId = (await reference.getAttribute('id'))!;
      const label = (await reference.getAttribute('aria-describedby'))!;
      expect(target).toBeTruthy();
      expect(referenceId).toBeTruthy();
      expect(label).toBeTruthy();
      await expect(body.locator(`[id="${target}"]`)).toHaveCount(1);
      await expect(body.locator(`[id="${label}"]`)).toHaveText('Footnotes');
      await expect(backlink).toHaveAttribute('href', `#${referenceId}`);
      expect(await backlink.getAttribute('aria-label')).toBeTruthy();
      expect(await reference.getAttribute('target')).toBeNull();
      expect(await backlink.getAttribute('target')).toBeNull();
      await reference.click();
      await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#${target}`);
      await expect(body.locator(`[id="${target}"]`)).toBeInViewport();
      await backlink.click();
      await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#${referenceId}`);
      await expect(reference).toBeInViewport();
    }
    await expect(body.getByRole('link', { name: '外部', exact: true })).toHaveAttribute('target', '_blank');
  }
  const ids = await page.locator('.markdown-body [id]').evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(new Set(ids).size).toBe(ids.length);
  expect(context.pages()).toHaveLength(1);
});

test('脚注前缀在累计流式、工作面隐藏和历史校准后保持稳定', async ({ page, request }) => {
  await page.goto('/');
  const text = '# Markdown 验证\n\n正文[^same]\n\n[^same]: 同名脚注';
  await publish(request, text, false, 'assistant:footnote:stable');
  const body = markdownRow(page).locator('.markdown-body');
  const reference = body.locator('a[data-footnote-ref]');
  await expect(reference).toHaveCount(1);
  const before = await reference.evaluate((node) => ({
    id: node.id, href: node.getAttribute('href'), label: node.getAttribute('aria-describedby'),
  }));
  await publish(request, '\n\n**累计新段落**', false, 'assistant:footnote:stable');
  await expect(body.locator('strong')).toHaveText('累计新段落');
  await page.getByRole('button', { name: '当前会话模型' }).click();
  await page.getByRole('button', { name: '管理模型配置' }).click();
  await publish(request, `${text}\n\n**最终段落**`, true, 'assistant:footnote:stable');
  await expect(body.locator('strong')).toHaveText('最终段落');
  expect(await reference.evaluate((node) => ({
    id: node.id, href: node.getAttribute('href'), label: node.getAttribute('aria-describedby'),
  }))).toEqual(before);
  await page.getByRole('button', { name: '返回工作模式' }).first().click();
  await reference.click();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(before.href);
  const backlink = body.locator('a[data-footnote-backref]');
  await backlink.click();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#${before.id}`);
  await page.reload();
  await expect(reference).toHaveCount(1);
  expect(await reference.getAttribute('id')).toBe(before.id);
});

test('复制使用未高亮原文并保留 CRLF 和末尾空行，失败可访问且可重试', async ({ page, request }) => {
  await page.addInitScript(() => {
    const state = { fail: true, values: [] as string[] };
    Object.assign(window, { __markdownClipboard: state });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => {
        state.values.push(value);
        if (state.fail) throw new Error('denied');
      },
    } });
  });
  const code = 'const value = "<div>&";\r\n  console.log(value);\r\n\r\n';
  await publish(request, `# Markdown 验证\r\n\r\n\`\`\`js\r\n${code}\`\`\``, true);
  await page.goto('/');
  const row = markdownRow(page);
  const copy = row.getByRole('button', { name: '复制代码' });
  await expect(copy).toHaveAttribute('title', '复制代码');
  await copy.click();
  await expect(row.getByRole('status')).toHaveText('复制失败，请重试');
  await page.evaluate(() => {
    (window as Window & { __markdownClipboard: { fail: boolean } }).__markdownClipboard.fail = false;
  });
  await copy.click();
  await expect(row.getByRole('status')).toHaveText('已复制');
  expect(await page.evaluate(() => (window as Window & { __markdownClipboard: { values: string[] } }).__markdownClipboard.values))
    .toEqual([code, code]);
});

for (const width of [320, 390, 1440]) {
  test(`${width}px 超长未知语言省略，复制成功失败反馈完整且图标尺寸稳定`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      const state = { fail: false, values: [] as string[] };
      Object.assign(window, { __markdownClipboard: state });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async (value: string) => {
          state.values.push(value);
          if (state.fail) throw new Error('denied');
        },
      } });
    });
    const language = `unknown-language-${'long'.repeat(16)}`;
    const code = 'const value = 42;\n';
    await publish(request, `# Markdown 验证\n\n\`\`\`${language}\n${code}\`\`\``, true);
    await page.goto('/');
    const toolbar = markdownRow(page).locator('.markdown-code-toolbar');
    const label = toolbar.locator('span').first();
    const copy = toolbar.getByRole('button', { name: '复制代码' });
    await expect(label).toHaveAttribute('title', language);
    await expect(label).toHaveText(language);
    expect(await label.evaluate((node) => getComputedStyle(node).textOverflow)).toBe('ellipsis');
    if (width <= 390) expect(await label.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeGreaterThan(0);
    const before = await copy.evaluate((node) => {
      const button = node.getBoundingClientRect();
      const toolbar = node.closest('.markdown-code-toolbar')!.getBoundingClientRect();
      return { top: button.top - toolbar.top, right: toolbar.right - button.right };
    });

    for (const fail of [false, true]) {
      await page.evaluate((value) => {
        (window as Window & { __markdownClipboard: { fail: boolean } }).__markdownClipboard.fail = value;
      }, fail);
      await copy.click();
      await expect(toolbar.getByRole('status')).toHaveText(fail ? '复制失败，请重试' : '已复制');
      const layout = await toolbar.evaluate((node) => {
        const bar = node.getBoundingClientRect();
        const label = node.querySelector('span')!.getBoundingClientRect();
        const feedback = node.querySelector('.markdown-copy-feedback')!;
        const status = feedback.getBoundingClientRect();
        const button = node.querySelector('button')!.getBoundingClientRect();
        const icon = node.querySelector('button svg')!.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(feedback);
        const text = [...range.getClientRects()].filter((rect) => rect.width > 0);
        return {
          height: bar.height, feedbackHeight: status.height, feedbackWidth: status.width,
          lines: text.length, textWidth: Math.max(...text.map((rect) => rect.width)),
          feedbackBelowLabel: status.top - label.bottom,
          overlap: Math.max(0, Math.min(label.right, status.right) - Math.max(label.left, status.left)) *
            Math.max(0, Math.min(label.bottom, status.bottom) - Math.max(label.top, status.top)),
          buttonWidth: button.width, buttonHeight: button.height, iconWidth: icon.width, iconHeight: icon.height,
          top: button.top - bar.top, right: bar.right - button.right,
          toolbarOverflow: node.scrollWidth - node.clientWidth,
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
        };
      });
      expect(layout.lines).toBe(1);
      expect(layout.feedbackWidth).toBeGreaterThanOrEqual(layout.textWidth);
      expect(layout.feedbackHeight).toBeLessThanOrEqual(22);
      expect(layout.height).toBeLessThanOrEqual(64);
      expect(layout.overlap).toBe(0);
      if (width <= 390) expect(layout.feedbackBelowLabel).toBeGreaterThanOrEqual(0);
      expect(layout.buttonWidth).toBe(28);
      expect(layout.buttonHeight).toBe(28);
      expect(layout.iconWidth).toBe(15);
      expect(layout.iconHeight).toBe(15);
      expect(layout.top).toBeCloseTo(before.top, 1);
      expect(layout.right).toBeCloseTo(before.right, 1);
      expect(layout.toolbarOverflow).toBeLessThanOrEqual(0);
      expect(layout.pageOverflow).toBeLessThanOrEqual(0);
      expect(layout.bodyOverflow).toBeLessThanOrEqual(0);
      await page.screenshot({ path: testInfo.outputPath(`long-language-${width}-${fail ? 'failure' : 'success'}.png`), fullPage: true });
    }
    expect(await page.evaluate(() => (window as Window & { __markdownClipboard: { values: string[] } }).__markdownClipboard.values))
      .toEqual([code, code]);
  });
}

test('未闭合、缩进、嵌套、未知语言和空代码复制不补造换行，Clipboard 缺失可重试', async ({ page, request }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  });
  const examples = [
    { markdown: '```\nplain text\n\n```', code: 'plain text\n\n' },
    { markdown: '~~~unknown\none\n~~~', code: 'one\n' },
    { markdown: '```js\n```', code: '' },
    { markdown: '    indented\n    second\n', code: 'indented\nsecond\n' },
    { markdown: '> ```js\n> const nested = 1;\n> ```', code: 'const nested = 1;\n' },
    { markdown: '- item\n\n  ```js\n  const nested = 2;\n  ```', code: 'const nested = 2;\n' },
    { markdown: '```js\nconst partial = 1;', code: 'const partial = 1;' },
  ];
  await publish(request, '# Markdown 验证\n\n' + examples.map((example) => example.markdown).join('\n\n'), true);
  await page.goto('/');
  const row = markdownRow(page);
  const blocks = row.locator('.markdown-code-block');
  await expect(blocks).toHaveCount(examples.length);
  await blocks.first().getByRole('button', { name: '复制代码' }).click();
  await expect(blocks.first().getByRole('status')).toHaveText('复制失败，请重试');
  await page.evaluate(() => {
    const values: string[] = [];
    Object.assign(window, { __markdownCopiedValues: values });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => { values.push(value); },
    } });
  });
  for (let index = 0; index < examples.length; index += 1) {
    await blocks.nth(index).getByRole('button', { name: '复制代码' }).click();
    await expect(blocks.nth(index).getByRole('status')).toHaveText('已复制');
  }
  expect(await page.evaluate(() => (window as Window & { __markdownCopiedValues: string[] }).__markdownCopiedValues))
    .toEqual(examples.map((example) => example.code));
});

test('用户保留纯文本换行，累计流式未闭合代码与格式安全渲染并由历史校准', async ({ page, request, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const draft = page.getByLabel('Multivac 草稿');
  const userText = '# 用户不是标题\n**不是粗体**\n第三行';
  await draft.fill(userText);
  await page.getByLabel('发送消息').click();
  const user = page.locator('.chat-row.user').filter({ hasText: '用户不是标题' });
  await expect(user.locator('p')).toHaveText(userText);
  await expect(user.locator('h1, strong')).toHaveCount(0);
  expect(await user.locator('p').evaluate((node) => getComputedStyle(node).whiteSpace)).toBe('pre-wrap');
  await expect(page.getByText('处理完成', { exact: true })).toBeVisible();
  const partial = '# Markdown 验证\n\n**尚未闭合\n\n```javascript\nconst value = "';
  await publish(request, partial);
  let row = markdownRow(page);
  await expect(row.locator('pre')).toContainText('const value = "');
  await expect(row.locator('strong')).toHaveCount(0);
  await page.reload();
  row = markdownRow(page);
  await expect(row.locator('pre')).toContainText('const value = "');
  await publish(request, 'hello";\n```\n\n[未闭合链接](https://example.com/');
  await expect(row.locator('pre')).toContainText('const value = "hello";');
  await context.setOffline(true);
  const final = '# Markdown 验证\n\n**已闭合**\n\n```javascript\nconst value = "hello";\n```';
  await publish(request, final, true);
  await context.setOffline(false);
  await expect(markdownRow(page).locator('strong')).toHaveText('已闭合');
  await expect(markdownRow(page)).toHaveCount(1);
  await page.reload();
  await expect(markdownRow(page)).toHaveCount(1);
  await expect(markdownRow(page).locator('strong')).toHaveText('已闭合');
  expect(errors).toEqual([]);
});

for (const width of [1440, 390, 320]) {
  test(`${width}px 宽表格和代码局部横滚，长链接折行且不撑破页面`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const link = `https://example.com/${'long-path-'.repeat(35)}`;
    const headers = Array.from({ length: 12 }, (_, index) => `列${index}长标题`);
    await publish(request, `# Markdown 验证\n\n<${link}>\n\n| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n| ${headers.map(() => '宽内容').join(' | ')} |\n\n\`\`\`unknown-language\n${'unbroken_code_'.repeat(60)}\n\`\`\``, true);
    await page.goto('/');
    const row = markdownRow(page);
    await expect(row.locator('table')).toBeVisible();
    const sizes = await row.evaluate((node) => {
      const pre = node.querySelector('pre')!;
      const table = node.querySelector('.markdown-table-scroll')!;
      return {
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
        codeOverflow: pre.scrollWidth - pre.clientWidth,
        tableOverflow: table.scrollWidth - table.clientWidth,
        rowWidth: node.getBoundingClientRect().width,
        codeWidth: pre.getBoundingClientRect().width,
      };
    });
    expect(sizes.pageOverflow).toBeLessThanOrEqual(0);
    expect(sizes.bodyOverflow).toBeLessThanOrEqual(0);
    expect(sizes.codeOverflow).toBeGreaterThan(0);
    expect(sizes.tableOverflow).toBeGreaterThan(0);
    expect(sizes.codeWidth).toBeLessThanOrEqual(sizes.rowWidth);
    for (const area of [row.locator('pre'), row.locator('.markdown-table-scroll')]) {
      expect(await area.evaluate((node) => { node.scrollLeft = 100; return node.scrollLeft; })).toBeGreaterThan(0);
    }
    await page.screenshot({ path: testInfo.outputPath(`markdown-${width}.png`), fullPage: true });
  });
}

test('Markdown 高度变化保持底部跟随、上翻暂停和工作面隐藏后恢复', async ({ page, request }) => {
  await page.goto('/');
  const scroll = page.locator('.message-scroll');
  await expect(page.locator('[data-entry-id="entry-072"]')).toBeVisible();
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  const initial = '# Markdown 验证\n\n' + '- 列表内容\n'.repeat(80);
  await publish(request, initial);
  await expect(markdownRow(page)).toHaveCount(1);
  await expect.poll(() => scroll.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeLessThanOrEqual(2);
  await publish(request, '\n```js\n' + 'const value = 1;\n'.repeat(30));
  await expect(markdownRow(page).locator('pre')).toBeVisible();
  await expect.poll(() => scroll.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeLessThanOrEqual(2);
  await scroll.hover();
  await page.mouse.wheel(0, -450);
  await expect.poll(() => scroll.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeGreaterThan(100);
  const readingTop = await scroll.evaluate((element) => element.scrollTop);
  await publish(request, 'console.log(value);\n```\n');
  await expect(markdownRow(page).locator('pre')).toContainText('console.log(value);');
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(readingTop, 0);
  await page.getByRole('button', { name: '当前会话模型' }).click();
  await page.getByRole('button', { name: '管理模型配置' }).click();
  await expect(scroll).toBeHidden();
  await publish(request, '\n**隐藏期间完成**');
  await expect(markdownRow(page).locator('strong')).toHaveText('隐藏期间完成');
  await page.getByRole('button', { name: '返回工作模式' }).first().click();
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(readingTop, 0);
  await expect(markdownRow(page)).toHaveCount(1);
});
