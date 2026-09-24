import { expect, test } from '@playwright/test';
import type { AssistantPublicEvent, AssistantSessionPageResponse } from '@multivac/contracts';
import { fakeApiRoot, resetE2eState } from './test-state.js';

const reportRoot = '.report/in-progress/2026-09-14-dev-156-assistant-turns';

test.beforeEach(async ({ page, request }) => {
  await resetE2eState(request);
  const response = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
  const current = await response.json() as { revision: number };
  await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
    data: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, revision: current.revision },
  });
  await page.goto('/');
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
});

for (const outcome of ['failed', 'cancelled'] as const) {
  for (const terminalHistory of ['persist', 'omit'] as const) {
    test(`浏览器已显示部分正文后${outcome === 'failed' ? '失败' : '取消'}：${terminalHistory}历史校准无重复且刷新不复活旧stream`, async ({ page, request }) => {
      const submitted = outcome === 'failed' ? `失败场景：部分正文-${terminalHistory}` : `取消部分正文-${terminalHistory}`;
      const earliestEntry = await page.locator('article[data-entry-id]').first().getAttribute('data-entry-id');
      let sends = 0;
      page.on('request', (event) => {
        if (event.method() === 'POST' && new URL(event.url()).pathname === '/api/assistant/turns') sends += 1;
      });
      expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm-streaming`, {
        data: { terminalHistory },
      })).ok()).toBe(true);
      const draft = page.getByLabel('Multivac 草稿');
      await draft.fill(submitted);
      await page.getByLabel('发送消息').click();
      expect((await request.get(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`)).ok()).toBe(true);
      const initial = await (await request.get(`${fakeApiRoot}/api/assistant/session`)).json() as AssistantSessionPageResponse;
      expect(initial.streamingMessages).toHaveLength(1);
      const stream = initial.streamingMessages![0]!;
      const row = page.locator('article.chat-row.assistant').filter({ hasText: stream.text });
      // 终态操作之前必须确认浏览器已经呈现正文，而非仅断言事件或服务端快照。
      await expect(row).toHaveCount(1);
      await expect(row.locator('p')).toHaveText(stream.text);
      expect(await row.getAttribute('data-entry-id')).toBeNull();
      if (outcome === 'cancelled') await page.getByRole('button', { name: '取消当前处理' }).click();
      expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
      await expect(page.getByRole('status').getByText(outcome === 'failed' ? '处理失败' : '处理已取消', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '取消当前处理' })).toHaveCount(0);
      await expect(draft).toHaveValue(submitted);
      const final = await (await request.get(`${fakeApiRoot}/api/assistant/session?limit=100`)).json() as AssistantSessionPageResponse;
      expect(final.streamingMessages).toEqual([]);
      const canonical = final.messages.filter((message) => message.runtimeMessageId === stream.messageId);
      expect(canonical).toHaveLength(terminalHistory === 'persist' ? 1 : 0);
      if (terminalHistory === 'persist') {
        expect(canonical[0]!.text).not.toBe(stream.text);
        await expect(row).toHaveCount(1);
        await expect(row.locator('p')).toHaveText(canonical[0]!.text);
        await expect(row).toHaveAttribute('data-entry-id', canonical[0]!.piEntryId);
        // 失败与取消的轨迹同样只显示用时，结果状态交给输入区状态条。
        await expect(page.locator('.run-trace').last().locator('summary > span')).toHaveText(/^用时 \d+ 秒$/);
      } else await expect(row).toHaveCount(0);
      const expected = final.messages.slice(final.messages.findIndex((message) => message.piEntryId === earliestEntry))
        .map((message) => message.text);
      await expect(page.locator('article.chat-row p')).toHaveText(expected);
      await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/assistant/page-state`)).json() as { draft: string }).draft)
        .toBe(submitted);
      await page.reload();
      await expect(draft).toBeEditable();
      await expect(draft).toHaveValue(submitted);
      if (terminalHistory === 'persist') {
        await expect(row).toHaveCount(1);
        await expect(row.locator('p')).toHaveText(canonical[0]!.text);
        await expect(row).toHaveAttribute('data-entry-id', canonical[0]!.piEntryId);
      } else await expect(row).toHaveCount(0);
      const restored = await (await request.get(`${fakeApiRoot}/api/assistant/session?limit=100`)).json() as AssistantSessionPageResponse;
      expect(restored.streamingMessages).toEqual([]);
      expect(restored.messages).toEqual(final.messages);
      expect(sends).toBe(1);
    });
  }
}

test('已显示首条stream后实际followUp产生第二条正文，身份独立、历史顺序一致且刷新不重复', async ({ page, request }) => {
  const earliestEntry = await page.locator('article[data-entry-id]').first().getAttribute('data-entry-id');
  const snapshot = await (await request.get(`${fakeApiRoot}/api/assistant/session`)).json() as AssistantSessionPageResponse;
  await page.evaluate((cursor) => {
    const deltas: unknown[] = [];
    const source = new EventSource(`/api/assistant/events?after=${encodeURIComponent(cursor)}`);
    source.addEventListener('assistant-event', (event) => {
      const value = JSON.parse((event as MessageEvent<string>).data) as { type: string };
      if (value.type === 'assistant.message.delta') deltas.push(value);
    });
    Object.assign(window, { __followUpBodyDeltas: deltas });
  }, snapshot.eventCursor);
  const bodies: { text: string; streamingBehavior?: string }[] = [];
  page.on('request', (event) => {
    if (event.method() === 'POST' && new URL(event.url()).pathname === '/api/assistant/turns') {
      bodies.push(event.postDataJSON() as { text: string; streamingBehavior?: string });
    }
  });
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm-streaming`, {
    data: { simulateFollowUps: true },
  })).ok()).toBe(true);
  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill('实际followUp首条请求');
  await page.getByLabel('发送消息').click();
  expect((await request.get(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`)).ok()).toBe(true);
  const partial = await (await request.get(`${fakeApiRoot}/api/assistant/session`)).json() as AssistantSessionPageResponse;
  await expect(page.locator('article.chat-row.assistant').filter({ hasText: partial.streamingMessages![0]!.text }).locator('p'))
    .toHaveText(partial.streamingMessages![0]!.text);
  await draft.fill('真正执行的后续问题');
  await page.getByRole('button', { name: '完成后继续', exact: true }).click();
  await page.getByLabel('发送消息').click();
  await expect(draft).toHaveValue('');
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toMatchObject({ text: '实际followUp首条请求' });
  expect(bodies[0]?.streamingBehavior).toBeUndefined();
  expect(bodies[1]).toMatchObject({ text: '真正执行的后续问题', streamingBehavior: 'followUp' });
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const state = await (await request.get(`${fakeApiRoot}/api/assistant/session`)).json() as AssistantSessionPageResponse;
    return state.messages.filter((message) => message.runtimeMessageId?.startsWith('assistant:prompt-1')).length;
  }).toBe(2);
  const final = await (await request.get(`${fakeApiRoot}/api/assistant/session?limit=100`)).json() as AssistantSessionPageResponse;
  const replies = final.messages.filter((message) => message.runtimeMessageId?.startsWith('assistant:prompt-1'));
  expect(new Set(replies.map((message) => message.runtimeMessageId)).size).toBe(2);
  expect(final.messages.slice(-4).map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  await expect(page.locator('article.chat-row p')).toHaveText(final.messages
    .slice(final.messages.findIndex((message) => message.piEntryId === earliestEntry)).map((message) => message.text));
  await expect.poll(() => page.evaluate(() => {
    const values = (window as Window & { __followUpBodyDeltas: Extract<AssistantPublicEvent, { type: 'assistant.message.delta' }>[] })
      .__followUpBodyDeltas;
    return [...new Set(values.map((event) => event.data.messageId))];
  })).toEqual(replies.map((message) => message.runtimeMessageId));
  await page.reload();
  for (const reply of replies) {
    const row = page.locator(`article[data-entry-id="${reply.piEntryId}"]`);
    await expect(row).toHaveCount(1);
    await expect(row.locator('p')).toHaveText(reply.text);
  }
  expect(bodies).toHaveLength(2);
});

test('正文流式展示，刷新恢复在途正文并接续，隐藏期间完成后历史校准不重复', async ({ page, request }) => {
  let sends = 0;
  page.on('request', (event) => {
    if (event.method() === 'POST' && event.url().endsWith('/api/assistant/turns')) sends += 1;
  });
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm-streaming`)).ok()).toBe(true);
  await page.getByLabel('Multivac 草稿').fill('流式刷新恢复');
  await page.getByLabel('发送消息').click();
  expect((await request.get(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`)).ok()).toBe(true);
  const partial = 'Fake Multivac 已处理当前消息。'.slice(0, Math.ceil('Fake Multivac 已处理当前消息。'.length / 2));
  const streamingRow = page.locator('article.chat-row.assistant').filter({ hasText: partial });
  await expect(streamingRow).toHaveCount(1);
  await expect(streamingRow.locator('p')).toHaveText(partial);
  await page.reload();
  await expect(streamingRow.locator('p')).toHaveText(partial);
  expect(sends).toBe(1);
  await page.getByRole('button', { name: '打开管理模式' }).click();
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await page.getByRole('button', { name: '返回工作模式' }).first().click();
  await expect(streamingRow).toHaveCount(1);
  await expect(streamingRow.locator('p')).toHaveText('Fake Multivac 已处理当前消息。');
  await page.reload();
  await expect(streamingRow).toHaveCount(1);
  await expect(streamingRow.locator('p')).toHaveText('Fake Multivac 已处理当前消息。');
  expect(sends).toBe(1);
});

test('多消息正文断线 replay 和刷新接续，底部跟随、上翻停止且历史替换无重复', async ({ page, context, request }) => {
  const publish = async (messageId: string, delta: string, completed = false) => {
    const response = await request.post(`${fakeApiRoot}/api/__e2e/assistant/events/body`, {
      data: { messageId, delta, completed },
    });
    expect(response.ok()).toBe(true);
  };
  const rows = page.locator('article.chat-row.assistant');
  const scroll = page.locator('.message-scroll');
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await publish('assistant:e2e:1', '流式第一条');
  await expect(rows.filter({ hasText: '流式第一条' })).toHaveCount(1);
  const longText = '\n流式内容'.repeat(120);
  await publish('assistant:e2e:1', longText);
  await expect.poll(() => scroll.evaluate((element) =>
    element.scrollHeight - element.clientHeight - element.scrollTop,
  )).toBeLessThanOrEqual(2);
  await scroll.hover();
  await page.mouse.wheel(0, -400);
  await expect.poll(() => scroll.evaluate((element) =>
    element.scrollHeight - element.clientHeight - element.scrollTop,
  )).toBeGreaterThan(100);
  const readingTop = await scroll.evaluate((element) => element.scrollTop);
  await publish('assistant:e2e:1', '\n上翻后新增');
  await expect(rows.filter({ hasText: '上翻后新增' })).toHaveCount(1);
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(readingTop, 0);
  await context.setOffline(true);
  await publish('assistant:e2e:2', '第二条断线期间');
  await context.setOffline(false);
  await expect(rows.filter({ hasText: '第二条断线期间' })).toHaveCount(1);
  await page.reload();
  await expect(rows.filter({ hasText: '上翻后新增' })).toHaveCount(1);
  await expect(rows.filter({ hasText: '第二条断线期间' })).toHaveCount(1);
  await publish('assistant:e2e:2', '继续');
  await expect(rows.filter({ hasText: '第二条断线期间继续' })).toHaveCount(1);
  await publish('assistant:e2e:1', '流式第一条最终校准', true);
  await expect(rows.filter({ hasText: '流式第一条' })).toHaveCount(1);
  await expect(rows.filter({ hasText: '流式第一条' }).locator('p')).toHaveText('流式第一条最终校准');
  const tail = await rows.allTextContents();
  expect(tail.findIndex((text) => text.includes('流式第一条最终校准')))
    .toBeLessThan(tail.findIndex((text) => text.includes('第二条断线期间继续')));
});

test('迟到 expired 恢复快照不覆盖普通刷新完成正文，也不回退重订阅 cursor', async ({ page, request }) => {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    let expired = false;
    let streaming: AbortController | undefined;
    Object.assign(window, { __expireAssistantSse() { expired = true; streaming?.abort(); } });
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('/api/assistant/events?')) return original(input, init);
      if (expired) {
        expired = false;
        return new Response(JSON.stringify({ error: {
          code: 'EVENT_CURSOR_EXPIRED', message: '回归测试：cursor expired',
        } }), { status: 409, headers: { 'content-type': 'application/json' } });
      }
      const controller = new AbortController();
      streaming = controller;
      init?.signal?.addEventListener('abort', () => controller.abort(), { once: true });
      return original(input, { ...init, signal: controller.signal });
    };
  });
  await page.reload();
  await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
  let holdState = false;
  let stateHeld = false;
  let releaseState!: () => void;
  const stateGate = new Promise<void>((resolve) => { releaseState = resolve; });
  let holdOrdinary = false;
  let ordinaryHeld = false;
  let releaseOrdinary!: () => void;
  const ordinaryGate = new Promise<void>((resolve) => { releaseOrdinary = resolve; });
  let recoveryCursor: number | undefined;
  let refreshedCursor: number | undefined;
  let released = false;
  const resumedCursors: number[] = [];
  page.on('request', (event) => {
    const url = new URL(event.url());
    if (released && url.pathname === '/api/assistant/events') {
      resumedCursors.push(Number(url.searchParams.get('after')));
    }
  });
  await page.route('**/api/assistant/page-state', async (route) => {
    if (route.request().method() !== 'GET' || !holdState) return route.continue();
    holdState = false;
    const response = await route.fetch();
    stateHeld = true;
    await stateGate;
    await route.fulfill({ response });
  });
  await page.route('**/api/assistant/session?*', async (route) => {
    if (holdOrdinary && !new URL(route.request().url()).searchParams.has('before')) {
      holdOrdinary = false;
      ordinaryHeld = true;
      await ordinaryGate;
    }
    if (!stateHeld && !holdState && recoveryCursor === undefined) return route.continue();
    const response = await route.fetch();
    const body = await response.json() as {
      eventCursor: string; messages: { text: string }[]; streamingMessages?: { text: string }[];
    };
    if (recoveryCursor === undefined && body.streamingMessages?.length) {
      recoveryCursor = Number(body.eventCursor);
    }
    if (body.messages.some((message) => message.text === 'Fake Multivac 已处理当前消息。')) {
      refreshedCursor = Number(body.eventCursor);
    }
    await route.fulfill({ response });
  });
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm-streaming`)).ok()).toBe(true);
  await page.getByLabel('Multivac 草稿').fill('迟到恢复快照回归');
  await page.getByLabel('发送消息').click();
  expect((await request.get(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`)).ok()).toBe(true);
  const row = page.locator('article.chat-row.assistant').filter({ hasText: 'Fake Multiv' });
  await expect(row).toHaveCount(1);
  // 先让一个普通刷新在途，再触发恢复；它将在 page-state 等待期间拿到更高水位。
  holdOrdinary = true;
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/events/body`, {
    data: { messageId: 'assistant:race-refresh', delta: '普通刷新触发消息', completed: true },
  })).ok()).toBe(true);
  await expect.poll(() => ordinaryHeld).toBe(true);
  holdState = true;
  await page.evaluate(() => (window as Window & { __expireAssistantSse: () => void }).__expireAssistantSse());
  await expect.poll(() => stateHeld && recoveryCursor !== undefined).toBe(true);
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect.poll(async () => {
    const response = await request.get(`${fakeApiRoot}/api/assistant/session`);
    const body = await response.json() as { messages: { text: string }[] };
    return body.messages.some((message) => message.text === 'Fake Multivac 已处理当前消息。');
  }, { timeout: 15_000 }).toBe(true);
  releaseOrdinary();
  // 普通刷新应用完成历史，此时恢复仍被 page-state 阻塞。
  await expect(row.locator('p')).toHaveText('Fake Multivac 已处理当前消息。');
  await expect(row).toHaveAttribute('data-entry-id', /^entry-prompt-/);
  await expect.poll(() => refreshedCursor ?? 0).toBeGreaterThan(recoveryCursor!);
  const appliedCursor = refreshedCursor!;
  released = true;
  releaseState();
  await expect.poll(() => resumedCursors.length).toBeGreaterThan(0);
  expect(resumedCursors[0]).toBeGreaterThanOrEqual(appliedCursor);
  await expect(row).toHaveCount(1);
  await expect(row.locator('p')).toHaveText('Fake Multivac 已处理当前消息。');
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '取消当前处理' })).toHaveCount(0);
});

test('40条正文断线 replay 后全部校准且不短暂消失，最早历史仍可继续分页', async ({ page, context, request }) => {
  const publish = async (number: number, completed: boolean) => {
    const response = await request.post(`${fakeApiRoot}/api/__e2e/assistant/events/body`, {
      data: { messageId: `assistant:long-${number}`, delta: `长轮正文${number}${completed ? '完整' : '增量'}`, completed },
    });
    expect(response.ok()).toBe(true);
  };
  const rows = page.locator('article.chat-row.assistant').filter({ hasText: '长轮正文' });
  for (let number = 1; number <= 40; number += 1) await publish(number, false);
  await expect(rows).toHaveCount(40);
  await page.evaluate(() => {
    let minimum = 40;
    new MutationObserver(() => {
      minimum = Math.min(minimum, [...document.querySelectorAll('article.chat-row.assistant p')]
        .filter((element) => element.textContent?.startsWith('长轮正文')).length);
      Object.assign(window, { __minimumLongBodyCount: minimum });
    }).observe(document.querySelector('.message-stream')!, { childList: true, subtree: true, characterData: true });
  });
  await context.setOffline(true);
  for (let number = 1; number <= 40; number += 1) await publish(number, true);
  await context.setOffline(false);
  await expect(rows.locator('p')).toHaveText(Array.from({ length: 40 }, (_, index) => `长轮正文${index + 1}完整`));
  expect(await page.evaluate(() =>
    (window as Window & { __minimumLongBodyCount?: number }).__minimumLongBodyCount ?? 40,
  )).toBe(40);
  await expect(rows).toHaveCount(40);
  await expect(page.locator('[data-entry-id="entry-043"]')).toHaveCount(1);
  const beforeRequests: string[] = [];
  page.on('request', (event) => {
    const before = new URL(event.url()).searchParams.get('before');
    if (before) beforeRequests.push(before);
  });
  await page.getByRole('button', { name: '加载更早消息' }).click();
  await expect(page.locator('[data-entry-id="entry-013"]')).toHaveCount(1);
  expect(beforeRequests).toContain('entry-043');
  await expect(rows.locator('p')).toHaveText(Array.from({ length: 40 }, (_, index) => `长轮正文${index + 1}完整`));
});

test('成功结算时只滚动阅读区仍清空草稿并保留会话消息', async ({ page, request }) => {
  const submittedText = '只滚动阅读区后成功清空的正文';
  const draft = page.getByLabel('Multivac 草稿');
  const send = page.getByLabel('发送消息');
  const submittedMessage = page.locator('article.chat-row.user').filter({ hasText: submittedText });
  const previousMessageCount = await submittedMessage.count();
  const turnBodies: { text: string }[] = [];
  await page.route('**/api/assistant/turns', async (route) => {
    turnBodies.push(route.request().postDataJSON() as { text: string });
    await route.continue();
  });
  expect(await draft.evaluate((element) => getComputedStyle(element).resize)).toBe('none');
  await expect(send.locator('svg.lucide-arrow-right')).toHaveCount(1);

  await draft.fill(submittedText);
  await expect.poll(async () => {
    const response = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
    return (await response.json() as { draft: string }).draft;
  }).toBe(submittedText);
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);
  const submittedVersion = await page.evaluate(() => sessionStorage.getItem('multivac.assistant.draft-version'));
  await send.click();

  const scroll = page.locator('.message-scroll');
  await scroll.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
  await expect.poll(async () => {
    const response = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
    return (await response.json() as { anchorEntryId: string | null }).anchorEntryId;
  }).not.toBeNull();
  const beforeTerminal = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
  await expect(beforeTerminal.json()).resolves.toMatchObject({ draft: '' });
  await expect(draft).toHaveValue('');
  expect(turnBodies).toHaveLength(1);
  expect(turnBodies[0]).toMatchObject({ text: submittedText });
  expect(Number(await page.evaluate(() => sessionStorage.getItem('multivac.assistant.draft-version'))))
    .toBeGreaterThan(Number(submittedVersion));
  expect(await page.evaluate(() => JSON.parse(
    sessionStorage.getItem('multivac.assistant.pending-command')!,
  ) as { text: string; cleared: boolean })).toMatchObject({ text: submittedText, cleared: true });
  expect((await request.get(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`)).ok()).toBe(true);

  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue('');
  await expect.poll(async () => {
    const response = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
    return (await response.json() as { draft: string }).draft;
  }).toBe('');
  await expect(submittedMessage).toHaveCount(previousMessageCount + 1);
});

test('发送后跳到最新消息，主动上翻后不再自动跟随', async ({ page, request }) => {
  const scroll = page.locator('.message-scroll');
  await scroll.hover();
  await page.mouse.wheel(0, -5000);
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(2);

  await page.getByLabel('Multivac 草稿').fill('滚动到新发送的消息');
  await page.getByLabel('发送消息').click();
  await expect.poll(() => scroll.evaluate((element) =>
    element.scrollHeight - element.clientHeight - element.scrollTop
  )).toBeLessThanOrEqual(2);
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(page.locator('article.chat-row.user').filter({ hasText: '滚动到新发送的消息' })).toHaveCount(1);
  await expect.poll(() => scroll.evaluate((element) =>
    element.scrollHeight - element.clientHeight - element.scrollTop
  )).toBeLessThanOrEqual(2);

  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);
  await page.getByLabel('Multivac 草稿').fill('主动上翻后收到的消息');
  await page.getByLabel('发送消息').click();
  await expect.poll(() => scroll.evaluate((element) =>
    element.scrollHeight - element.clientHeight - element.scrollTop
  )).toBeLessThanOrEqual(2);
  await scroll.hover();
  await page.mouse.wheel(0, -5000);
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(2);
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(page.locator('article.chat-row.user').filter({ hasText: '主动上翻后收到的消息' })).toHaveCount(1);
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(2);
});

test('提交期间实际编辑的新草稿在成功终态后仍保留', async ({ page, request }) => {
  const submittedText = '提交期间会继续编辑的正文';
  const newerDraft = '用户提交期间输入的新正文';
  const draft = page.getByLabel('Multivac 草稿');
  const submittedMessage = page.locator('article.chat-row.user').filter({ hasText: submittedText });
  const previousMessageCount = await submittedMessage.count();
  await draft.fill(submittedText);
  await expect.poll(async () => {
    const response = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
    return (await response.json() as { draft: string }).draft;
  }).toBe(submittedText);
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);
  await draft.press('Enter');
  expect((await request.get(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`)).ok()).toBe(true);
  await expect(draft).toHaveValue('');
  await expect.poll(async () => {
    const response = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
    return (await response.json() as { draft: string }).draft;
  }).toBe('');
  await draft.fill(newerDraft);
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue(newerDraft);
  await expect.poll(async () => {
    const response = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
    return (await response.json() as { draft: string }).draft;
  }).toBe(newerDraft);
  await expect(submittedMessage).toHaveCount(previousMessageCount + 1);
});

test('运行中清空的正文在已知失败后恢复，远端也恢复原草稿', async ({ page, request }) => {
  const submittedText = '工具失败后最终失败：运行中先清空再恢复正文';
  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill(submittedText);
  await expect.poll(async () => {
    const response = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
    return (await response.json() as { draft: string }).draft;
  }).toBe(submittedText);
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);
  await draft.press('Enter');
  expect((await request.get(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`)).ok()).toBe(true);
  await expect(draft).toHaveValue('');
  await expect.poll(async () => {
    const response = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
    return (await response.json() as { draft: string }).draft;
  }).toBe('');
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(page.getByRole('status').getByText('处理失败', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue(submittedText);
  await expect.poll(async () => {
    const response = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
    return (await response.json() as { draft: string }).draft;
  }).toBe(submittedText);
});

test('运行中取消恢复旧正文，但失败前的新编辑不会被旧正文覆盖', async ({ page, request }) => {
  const draft = page.getByLabel('Multivac 草稿');
  const cancelledText = '运行中取消应恢复的正文';
  await draft.fill(cancelledText);
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);
  await draft.press('Enter');
  expect((await request.get(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`)).ok()).toBe(true);
  await expect(draft).toHaveValue('');
  await page.getByRole('button', { name: '取消当前处理' }).click();
  await expect(page.getByText('处理已取消', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue(cancelledText);
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect.poll(async () => {
    const response = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
    return (await response.json() as { draft: string }).draft;
  }).toBe(cancelledText);

  const failedText = '工具失败后最终失败：运行中编辑新草稿';
  const newerDraft = '失败前输入的全新正文';
  await draft.fill(failedText);
  await expect.poll(async () => {
    const response = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
    return (await response.json() as { draft: string }).draft;
  }).toBe(failedText);
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);
  await draft.press('Enter');
  expect((await request.get(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`)).ok()).toBe(true);
  await expect(draft).toHaveValue('');
  await draft.fill(newerDraft);
  await expect.poll(async () => {
    const response = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
    return (await response.json() as { draft: string }).draft;
  }).toBe(newerDraft);
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(page.getByRole('status').getByText('处理失败', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue(newerDraft);
  const remote = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
  await expect(remote.json()).resolves.toMatchObject({ draft: newerDraft });
});

test('composer 支持 Enter、Shift+Enter、IME 229 且提交中防重复', async ({ page }) => {
  let sends = 0;
  await page.route('**/api/assistant/turns', async (route) => {
    sends += 1;
    await route.continue();
  });
  const draft = page.getByLabel('Multivac 草稿');
  const send = page.getByLabel('发送消息');
  await expect(send).toBeDisabled();

  await draft.fill('第一行');
  await draft.press('Shift+Enter');
  await expect(draft).toHaveValue('第一行\n');
  await draft.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', keyCode: 229, isComposing: true, bubbles: true,
    }));
  });
  await page.waitForTimeout(50);
  expect(sends).toBe(0);

  await draft.fill('只发送一次');
  await send.evaluate((button) => {
    button.click();
    button.click();
  });
  await expect(page.locator('.run-status').getByText('处理完成', { exact: true })).toBeVisible();
  expect(sends).toBe(1);
  await expect(draft).toHaveValue('');
});

test('已知失败保留草稿，显式重试使用新 commandId 并成功清空', async ({ page }) => {
  const commandIds: string[] = [];
  await page.route('**/api/assistant/turns', async (route) => {
    commandIds.push((route.request().postDataJSON() as { commandId: string }).commandId);
    await route.continue();
  });
  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill('失败场景：保留草稿并重试');
  await draft.press('Enter');

  await expect(page.getByRole('status').getByText('处理失败', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue('失败场景：保留草稿并重试');
  await page.getByRole('button', { name: '重试发送' }).click();
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue('');
  expect(commandIds).toHaveLength(2);
  expect(commandIds[0]).not.toBe(commandIds[1]);
});

test('POST 响应丢失后按原 commandId 展示五态并跨离页恢复，最终保护新草稿', async ({ page, request }) => {
  const submittedText = '响应丢失后持续对账的正文';
  let commandId = '';
  let browserPosts = 0;
  let submittedBody: Record<string, unknown> | undefined;
  let serverRequest: ReturnType<typeof request.post> | undefined;
  await page.route('**/api/assistant/turns', async (route) => {
    browserPosts += 1;
    const body = route.request().postDataJSON() as { commandId: string };
    commandId = body.commandId;
    submittedBody = body;
    await route.abort('failed');
  });

  let reconciliationStatus: 'unknown' | 'accepted' | 'handed_to_pi' | 'running' | 'terminal' = 'unknown';
  const queriedCommandIds: string[] = [];
  await page.route('**/api/assistant/commands/*', async (route) => {
    const current = reconciliationStatus;
    queriedCommandIds.push(decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!));
    const terminal = current === 'terminal';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        commandId,
        status: current,
        receipt: current === 'unknown' ? null : {
          commandId,
          assistantSessionId: 'global-coordinator',
          kind: 'send',
          status: current,
          terminalOutcome: terminal ? 'succeeded' : null,
          error: null,
          piSessionId: 'pi-fake-global-coordinator',
          piEntryId: terminal ? 'entry-prompt-reconciled-assistant' : null,
          piTurnRef: current === 'running' ? 'turn-reconciled' : null,
          createdAt: '2026-09-14T08:00:00.000Z',
          updatedAt: '2026-09-14T08:00:00.000Z',
        },
      }),
    });
  });

  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill(submittedText);
  await draft.press('Enter');
  await expect(page.getByText('正在确认消息是否已接受')).toBeVisible();
  reconciliationStatus = 'accepted';
  await expect(page.getByText('消息已接受')).toBeVisible();
  reconciliationStatus = 'handed_to_pi';
  await expect(page.getByText('消息已交给 Pi')).toBeVisible();

  await page.goto('about:blank');
  await page.goBack();
  await expect(page.getByLabel('Multivac 草稿')).toHaveValue(submittedText);
  await expect(page.getByText('消息已交给 Pi')).toBeVisible();
  reconciliationStatus = 'running';
  await expect(page.getByText('Multivac 正在处理')).toBeVisible();
  await page.getByLabel('Multivac 草稿').fill('用户在对账期间输入的新草稿');
  await page.goto('about:blank');
  await page.goBack();
  await expect(page.getByText('Multivac 正在处理')).toBeVisible();
  expect(submittedBody).toBeDefined();
  serverRequest = request.post(`${fakeApiRoot}/api/assistant/turns`, {
    data: submittedBody!,
  });
  reconciliationStatus = 'terminal';
  expect((await serverRequest).ok()).toBe(true);
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Multivac 草稿')).toHaveValue('用户在对账期间输入的新草稿');

  expect(browserPosts).toBe(1);
  expect(new Set(queriedCommandIds)).toEqual(new Set([commandId]));
});

test('持续 unknown 不占用 active prompt，reload 后按原 commandId 和 payload 重试', async ({ page }) => {
  await page.clock.install();
  const submittedText = '首次 POST 未进入服务端的原命令';
  const browserBodies: Record<string, unknown>[] = [];
  let allowDispatch = false;
  await page.route('**/api/assistant/turns', async (route) => {
    browserBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    if (allowDispatch) return route.continue();
    return route.abort('failed');
  });
  await page.route('**/api/assistant/commands/*', async (route) => {
    if (allowDispatch) return route.continue();
    const commandId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ commandId, status: 'unknown', receipt: null }),
    });
  });

  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill(submittedText);
  await draft.press('Enter');
  await expect(page.getByText('正在确认消息是否已接受')).toBeVisible();
  await page.clock.runFor(13_000);
  await expect(page.getByText('发送结果未知', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '按原命令重试' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '取消当前处理' })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('multivac.assistant.active-prompt-command'))).toBeNull();

  const firstPending = await page.evaluate(() => JSON.parse(
    sessionStorage.getItem('multivac.assistant.pending-command')!,
  ) as Record<string, unknown>);
  expect(firstPending).toMatchObject({
    commandId: browserBodies[0]!.commandId,
    text: submittedText,
    streamingBehavior: null,
    unknown: true,
  });
  expect(firstPending.draftVersion).toEqual(expect.any(Number));
  expect(firstPending.generation).toEqual(expect.any(Number));

  await page.reload();
  await expect(page.getByLabel('Multivac 草稿')).toHaveValue(submittedText);
  await expect(page.getByText('正在确认消息是否已接受')).toBeVisible();
  await page.clock.runFor(13_000);
  await expect(page.getByText('发送结果未知', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '按原命令重试' })).toBeEnabled();
  expect(await page.evaluate(() => sessionStorage.getItem('multivac.assistant.active-prompt-command'))).toBeNull();

  allowDispatch = true;
  await page.getByRole('button', { name: '按原命令重试' }).click();
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue('');
  expect(browserBodies).toHaveLength(2);
  expect(browserBodies[1]).toEqual(browserBodies[0]);
  await expect(page.locator('article.chat-row.user').filter({ hasText: submittedText })).toHaveCount(1);
});

test('legacy pending 对象按原 ID 重试后经 revision conflict 清空远端草稿', async ({ page, request }) => {
  await page.clock.install();
  const commandId = 'legacy-pending-object-command';
  const submittedText = 'legacy 对象恢复的待发送正文';
  const browserBodies: Record<string, unknown>[] = [];
  let allowDispatch = false;
  let emptySaveAttempts = 0;
  let injectConflict = true;

  await page.route('**/api/assistant/commands/*', async (route) => {
    if (allowDispatch) return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ commandId, status: 'unknown', receipt: null }),
    });
  });
  await page.route('**/api/assistant/turns', async (route) => {
    browserBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    if (allowDispatch) return route.continue();
    return route.abort('failed');
  });
  await page.route('**/api/assistant/page-state', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    const body = route.request().postDataJSON() as { draft?: string };
    if (body.draft !== '') return route.continue();
    emptySaveAttempts += 1;
    if (!injectConflict) return route.continue();
    injectConflict = false;
    const currentResponse = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
    const current = await currentResponse.json() as {
      draft: string;
      anchorEntryId: string | null;
      anchorOffsetPx: number;
      revision: number;
    };
    await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
      data: { ...current, anchorOffsetPx: current.anchorOffsetPx + 1 },
    });
    return route.continue();
  });

  await page.evaluate(({ id, text }) => {
    sessionStorage.setItem('multivac.assistant.pending-command', JSON.stringify({
      commandId: id,
      text,
      unknown: true,
    }));
  }, { id: commandId, text: submittedText });
  await page.reload();

  const draft = page.getByLabel('Multivac 草稿');
  await expect(draft).toHaveValue(submittedText);
  await page.clock.runFor(13_000);
  await expect(page.getByRole('button', { name: '按原命令重试' })).toBeEnabled();

  allowDispatch = true;
  await page.getByRole('button', { name: '按原命令重试' }).click();
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue('');
  await expect.poll(async () => {
    const response = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
    return (await response.json() as { draft: string }).draft;
  }).toBe('');
  expect(emptySaveAttempts).toBeGreaterThanOrEqual(2);
  expect(browserBodies).toEqual([{
    commandId,
    assistantSessionId: 'global-coordinator',
    text: submittedText,
    contextRefs: [],
  }]);
  expect(await page.evaluate(() => sessionStorage.getItem('multivac.assistant.pending-command'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('multivac.assistant.active-prompt-command'))).toBeNull();
});

test('legacy pending 裸 ID 从远端草稿恢复 payload，成功前编辑不会被清空', async ({ page, request }) => {
  await page.clock.install();
  const commandId = 'legacy-bare-pending-command';
  const submittedText = '裸 ID 可从 page-state 恢复的正文';
  const editedText = '用户在 legacy 重试成功前继续编辑的新草稿';
  const currentResponse = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
  const current = await currentResponse.json() as { revision: number };
  await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
    data: { draft: submittedText, anchorEntryId: null, anchorOffsetPx: 0, revision: current.revision },
  });

  let allowDispatch = false;
  let submittedBody: Record<string, unknown> | null = null;
  await page.route('**/api/assistant/commands/*', async (route) => {
    if (allowDispatch) return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ commandId, status: 'unknown', receipt: null }),
    });
  });
  await page.route('**/api/assistant/turns', async (route) => {
    submittedBody = route.request().postDataJSON() as Record<string, unknown>;
    return route.continue();
  });

  await page.evaluate((id) => {
    sessionStorage.setItem('multivac.assistant.pending-command', id);
  }, commandId);
  await page.reload();

  const draft = page.getByLabel('Multivac 草稿');
  await expect(draft).toHaveValue(submittedText);
  await page.clock.runFor(13_000);
  await expect(page.getByRole('button', { name: '按原命令重试' })).toBeEnabled();

  allowDispatch = true;
  await page.getByRole('button', { name: '按原命令重试' }).click();
  await expect(page.getByText('Multivac 正在处理')).toBeVisible();
  await draft.fill(editedText);
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue(editedText);
  await expect.poll(async () => {
    const response = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
    return (await response.json() as { draft: string }).draft;
  }).toBe(editedText);
  expect(submittedBody).toEqual({
    commandId,
    assistantSessionId: 'global-coordinator',
    text: submittedText,
    contextRefs: [],
  });
  expect(await page.evaluate(() => sessionStorage.getItem('multivac.assistant.pending-command'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('multivac.assistant.active-prompt-command'))).toBeNull();
});

test('legacy pending 裸 ID 无法恢复 payload 时清理且不可重试', async ({ page }) => {
  const commandId = 'legacy-bare-pending-without-payload';
  let commandQueries = 0;
  await page.route('**/api/assistant/commands/*', async (route) => {
    commandQueries += 1;
    return route.continue();
  });
  await page.evaluate((id) => {
    sessionStorage.setItem('multivac.assistant.pending-command', id);
  }, commandId);

  await page.reload();

  await expect(page.getByLabel('Multivac 草稿')).toHaveValue('');
  await expect(page.getByText('旧命令缺少可恢复的正文，已清理待重试记录。')).toBeVisible();
  await expect(page.getByRole('button', { name: '按原命令重试' })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('multivac.assistant.pending-command'))).toBeNull();
  expect(commandQueries).toBe(0);
});

test('运行中清空遇到 page-state conflict 时命令成功不覆盖远端新草稿', async ({ page, request }) => {
  const submittedText = '页面 A 已提交但尚未结算的旧草稿';
  const remoteDraft = '页面 B 在冲突后保留的新草稿';
  let releaseClearSave!: () => void;
  let markClearSaveEntered!: () => void;
  const clearSaveGate = new Promise<void>((resolve) => { releaseClearSave = resolve; });
  const clearSaveEntered = new Promise<void>((resolve) => { markClearSaveEntered = resolve; });
  let blockedClearSave = false;
  let emptySaveAttempts = 0;
  let turnPosts = 0;
  let commandId = '';

  await page.route('**/api/assistant/page-state', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    const body = route.request().postDataJSON() as { draft?: string };
    if (body.draft !== '') return route.continue();
    emptySaveAttempts += 1;
    if (blockedClearSave) return route.continue();
    blockedClearSave = true;
    markClearSaveEntered();
    await clearSaveGate;
    return route.continue();
  });
  await page.route('**/api/assistant/turns', async (route) => {
    turnPosts += 1;
    commandId = (route.request().postDataJSON() as { commandId: string }).commandId;
    await route.continue();
  });
  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill(submittedText);
  await expect.poll(async () => {
    const response = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
    return (await response.json() as { draft: string }).draft;
  }).toBe(submittedText);
  expect((await request.post(
    `${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`,
  )).ok()).toBe(true);
  await draft.press('Enter');
  expect((await request.get(
    `${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`,
  )).ok()).toBe(true);
  await clearSaveEntered;
  await expect(draft).toHaveValue('');
  const currentResponse = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
  const current = await currentResponse.json() as { draft: string; revision: number };
  expect(current.draft).toBe(submittedText);
  expect((await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
    data: { draft: remoteDraft, anchorEntryId: null, anchorOffsetPx: 0, revision: current.revision },
  })).ok()).toBe(true);
  releaseClearSave();

  await expect(page.getByText('其他页面更新了保存版本；当前草稿已保留，请重试保存。')).toBeVisible();
  expect((await request.post(
    `${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`,
  )).ok()).toBe(true);

  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue('');
  expect(emptySaveAttempts).toBe(1);
  expect(turnPosts).toBe(1);
  expect(await page.evaluate(() => sessionStorage.getItem('multivac.assistant.pending-command'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('multivac.assistant.active-prompt-command'))).toBeNull();
  const commandResponse = await request.get(
    `${fakeApiRoot}/api/assistant/commands/${encodeURIComponent(commandId)}`,
  );
  await expect(commandResponse.json()).resolves.toMatchObject({
    status: 'terminal',
    receipt: { terminalOutcome: 'succeeded' },
  });
  const remoteResponse = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
  await expect(remoteResponse.json()).resolves.toMatchObject({ draft: remoteDraft });

  await page.reload();
  await expect(page.getByLabel('Multivac 草稿')).toHaveValue(remoteDraft);
  expect(turnPosts).toBe(1);
});

test('结算清空首次 409 补读到不同远端草稿时禁止重试覆盖', async ({ page, request }) => {
  const submittedText = '页面 A 已保存并发送的旧草稿';
  const remoteDraft = '页面 B 抢先写入的结算中新草稿';
  let emptySaveAttempts = 0;
  let injectedConflict = false;
  let turnPosts = 0;
  let commandId = '';

  await page.route('**/api/assistant/page-state', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    const body = route.request().postDataJSON() as { draft?: string };
    if (body.draft !== '') return route.continue();
    emptySaveAttempts += 1;
    if (injectedConflict) return route.continue();
    injectedConflict = true;
    const currentResponse = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
    const current = await currentResponse.json() as {
      anchorEntryId: string | null;
      anchorOffsetPx: number;
      revision: number;
    };
    expect((await request.put(`${fakeApiRoot}/api/assistant/page-state`, {
      data: { ...current, draft: remoteDraft },
    })).ok()).toBe(true);
    return route.continue();
  });
  await page.route('**/api/assistant/turns', async (route) => {
    turnPosts += 1;
    commandId = (route.request().postDataJSON() as { commandId: string }).commandId;
    await route.continue();
  });

  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill(submittedText);
  await expect.poll(async () => {
    const response = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
    return (await response.json() as { draft: string }).draft;
  }).toBe(submittedText);
  const clearConflictResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/assistant/page-state') &&
    response.request().method() === 'PUT' && response.status() === 409,
  );
  expect((await request.post(
    `${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`,
  )).ok()).toBe(true);
  await draft.press('Enter');
  expect((await request.get(
    `${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`,
  )).ok()).toBe(true);
  await clearConflictResponse;
  expect(injectedConflict).toBe(true);
  await expect(draft).toHaveValue('');
  await expect(page.getByText('其他页面更新了保存版本；当前草稿已保留，请重试保存。')).toBeVisible();
  const beforeTerminal = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
  await expect(beforeTerminal.json()).resolves.toMatchObject({ draft: remoteDraft });
  expect((await request.post(
    `${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`,
  )).ok()).toBe(true);

  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  expect(emptySaveAttempts).toBe(1);
  expect(turnPosts).toBe(1);
  expect(await page.evaluate(() => sessionStorage.getItem('multivac.assistant.pending-command'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('multivac.assistant.active-prompt-command'))).toBeNull();
  const commandResponse = await request.get(
    `${fakeApiRoot}/api/assistant/commands/${encodeURIComponent(commandId)}`,
  );
  await expect(commandResponse.json()).resolves.toMatchObject({
    status: 'terminal',
    receipt: { terminalOutcome: 'succeeded' },
  });
  const remoteResponse = await request.get(`${fakeApiRoot}/api/assistant/page-state`);
  await expect(remoteResponse.json()).resolves.toMatchObject({ draft: remoteDraft });
  await expect(page.getByText('其他页面更新了保存版本；当前草稿已保留，请重试保存。')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Multivac 草稿')).toHaveValue(remoteDraft);
  expect(turnPosts).toBe(1);
});

test('迟到旧 POST terminal 回执不覆盖较新 active prompt、pending 草稿和行为选择', async ({ page, request }) => {
  let releaseOldResponse!: () => void;
  const oldResponseBarrier = new Promise<void>((resolve) => {
    releaseOldResponse = resolve;
  });
  const commandIds = new Map<string, string>();
  await page.route('**/api/assistant/turns', async (route) => {
    const body = route.request().postDataJSON() as { commandId: string; text: string };
    commandIds.set(body.text, body.commandId);
    if (body.text !== '迟到 POST 的旧命令 A') return route.continue();
    const response = await route.fetch();
    await oldResponseBarrier;
    await route.fulfill({ response });
  });

  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill('迟到 POST 的旧命令 A');
  await draft.press('Enter');
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();

  expect((await request.post(
    `${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`,
  )).ok()).toBe(true);
  await draft.fill('较新的运行命令 B');
  await draft.press('Enter');
  expect((await request.get(
    `${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`,
  )).ok()).toBe(true);
  await expect(page.getByText('Multivac 正在处理')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const value = sessionStorage.getItem('multivac.assistant.active-prompt-command');
    return value ? (JSON.parse(value) as { commandId: string }).commandId : null;
  })).toBe(commandIds.get('较新的运行命令 B'));
  await page.getByRole('button', { name: '立即调整' }).click();
  await expect(page.getByRole('button', { name: '立即调整' })).toHaveAttribute('aria-pressed', 'true');

  releaseOldResponse();
  await page.waitForTimeout(100);
  await expect(page.getByRole('button', { name: '取消当前处理' })).toBeVisible();
  await expect(page.getByText('运行中发送方式')).toBeVisible();
  await expect(page.getByRole('button', { name: '立即调整' })).toHaveAttribute('aria-pressed', 'true');
  await expect(draft).toHaveValue('');
  expect(await page.evaluate(() => {
    const value = sessionStorage.getItem('multivac.assistant.active-prompt-command');
    return value ? (JSON.parse(value) as { commandId: string }).commandId : null;
  })).toBe(commandIds.get('较新的运行命令 B'));
  expect(await page.evaluate(() => {
    const value = sessionStorage.getItem('multivac.assistant.pending-command');
    return value ? JSON.parse(value) as { commandId: string; text: string; cleared: boolean } : null;
  })).toMatchObject({
    commandId: commandIds.get('较新的运行命令 B'), text: '较新的运行命令 B', cleared: true,
  });
  expect((await request.post(
    `${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`,
  )).ok()).toBe(true);
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
});

test('迟到旧 GET failed 回执不清除较新 active prompt 或写入旧错误', async ({ page, request }) => {
  let releaseOldQueries!: () => void;
  const oldQueryBarrier = new Promise<void>((resolve) => {
    releaseOldQueries = resolve;
  });
  let oldCommandId = '';
  let newCommandId = '';
  let oldServerRequest: ReturnType<typeof request.post> | undefined;
  await page.route('**/api/assistant/turns', async (route) => {
    const body = route.request().postDataJSON() as { commandId: string; text: string };
    if (body.text === '迟到 GET 的旧命令 A') {
      oldCommandId = body.commandId;
      oldServerRequest = request.post(`${fakeApiRoot}/api/assistant/turns`, { data: body });
      return route.abort('failed');
    }
    newCommandId = body.commandId;
    return route.continue();
  });
  await page.route('**/api/assistant/commands/*', async (route) => {
    const commandId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    if (commandId !== oldCommandId) return route.continue();
    await oldServerRequest;
    await oldQueryBarrier;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        commandId,
        status: 'terminal',
        receipt: {
          commandId,
          assistantSessionId: 'global-coordinator',
          kind: 'send',
          status: 'terminal',
          terminalOutcome: 'failed',
          error: { code: 'OLD_COMMAND_FAILED', message: '旧命令迟到失败' },
          piSessionId: 'pi-fake-global-coordinator',
          piEntryId: null,
          piTurnRef: null,
          createdAt: '2026-09-14T08:00:00.000Z',
          updatedAt: '2026-09-14T08:00:01.000Z',
        },
      }),
    });
  });

  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill('迟到 GET 的旧命令 A');
  await draft.press('Enter');
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();

  expect((await request.post(
    `${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`,
  )).ok()).toBe(true);
  await draft.fill('GET 交错后的新命令 B');
  await draft.press('Enter');
  expect((await request.get(
    `${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`,
  )).ok()).toBe(true);
  await expect(page.getByText('Multivac 正在处理')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const value = sessionStorage.getItem('multivac.assistant.active-prompt-command');
    return value ? (JSON.parse(value) as { commandId: string }).commandId : null;
  })).toBe(newCommandId);
  await page.getByRole('button', { name: '完成后继续' }).click();
  await expect(page.getByRole('button', { name: '完成后继续' })).toHaveAttribute('aria-pressed', 'true');

  releaseOldQueries();
  await page.waitForTimeout(100);
  await expect(page.getByText('旧命令迟到失败')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '取消当前处理' })).toBeVisible();
  await expect(page.getByText('运行中发送方式')).toBeVisible();
  await expect(page.getByRole('button', { name: '完成后继续' })).toHaveAttribute('aria-pressed', 'true');
  await expect(draft).toHaveValue('');
  expect(await page.evaluate(() => {
    const value = sessionStorage.getItem('multivac.assistant.active-prompt-command');
    return value ? (JSON.parse(value) as { commandId: string }).commandId : null;
  })).toBe(newCommandId);
  expect(await page.evaluate(() => {
    const value = sessionStorage.getItem('multivac.assistant.pending-command');
    return value ? JSON.parse(value) as { commandId: string; text: string; cleared: boolean } : null;
  })).toMatchObject({ commandId: newCommandId, text: 'GET 交错后的新命令 B', cleared: true });
  expect((await request.post(
    `${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`,
  )).ok()).toBe(true);
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
});

test('运行中必须明确选择 steer 或 followUp，且 terminal 后取消保持原终态', async ({ page, request }) => {
  expect((await request.post(
    `${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`,
  )).ok()).toBe(true);
  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill('启动一个可调整的慢任务');
  await draft.press('Enter');
  expect((await request.get(
    `${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`,
  )).ok()).toBe(true);
  await expect(page.getByText('Multivac 正在处理')).toBeVisible();

  await draft.fill('立即改变当前关注点');
  await expect(page.getByLabel('发送消息')).toBeDisabled();
  await page.getByRole('button', { name: '立即调整' }).click();
  await expect(page.getByLabel('发送消息')).toBeEnabled();
  await page.getByLabel('发送消息').click();
  await expect(draft).toHaveValue('');

  await page.reload();
  await expect(page.getByText('运行中发送方式')).toBeVisible();
  await expect(page.getByRole('button', { name: '取消当前处理' })).toBeVisible();

  await page.getByRole('button', { name: '取消当前处理' }).click();
  await expect(page.getByText('处理已取消')).toBeVisible();
  await expect(page.getByText('取消中')).toHaveCount(0);
  expect((await request.post(
    `${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`,
  )).ok()).toBe(true);

  const armBarrier = await request.post(
    `${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`,
  );
  expect(armBarrier.ok()).toBe(true);
  await draft.fill('正常完成后不再接受取消');
  await draft.press('Enter');
  const enteredBarrier = await request.get(
    `${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`,
  );
  expect(enteredBarrier.ok()).toBe(true);
  await expect(page.getByText('Multivac 正在处理', { exact: true })).toBeVisible();
  const releaseBarrier = await request.post(
    `${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`,
  );
  expect(releaseBarrier.ok()).toBe(true);
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  const lateCancel = await request.post(
    `${fakeApiRoot}/api/assistant/turns/current/cancel`,
    {
      data: {
        commandId: 'e2e-terminal-late-cancel',
        assistantSessionId: 'global-coordinator',
      },
    },
  );
  expect(lateCancel.status()).toBe(422);
  expect((await lateCancel.json()).error.code).toBe('COMMAND_STATE_MISMATCH');
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(page.getByText('处理已取消')).toHaveCount(0);
});

test('旧 SSE terminal 不清除较新 generation，且仍刷新消息 snapshot', async ({ page, request }) => {
  const commandIds = new Map<string, string>();
  await page.route('**/api/assistant/turns', async (route) => {
    const body = route.request().postDataJSON() as { commandId: string; text: string };
    commandIds.set(body.text, body.commandId);
    await route.continue();
  });

  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill('旧 SSE terminal 的命令 A');
  await draft.press('Enter');
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  const oldGeneration = Number(await page.evaluate(() =>
    sessionStorage.getItem('multivac.assistant.command-generation'),
  ));

  expect((await request.post(
    `${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`,
  )).ok()).toBe(true);
  await draft.fill('受保护的新命令 B');
  await draft.press('Enter');
  expect((await request.get(
    `${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`,
  )).ok()).toBe(true);
  await expect(page.getByText('Multivac 正在处理', { exact: true })).toBeVisible();
  await draft.fill('B 运行期间输入的新草稿 C');

  const before = await page.evaluate(() => ({
    active: sessionStorage.getItem('multivac.assistant.active-prompt-command'),
    pending: sessionStorage.getItem('multivac.assistant.pending-command'),
    generation: sessionStorage.getItem('multivac.assistant.command-generation'),
  }));
  const active = JSON.parse(before.active!) as { commandId: string; generation: number };
  const pending = JSON.parse(before.pending!) as { commandId: string; generation: number };
  expect(active.commandId).toBe(commandIds.get('受保护的新命令 B'));
  expect(pending.commandId).toBe(active.commandId);
  expect(active.generation).toBeGreaterThan(oldGeneration);
  expect(pending.generation).toBe(active.generation);
  await page.getByRole('button', { name: '立即调整' }).click();
  await expect(page.getByRole('button', { name: '立即调整' })).toHaveAttribute('aria-pressed', 'true');

  const snapshotMessage = '旧 SSE terminal 到达后刷新出的 snapshot 消息';
  const lateTerminal = await request.post(
    `${fakeApiRoot}/api/__e2e/assistant/events/late-terminal`,
    {
      data: {
        commandId: commandIds.get('旧 SSE terminal 的命令 A'),
        outcome: 'succeeded',
        messageText: snapshotMessage,
      },
    },
  );
  expect(lateTerminal.ok()).toBe(true);

  await expect(page.getByText(snapshotMessage, { exact: true })).toBeVisible();
  await expect(page.getByText('Multivac 正在处理', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '取消当前处理' })).toBeVisible();
  await expect(page.getByText('运行中发送方式')).toBeVisible();
  await expect(page.getByRole('button', { name: '立即调整' })).toHaveAttribute('aria-pressed', 'true');
  await expect(draft).toHaveValue('B 运行期间输入的新草稿 C');
  expect(await page.evaluate(() => ({
    active: sessionStorage.getItem('multivac.assistant.active-prompt-command'),
    pending: sessionStorage.getItem('multivac.assistant.pending-command'),
    generation: sessionStorage.getItem('multivac.assistant.command-generation'),
  }))).toEqual(before);

  expect((await request.post(
    `${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`,
  )).ok()).toBe(true);
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue('B 运行期间输入的新草稿 C');
});

test('thinking、工具、retry、compaction 使用显式投影且不包含 SDK 原始 payload', async ({ page, request }) => {
  const snapshot = await request.get(`${fakeApiRoot}/api/assistant/session`);
  const { eventCursor } = await snapshot.json() as { eventCursor: string };
  await page.evaluate((cursor) => {
    const types: string[] = [];
    const payloads: string[] = [];
    const source = new EventSource(`/api/assistant/events?after=${encodeURIComponent(cursor)}`);
    source.addEventListener('assistant-event', (event) => {
      const text = (event as MessageEvent<string>).data;
      payloads.push(text);
      types.push((JSON.parse(text) as { type: string }).type);
    });
    Object.assign(window, { __assistantEventTypes: types, __assistantEventPayloads: payloads, __assistantEventSource: source });
  }, eventCursor);

  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill('重试压缩场景：展示安全状态');
  await draft.press('Enter');
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __assistantEventTypes: string[] }).__assistantEventTypes,
  )).toEqual(expect.arrayContaining([
    'assistant.tool.started',
    'assistant.retry.started',
    'assistant.compaction.started',
    'assistant.run.succeeded',
  ]));
  const payloads = await page.evaluate(() =>
    (window as Window & { __assistantEventPayloads: string[] }).__assistantEventPayloads.join('\n'),
  );
  expect(payloads).toContain('assistant.thinking.delta');
  expect(payloads).toContain('正在梳理当前请求需要核对的范围和执行步骤');
  expect(payloads).not.toContain('"channel":"thinking"');
  // 执行记录只经显式字段投影，原始参数与结果对象不得出现在 SSE。
  expect(payloads).toContain('inputText');
  expect(payloads).not.toContain('argumentKeys');
  expect(payloads).not.toContain('"arguments"');
  expect(payloads).not.toContain('"result"');
  expect(payloads).not.toContain('"partialResult"');
  expect(payloads).not.toContain('"outputText"');
  expect(payloads).not.toContain('展示安全状态');
  await expect(page.locator('.run-status').getByText('处理完成', { exact: true })).toBeVisible();
});

test('提交后 Trace 自动展开，实际回复出现后自动收起并可重新展开', async ({ page, request }) => {
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`)).ok()).toBe(true);
  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill('工具失败后成功场景：展示执行记录');
  await draft.press('Enter');
  await expect.poll(async () =>
    (await request.get(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`)).ok(),
  ).toBe(true);

  // 用户提交后，运行中的 Trace 默认展开并展示思考与工具步骤。
  const group = page.locator('.run-trace').filter({
    has: page.locator('[data-tool-call-id="tool-retry"]'),
  });
  await expect(group).toBeVisible();
  await expect(group.locator('summary > span')).toHaveText('思考中');
  await expect(group.locator('summary > small')).toHaveText('1 个工具');
  await expect(group).toHaveAttribute('open', '');
  await expect(group.locator('.run-trace-content')).toBeVisible();
  await expect(group.locator('.run-trace-tool')).toHaveCount(1);

  // 记录按命令锚点落回所属 Turn：位于该 Turn 的助手回复之前，而不是堆在会话末尾。
  const order = await page.evaluate(() => {
    const stream = document.querySelector('.message-stream');
    const children = [...(stream?.children ?? [])];
    const assistantRows = children
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => node.classList.contains('chat-row') && node.classList.contains('assistant'));
    return {
      toolIndex: children.findIndex((node) => node.classList.contains('run-trace')),
      assistantIndex: children.findIndex((node) => node.classList.contains('assistant')),
      lastAssistantIndex: assistantRows.at(-1)?.index ?? -1,
      assistantCount: assistantRows.length,
    };
  });
  expect(order.assistantCount).toBeGreaterThan(0);
  expect(order.toolIndex).toBeGreaterThan(0);
  expect(order.toolIndex).toBeLessThan(order.lastAssistantIndex);

  // 记录占满两侧头像之间的对话区：不越过头像，也不被压成助手气泡列宽。
  const geometry = await page.evaluate(() => {
    const box = (element: Element | null) => {
      const rect = element?.getBoundingClientRect();
      return rect ? { left: rect.left, right: rect.right, width: rect.width } : null;
    };
    const stream = document.querySelector('.message-stream');
    const style = stream ? getComputedStyle(stream) : null;
    const bounds = stream?.getBoundingClientRect();
    const contentWidth = bounds && style
      ? bounds.width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
      : 0;
    return {
      tool: box(document.querySelector('.run-trace')),
      assistantAvatar: box(document.querySelector('article.chat-row.assistant .avatar')),
      userAvatar: box(document.querySelector('article.chat-row.user .avatar')),
      conversationWidth: contentWidth,
      pageOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  expect(geometry.tool).not.toBeNull();
  expect(geometry.assistantAvatar).not.toBeNull();
  expect(geometry.userAvatar).not.toBeNull();
  // 左边界与助手内容列对齐（头像右侧），右边界止于用户头像列之前。
  expect(geometry.tool!.left).toBeGreaterThanOrEqual(geometry.assistantAvatar!.right - 1);
  expect(geometry.tool!.right).toBeLessThanOrEqual(geometry.userAvatar!.left + 1);
  // 占满对话区：明显宽于助手气泡列（78%），不是被压缩的窄框。
  expect(geometry.tool!.width).toBeGreaterThan(geometry.conversationWidth * 0.8);
  expect(geometry.pageOverflowX).toBe(false);

  // 展开区域实时展示 provider 返回的 thinking 和当前工具步骤。
  await expect(group.locator('.run-trace-thought')).toContainText('先检查失败的工具调用');
  await expect(group.locator('[data-tool-call-id="tool-retry"]')).toContainText('title: 整理 MVP 范围');
  await expect(group.locator('[data-tool-call-id="tool-retry"] em')).toHaveText('失败');

  // 释放运行后，等待实际助手回复进入消息流，再自动收起 Trace。
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(group.locator('summary > span')).toHaveText(/^用时 \d+ 秒$/);
  await expect(group.locator('summary > small')).toHaveText('2 个工具');
  await expect(page.locator('article.chat-row.assistant').last()).toContainText('Fake Multivac 已处理当前消息。');
  await expect(group).not.toHaveAttribute('open', '');
  await expect(group.locator('.run-trace-content')).not.toBeVisible();

  // 完成后仍可手动重新展开检查完整 Trace。
  await group.locator('summary').click();
  await expect(group.locator('[data-tool-call-id="tool-check"]')).toContainText('path: PROJECT_CONSTRAINTS.md');
  await expect(group.locator('[data-tool-call-id="tool-check"] em')).toHaveText('已完成');
  const traceOrder = await group.locator('.run-trace-content').evaluate((content) =>
    [...content.children].map((element) => element.classList.contains('run-trace-thought')
      ? `thinking:${element.textContent}`
      : `tool:${element.getAttribute('data-tool-call-id')}`));
  expect(traceOrder).toEqual([
    'thinking:先检查失败的工具调用，再继续核对相关约束。',
    'tool:tool-retry',
    'thinking:失败步骤已经记录，继续读取项目约束确认后续处理。',
    'tool:tool-check',
  ]);
  await group.locator('summary').click();
  await expect(group).not.toHaveAttribute('open', '');
  await expect(group.locator('.run-trace-content')).not.toBeVisible();

  // 刷新后记录仍从服务端投影恢复，而不是只存在于前端内存。
  await page.reload();
  await expect(group).toBeVisible();
  await expect(group.locator('summary > span')).toHaveText(/^用时 \d+ 秒$/);
  await expect(group.locator('summary > small')).toHaveText('2 个工具');
  await expect(group).not.toHaveAttribute('open', '');
  await expect(group.locator('.run-trace-content')).not.toBeVisible();
  await group.locator('summary').click();
  await expect(group.locator('.run-trace-thought').first()).toContainText('先检查失败的工具调用');
  await group.locator('summary').click();
  const tools = await request.get(`${fakeApiRoot}/api/assistant/session`);
  const body = await tools.json() as {
    toolExecutions?: Array<{ toolCallId: string; toolName: string; status: string; commandId: string | null }>;
  };
  expect(body.toolExecutions?.map((tool) => [tool.toolCallId, tool.status])).toContainEqual(
    ['tool-retry', 'failed'],
  );
  expect(body.toolExecutions?.map((tool) => [tool.toolCallId, tool.status])).toContainEqual(
    ['tool-check', 'succeeded'],
  );
  expect(body.toolExecutions?.every((tool) => tool.commandId !== null)).toBe(true);
  expect(body.toolExecutions?.every((tool) => tool.status !== 'running')).toBe(true);

  // 明细接口按 toolCallId 返回完整投影，未知 ID 返回 404。
  const detail = await request.get(`${fakeApiRoot}/api/assistant/tools/tool-retry`);
  expect(detail.status()).toBe(200);
  const detailBody = await detail.json() as {
    toolName: string; status: string; inputText: string;
  };
  expect(detailBody.toolName).toBe('propose_task');
  expect(detailBody.status).toBe('failed');
  expect(detailBody.inputText).toContain('title:');
  expect('outputText' in detailBody).toBe(false);
  expect((await request.get(`${fakeApiRoot}/api/assistant/tools/unknown-tool`)).status()).toBe(404);
});

test('流式回复开始后 Trace 收起并保持在对应回复之前', async ({ page, request }) => {
  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm-streaming`)).ok()).toBe(true);
  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill('工具失败后成功场景：流式回复定位');
  await draft.press('Enter');
  await expect.poll(async () =>
    (await request.get(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/entered`)).ok(),
  ).toBe(true);

  const partial = 'Fake Multivac 已处理当前消息。'.slice(0, Math.ceil('Fake Multivac 已处理当前消息。'.length / 2));
  const reply = page.locator('article.chat-row.assistant').filter({ hasText: partial });
  const group = page.locator('.run-trace').filter({
    has: page.locator('[data-tool-call-id="tool-retry"]'),
  });
  await expect(reply).toBeVisible();
  await expect(group).toBeVisible();
  await expect(group).not.toHaveAttribute('open', '');
  await expect(group.locator('.run-trace-content')).not.toBeVisible();

  const order = await page.evaluate((text) => {
    const children = [...(document.querySelector('.message-stream')?.children ?? [])];
    return {
      trace: children.findIndex((node) => node.classList.contains('run-trace')),
      reply: children.findIndex((node) =>
        node.classList.contains('chat-row') && node.textContent?.includes(text)),
    };
  }, partial);
  expect(order.trace).toBeGreaterThanOrEqual(0);
  expect(order.trace).toBeLessThan(order.reply);

  expect((await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`)).ok()).toBe(true);
  await expect(reply.locator('p')).toHaveText('Fake Multivac 已处理当前消息。');
});

test('工具失败只显示中间错误，原 prompt 保持可控制并由最终 run 事实终结', async ({ page }) => {
  const draft = page.getByLabel('Multivac 草稿');
  const successResponsePromise = page.waitForResponse((response) => {
    if (!response.url().endsWith('/api/assistant/turns')) return false;
    return (response.request().postDataJSON() as { text?: string }).text === '工具失败后成功场景';
  });
  await draft.fill('工具失败后成功场景');
  await draft.press('Enter');
  await expect(page.getByText('propose_task 执行失败')).toBeVisible();
  await expect(page.getByRole('button', { name: '取消当前处理' })).toBeVisible();
  await expect(page.getByText('运行中发送方式')).toBeVisible();

  await draft.fill('工具失败后仍继续 steer');
  await page.getByRole('button', { name: '立即调整' }).click();
  await page.getByLabel('发送消息').click();
  await expect(draft).toHaveValue('');
  const successResponse = await successResponsePromise;
  expect((await successResponse.json()).terminalOutcome).toBe('succeeded');
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();

  const failureResponsePromise = page.waitForResponse((response) => {
    if (!response.url().endsWith('/api/assistant/turns')) return false;
    return (response.request().postDataJSON() as { text?: string }).text === '工具失败后最终失败场景';
  });
  await draft.fill('工具失败后最终失败场景');
  await draft.press('Enter');
  await expect(page.getByText('propose_task 执行失败')).toBeVisible();
  await expect(page.getByRole('button', { name: '取消当前处理' })).toBeVisible();
  const failureResponse = await failureResponsePromise;
  expect((await failureResponse.json()).terminalOutcome).toBe('failed');
  await expect(page.getByRole('status').getByText('处理失败', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '取消当前处理' })).toHaveCount(0);
});

test('压缩失败只显示中间状态，后续 terminal 决定命令成功或失败', async ({ page }) => {
  const draft = page.getByLabel('Multivac 草稿');
  const successResponsePromise = page.waitForResponse((response) => {
    if (!response.url().endsWith('/api/assistant/turns')) return false;
    return (response.request().postDataJSON() as { text?: string }).text === '压缩失败后成功场景';
  });
  await draft.fill('压缩失败后成功场景');
  await draft.press('Enter');
  await expect(page.getByText('会话上下文压缩失败，继续等待运行结果')).toBeVisible();
  await expect(page.getByRole('button', { name: '取消当前处理' })).toBeVisible();
  await expect(page.getByText('运行中发送方式')).toBeVisible();
  const successResponse = await successResponsePromise;
  expect((await successResponse.json()).terminalOutcome).toBe('succeeded');
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();

  const failureResponsePromise = page.waitForResponse((response) => {
    if (!response.url().endsWith('/api/assistant/turns')) return false;
    return (response.request().postDataJSON() as { text?: string }).text === '压缩失败后最终失败场景';
  });
  await draft.fill('压缩失败后最终失败场景');
  await draft.press('Enter');
  await expect(page.getByText('会话上下文压缩失败，继续等待运行结果')).toBeVisible();
  await expect(page.getByRole('button', { name: '取消当前处理' })).toBeVisible();
  const failureResponse = await failureResponsePromise;
  expect((await failureResponse.json()).terminalOutcome).toBe('failed');
  await expect(page.getByRole('status').getByText('处理失败', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '取消当前处理' })).toHaveCount(0);
});

test('SSE 断线重连会 replay 终态且消息按稳定 ID 去重', async ({ page, context }) => {
  const text = 'SSE 断线期间完成的唯一消息';
  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill(text);
  await draft.press('Enter');
  await expect(page.getByText('Multivac 正在处理')).toBeVisible();

  await context.setOffline(true);
  await page.waitForTimeout(800);
  await context.setOffline(false);

  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(page.getByText(text, { exact: true })).toHaveCount(1);
  const currentMessage = page.locator('article.chat-row.user').filter({ hasText: text });
  await expect(currentMessage).toHaveCount(1);
  await expect(currentMessage.locator('xpath=following-sibling::article[1]'))
    .toContainText('Fake Multivac 已处理当前消息。');
  await expect(page.locator('.save-error')).toHaveCount(0);
  await expect(page.getByText('草稿已保存')).toBeVisible();
  const entryIds = await page.locator('[data-entry-id]').evaluateAll((elements) =>
    elements.map((element) => (element as HTMLElement).dataset.entryId),
  );
  expect(new Set(entryIds).size).toBe(entryIds.length);

  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    composer: document.querySelector('.assistant-composer')!.scrollWidth -
      document.querySelector('.assistant-composer')!.clientWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(0);
  expect(overflow.composer).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${reportRoot}/qa-assistant-turn-desktop.png`, fullPage: true });
});

test('SSE 断线期间完成且重连 cursor expired 时以 snapshot 和回执恢复终态', async ({ page, context, request }) => {
  let expireNextConnection = false;
  let expiredResponses = 0;
  let recoveredSseConnections = 0;
  let resyncFailuresRemaining = 0;
  let resyncFailures = 0;
  let turnPosts = 0;
  let commandQueries = 0;
  let serverRequest: ReturnType<typeof request.post> | undefined;
  await page.route('**/api/assistant/events?*', async (route) => {
    if (!expireNextConnection) {
      if (expiredResponses > 0) recoveredSseConnections += 1;
      return route.continue();
    }
    expireNextConnection = false;
    expiredResponses += 1;
    resyncFailuresRemaining = 2;
    return route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'EVENT_CURSOR_EXPIRED',
          message: '公共事件游标已失效，需要重新读取会话快照。',
        },
      }),
    });
  });
  await page.route('**/api/assistant/session?*', async (route) => {
    if (resyncFailuresRemaining === 0) return route.continue();
    resyncFailuresRemaining -= 1;
    resyncFailures += 1;
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'ASSISTANT_SESSION_UNAVAILABLE', message: '测试 resync 暂时失败。' },
      }),
    });
  });
  await page.route('**/api/assistant/turns', async (route) => {
    turnPosts += 1;
    serverRequest = request.post(`${fakeApiRoot}/api/assistant/turns`, {
      data: route.request().postDataJSON(),
    });
    await route.abort('failed');
  });
  await page.route('**/api/assistant/commands/*', async (route) => {
    commandQueries += 1;
    await route.continue();
  });

  const text = 'expired cursor 恢复后的唯一消息';
  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill(text);
  await draft.press('Enter');
  await expect(page.getByText('Multivac 正在处理')).toBeVisible();

  await context.setOffline(true);
  await page.waitForTimeout(800);
  await page.goto('about:blank');
  expireNextConnection = true;
  await context.setOffline(false);
  await page.goBack();

  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue('');
  await expect(page.getByText(text, { exact: true })).toHaveCount(1);
  await expect(page.locator('article.chat-row.user').filter({ hasText: text })).toHaveCount(1);
  await expect.poll(() => resyncFailures).toBe(2);
  await expect.poll(() => recoveredSseConnections).toBeGreaterThan(0);
  expect(expiredResponses).toBe(1);
  expect(turnPosts).toBe(1);
  expect(commandQueries).toBeGreaterThan(0);
  expect((await serverRequest)?.ok()).toBe(true);
  const entryIds = await page.locator('[data-entry-id]').evaluateAll((elements) =>
    elements.map((element) => (element as HTMLElement).dataset.entryId),
  );
  expect(new Set(entryIds).size).toBe(entryIds.length);
});

test('POST 断线对账成功并保存空草稿后清除陈旧保存错误', async ({ page, request }) => {
  const text = '断线恢复后清除陈旧保存错误';
  let failedDraftSave = false;
  let serverRequest: ReturnType<typeof request.post> | undefined;
  await page.route('**/api/assistant/page-state', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    const body = route.request().postDataJSON() as { draft?: string };
    if (!failedDraftSave && body.draft === text) {
      failedDraftSave = true;
      return route.abort('failed');
    }
    return route.continue();
  });
  await page.route('**/api/assistant/turns', async (route) => {
    serverRequest = request.post(`${fakeApiRoot}/api/assistant/turns`, {
      data: route.request().postDataJSON(),
    });
    await route.abort('failed');
  });

  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill(text);
  await expect(page.getByText('草稿保存失败：网络连接不可用，请重试。')).toBeVisible();
  await draft.press('Enter');
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue('');
  await expect(page.locator('.save-error')).toHaveCount(0);
  await expect(page.getByText('草稿已保存')).toBeVisible();
  expect((await serverRequest)?.ok()).toBe(true);
});

test('移动端运行状态、行为选择和 composer 不重叠', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill('移动端慢任务');
  await draft.press('Enter');
  await expect(page.getByText('运行中发送方式')).toBeVisible();

  const overlap = await page.evaluate(() => {
    const status = document.querySelector('.run-status')!.getBoundingClientRect();
    const behavior = document.querySelector('.streaming-behavior')!.getBoundingClientRect();
    const textarea = document.querySelector('.assistant-composer textarea')!.getBoundingClientRect();
    return {
      statusBehavior: status.bottom - behavior.top,
      behaviorTextarea: behavior.bottom - textarea.top,
      horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(overlap.statusBehavior).toBeLessThanOrEqual(1);
  expect(overlap.behaviorTextarea).toBeLessThanOrEqual(1);
  expect(overlap.horizontal).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${reportRoot}/qa-assistant-turn-mobile.png`, fullPage: true });
  await expect(page.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
});
