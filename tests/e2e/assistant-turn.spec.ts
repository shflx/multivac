import { expect, test } from '@playwright/test';

const reportRoot = '.report/in-progress/2026-09-14-dev-156-assistant-turns';

test.beforeEach(async ({ page, request }) => {
  const response = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
  const current = await response.json() as { revision: number };
  await request.put('http://127.0.0.1:4317/api/assistant/page-state', {
    data: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, revision: current.revision },
  });
  await page.goto('/');
  await expect(page.getByLabel('协调助手草稿')).toBeEditable();
});

test('composer 支持 Enter、Shift+Enter、IME 229 且提交中防重复', async ({ page }) => {
  let sends = 0;
  await page.route('**/api/assistant/turns', async (route) => {
    sends += 1;
    await route.continue();
  });
  const draft = page.getByLabel('协调助手草稿');
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
  await expect(page.getByText('处理完成')).toBeVisible();
  expect(sends).toBe(1);
  await expect(draft).toHaveValue('');
});

test('已知失败保留草稿，显式重试使用新 commandId 并成功清空', async ({ page }) => {
  const commandIds: string[] = [];
  await page.route('**/api/assistant/turns', async (route) => {
    commandIds.push((route.request().postDataJSON() as { commandId: string }).commandId);
    await route.continue();
  });
  const draft = page.getByLabel('协调助手草稿');
  await draft.fill('失败场景：保留草稿并重试');
  await draft.press('Enter');

  await expect(page.getByText('处理失败', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue('失败场景：保留草稿并重试');
  await page.getByRole('button', { name: '重试发送' }).click();
  await expect(page.getByText('处理完成')).toBeVisible();
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

  const draft = page.getByLabel('协调助手草稿');
  await draft.fill(submittedText);
  await draft.press('Enter');
  await expect(page.getByText('正在确认消息是否已接受')).toBeVisible();
  reconciliationStatus = 'accepted';
  await expect(page.getByText('消息已接受')).toBeVisible();
  reconciliationStatus = 'handed_to_pi';
  await expect(page.getByText('消息已交给 Pi')).toBeVisible();

  await page.goto('about:blank');
  await page.goBack();
  await expect(page.getByLabel('协调助手草稿')).toHaveValue(submittedText);
  await expect(page.getByText('消息已交给 Pi')).toBeVisible();
  reconciliationStatus = 'running';
  await expect(page.getByText('协调助手正在处理')).toBeVisible();
  await page.getByLabel('协调助手草稿').fill('用户在对账期间输入的新草稿');
  await page.goto('about:blank');
  await page.goBack();
  await expect(page.getByText('协调助手正在处理')).toBeVisible();
  expect(submittedBody).toBeDefined();
  serverRequest = request.post('http://127.0.0.1:4317/api/assistant/turns', {
    data: submittedBody!,
  });
  reconciliationStatus = 'terminal';
  expect((await serverRequest).ok()).toBe(true);
  await expect(page.getByText('处理完成')).toBeVisible();
  await expect(page.getByLabel('协调助手草稿')).toHaveValue('用户在对账期间输入的新草稿');

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

  const draft = page.getByLabel('协调助手草稿');
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
  await expect(page.getByLabel('协调助手草稿')).toHaveValue(submittedText);
  await expect(page.getByText('正在确认消息是否已接受')).toBeVisible();
  await page.clock.runFor(13_000);
  await expect(page.getByText('发送结果未知', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '按原命令重试' })).toBeEnabled();
  expect(await page.evaluate(() => sessionStorage.getItem('multivac.assistant.active-prompt-command'))).toBeNull();

  allowDispatch = true;
  await page.getByRole('button', { name: '按原命令重试' }).click();
  await expect(page.getByText('处理完成', { exact: true })).toBeVisible();
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
    const currentResponse = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
    const current = await currentResponse.json() as {
      draft: string;
      anchorEntryId: string | null;
      anchorOffsetPx: number;
      revision: number;
    };
    await request.put('http://127.0.0.1:4317/api/assistant/page-state', {
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

  const draft = page.getByLabel('协调助手草稿');
  await expect(draft).toHaveValue(submittedText);
  await page.clock.runFor(13_000);
  await expect(page.getByRole('button', { name: '按原命令重试' })).toBeEnabled();

  allowDispatch = true;
  await page.getByRole('button', { name: '按原命令重试' }).click();
  await expect(page.getByText('处理完成', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue('');
  await expect.poll(async () => {
    const response = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
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
  const currentResponse = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
  const current = await currentResponse.json() as { revision: number };
  await request.put('http://127.0.0.1:4317/api/assistant/page-state', {
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

  const draft = page.getByLabel('协调助手草稿');
  await expect(draft).toHaveValue(submittedText);
  await page.clock.runFor(13_000);
  await expect(page.getByRole('button', { name: '按原命令重试' })).toBeEnabled();

  allowDispatch = true;
  await page.getByRole('button', { name: '按原命令重试' }).click();
  await expect(page.getByText('协调助手正在处理')).toBeVisible();
  await draft.fill(editedText);
  await expect(page.getByText('处理完成', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue(editedText);
  await expect.poll(async () => {
    const response = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
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

  await expect(page.getByLabel('协调助手草稿')).toHaveValue('');
  await expect(page.getByText('旧命令缺少可恢复的正文，已清理待重试记录。')).toBeVisible();
  await expect(page.getByRole('button', { name: '按原命令重试' })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('multivac.assistant.pending-command'))).toBeNull();
  expect(commandQueries).toBe(0);
});

test('已有 page-state conflict 时命令成功不清空远端新草稿', async ({ page, request }) => {
  const submittedText = '页面 A 已提交但尚未结算的旧草稿';
  const remoteDraft = '页面 B 在冲突后保留的新草稿';
  let releaseDraftSave!: () => void;
  let markDraftSaveEntered!: () => void;
  const draftSaveGate = new Promise<void>((resolve) => { releaseDraftSave = resolve; });
  const draftSaveEntered = new Promise<void>((resolve) => { markDraftSaveEntered = resolve; });
  let blockedDraftSave = false;
  let emptySaveAttempts = 0;
  let turnPosts = 0;
  let commandId = '';

  await page.route('**/api/assistant/page-state', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    const body = route.request().postDataJSON() as { draft?: string };
    if (body.draft === '') emptySaveAttempts += 1;
    if (body.draft !== submittedText || blockedDraftSave) return route.continue();
    blockedDraftSave = true;
    markDraftSaveEntered();
    await draftSaveGate;
    return route.continue();
  });
  await page.route('**/api/assistant/turns', async (route) => {
    turnPosts += 1;
    commandId = (route.request().postDataJSON() as { commandId: string }).commandId;
    await route.continue();
  });
  expect((await request.post(
    'http://127.0.0.1:4317/api/__e2e/assistant/prompt-completion/arm',
  )).ok()).toBe(true);

  const draft = page.getByLabel('协调助手草稿');
  await draft.fill(submittedText);
  await draft.press('Enter');
  await draftSaveEntered;
  const currentResponse = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
  const current = await currentResponse.json() as { revision: number };
  expect((await request.put('http://127.0.0.1:4317/api/assistant/page-state', {
    data: { draft: remoteDraft, anchorEntryId: null, anchorOffsetPx: 0, revision: current.revision },
  })).ok()).toBe(true);
  releaseDraftSave();

  await expect(page.getByText('其他页面更新了保存版本；当前草稿已保留，请重试保存。')).toBeVisible();
  expect((await request.get(
    'http://127.0.0.1:4317/api/__e2e/assistant/prompt-completion/entered',
  )).ok()).toBe(true);
  expect((await request.post(
    'http://127.0.0.1:4317/api/__e2e/assistant/prompt-completion/release',
  )).ok()).toBe(true);

  await expect(page.getByText('处理完成', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue(submittedText);
  expect(emptySaveAttempts).toBe(0);
  expect(turnPosts).toBe(1);
  expect(await page.evaluate(() => sessionStorage.getItem('multivac.assistant.pending-command'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('multivac.assistant.active-prompt-command'))).toBeNull();
  const commandResponse = await request.get(
    `http://127.0.0.1:4317/api/assistant/commands/${encodeURIComponent(commandId)}`,
  );
  await expect(commandResponse.json()).resolves.toMatchObject({
    status: 'terminal',
    receipt: { terminalOutcome: 'succeeded' },
  });
  const remoteResponse = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
  await expect(remoteResponse.json()).resolves.toMatchObject({ draft: remoteDraft });

  await page.reload();
  await expect(page.getByLabel('协调助手草稿')).toHaveValue(remoteDraft);
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
    const currentResponse = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
    const current = await currentResponse.json() as {
      anchorEntryId: string | null;
      anchorOffsetPx: number;
      revision: number;
    };
    expect((await request.put('http://127.0.0.1:4317/api/assistant/page-state', {
      data: { ...current, draft: remoteDraft },
    })).ok()).toBe(true);
    return route.continue();
  });
  await page.route('**/api/assistant/turns', async (route) => {
    turnPosts += 1;
    commandId = (route.request().postDataJSON() as { commandId: string }).commandId;
    await route.continue();
  });

  const draft = page.getByLabel('协调助手草稿');
  await draft.fill(submittedText);
  await expect.poll(async () => {
    const response = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
    return (await response.json() as { draft: string }).draft;
  }).toBe(submittedText);
  expect((await request.post(
    'http://127.0.0.1:4317/api/__e2e/assistant/prompt-completion/arm',
  )).ok()).toBe(true);
  await draft.press('Enter');
  expect((await request.get(
    'http://127.0.0.1:4317/api/__e2e/assistant/prompt-completion/entered',
  )).ok()).toBe(true);
  expect((await request.post(
    'http://127.0.0.1:4317/api/__e2e/assistant/prompt-completion/release',
  )).ok()).toBe(true);

  await expect(page.getByText('处理完成', { exact: true })).toBeVisible();
  await expect(page.getByText('其他页面更新了保存版本；当前草稿已保留，请重试保存。')).toBeVisible();
  expect(emptySaveAttempts).toBe(1);
  expect(turnPosts).toBe(1);
  expect(await page.evaluate(() => sessionStorage.getItem('multivac.assistant.pending-command'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('multivac.assistant.active-prompt-command'))).toBeNull();
  const commandResponse = await request.get(
    `http://127.0.0.1:4317/api/assistant/commands/${encodeURIComponent(commandId)}`,
  );
  await expect(commandResponse.json()).resolves.toMatchObject({
    status: 'terminal',
    receipt: { terminalOutcome: 'succeeded' },
  });
  const remoteResponse = await request.get('http://127.0.0.1:4317/api/assistant/page-state');
  await expect(remoteResponse.json()).resolves.toMatchObject({ draft: remoteDraft });

  await page.reload();
  await expect(page.getByLabel('协调助手草稿')).toHaveValue(remoteDraft);
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

  const draft = page.getByLabel('协调助手草稿');
  await draft.fill('迟到 POST 的旧命令 A');
  await draft.press('Enter');
  await expect(page.getByText('处理完成', { exact: true })).toBeVisible();

  expect((await request.post(
    'http://127.0.0.1:4317/api/__e2e/assistant/prompt-completion/arm',
  )).ok()).toBe(true);
  await draft.fill('较新的运行命令 B');
  await draft.press('Enter');
  expect((await request.get(
    'http://127.0.0.1:4317/api/__e2e/assistant/prompt-completion/entered',
  )).ok()).toBe(true);
  await expect(page.getByText('协调助手正在处理')).toBeVisible();
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
  await expect(draft).toHaveValue('较新的运行命令 B');
  expect(await page.evaluate(() => {
    const value = sessionStorage.getItem('multivac.assistant.active-prompt-command');
    return value ? (JSON.parse(value) as { commandId: string }).commandId : null;
  })).toBe(commandIds.get('较新的运行命令 B'));
  expect(await page.evaluate(() => {
    const value = sessionStorage.getItem('multivac.assistant.pending-command');
    return value ? (JSON.parse(value) as { commandId: string }).commandId : null;
  })).toBe(commandIds.get('较新的运行命令 B'));
  expect((await request.post(
    'http://127.0.0.1:4317/api/__e2e/assistant/prompt-completion/release',
  )).ok()).toBe(true);
  await expect(page.getByText('处理完成', { exact: true })).toBeVisible();
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
      oldServerRequest = request.post('http://127.0.0.1:4317/api/assistant/turns', { data: body });
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

  const draft = page.getByLabel('协调助手草稿');
  await draft.fill('迟到 GET 的旧命令 A');
  await draft.press('Enter');
  await expect(page.getByText('处理完成', { exact: true })).toBeVisible();

  expect((await request.post(
    'http://127.0.0.1:4317/api/__e2e/assistant/prompt-completion/arm',
  )).ok()).toBe(true);
  await draft.fill('GET 交错后的新命令 B');
  await draft.press('Enter');
  expect((await request.get(
    'http://127.0.0.1:4317/api/__e2e/assistant/prompt-completion/entered',
  )).ok()).toBe(true);
  await expect(page.getByText('协调助手正在处理')).toBeVisible();
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
  await expect(draft).toHaveValue('GET 交错后的新命令 B');
  expect(await page.evaluate(() => {
    const value = sessionStorage.getItem('multivac.assistant.active-prompt-command');
    return value ? (JSON.parse(value) as { commandId: string }).commandId : null;
  })).toBe(newCommandId);
  expect(await page.evaluate(() => {
    const value = sessionStorage.getItem('multivac.assistant.pending-command');
    return value ? (JSON.parse(value) as { commandId: string }).commandId : null;
  })).toBe(newCommandId);
  expect((await request.post(
    'http://127.0.0.1:4317/api/__e2e/assistant/prompt-completion/release',
  )).ok()).toBe(true);
  await expect(page.getByText('处理完成', { exact: true })).toBeVisible();
});

test('运行中必须明确选择 steer 或 followUp，且 terminal 后取消保持原终态', async ({ page, request }) => {
  const draft = page.getByLabel('协调助手草稿');
  await draft.fill('启动一个可调整的慢任务');
  await draft.press('Enter');
  await expect(page.getByText('协调助手正在处理')).toBeVisible();

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

  const armBarrier = await request.post(
    'http://127.0.0.1:4317/api/__e2e/assistant/prompt-completion/arm',
  );
  expect(armBarrier.ok()).toBe(true);
  await draft.fill('正常完成后不再接受取消');
  await draft.press('Enter');
  const enteredBarrier = await request.get(
    'http://127.0.0.1:4317/api/__e2e/assistant/prompt-completion/entered',
  );
  expect(enteredBarrier.ok()).toBe(true);
  await expect(page.getByText('协调助手正在处理', { exact: true })).toBeVisible();
  const releaseBarrier = await request.post(
    'http://127.0.0.1:4317/api/__e2e/assistant/prompt-completion/release',
  );
  expect(releaseBarrier.ok()).toBe(true);
  await expect(page.getByText('处理完成')).toBeVisible();
  const lateCancel = await request.post(
    'http://127.0.0.1:4317/api/assistant/turns/current/cancel',
    {
      data: {
        commandId: 'e2e-terminal-late-cancel',
        assistantSessionId: 'global-coordinator',
      },
    },
  );
  expect(lateCancel.status()).toBe(422);
  expect((await lateCancel.json()).error.code).toBe('COMMAND_STATE_MISMATCH');
  await expect(page.getByText('处理完成')).toBeVisible();
  await expect(page.getByText('处理已取消')).toHaveCount(0);
});

test('旧 SSE terminal 不清除较新 generation，且仍刷新消息 snapshot', async ({ page, request }) => {
  const commandIds = new Map<string, string>();
  await page.route('**/api/assistant/turns', async (route) => {
    const body = route.request().postDataJSON() as { commandId: string; text: string };
    commandIds.set(body.text, body.commandId);
    await route.continue();
  });

  const draft = page.getByLabel('协调助手草稿');
  await draft.fill('旧 SSE terminal 的命令 A');
  await draft.press('Enter');
  await expect(page.getByText('处理完成', { exact: true })).toBeVisible();
  const oldGeneration = Number(await page.evaluate(() =>
    sessionStorage.getItem('multivac.assistant.command-generation'),
  ));

  expect((await request.post(
    'http://127.0.0.1:4317/api/__e2e/assistant/prompt-completion/arm',
  )).ok()).toBe(true);
  await draft.fill('受保护的新命令 B');
  await draft.press('Enter');
  expect((await request.get(
    'http://127.0.0.1:4317/api/__e2e/assistant/prompt-completion/entered',
  )).ok()).toBe(true);
  await expect(page.getByText('协调助手正在处理', { exact: true })).toBeVisible();
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
    'http://127.0.0.1:4317/api/__e2e/assistant/events/late-terminal',
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
  await expect(page.getByText('协调助手正在处理', { exact: true })).toBeVisible();
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
    'http://127.0.0.1:4317/api/__e2e/assistant/prompt-completion/release',
  )).ok()).toBe(true);
  await expect(page.getByText('处理完成', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue('B 运行期间输入的新草稿 C');
});

test('工具、retry、compaction 安全状态可见且 SSE 事件不含正文 delta', async ({ page }) => {
  await page.evaluate(() => {
    const types: string[] = [];
    const payloads: string[] = [];
    const source = new EventSource('/api/assistant/events?after=0');
    source.addEventListener('assistant-event', (event) => {
      const text = (event as MessageEvent<string>).data;
      payloads.push(text);
      types.push((JSON.parse(text) as { type: string }).type);
    });
    Object.assign(window, { __assistantEventTypes: types, __assistantEventPayloads: payloads, __assistantEventSource: source });
  });

  const draft = page.getByLabel('协调助手草稿');
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
  expect(payloads).not.toContain('delta');
  expect(payloads).not.toContain('展示安全状态');
  await expect(page.getByText('处理完成')).toBeVisible();
});

test('工具失败只显示中间错误，原 prompt 保持可控制并由最终 run 事实终结', async ({ page }) => {
  const draft = page.getByLabel('协调助手草稿');
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
  await expect(page.getByText('处理完成', { exact: true })).toBeVisible();

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
  await expect(page.getByText('处理失败', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '取消当前处理' })).toHaveCount(0);
});

test('压缩失败只显示中间状态，后续 terminal 决定命令成功或失败', async ({ page }) => {
  const draft = page.getByLabel('协调助手草稿');
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
  await expect(page.getByText('处理完成', { exact: true })).toBeVisible();

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
  await expect(page.getByText('处理失败', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '取消当前处理' })).toHaveCount(0);
});

test('SSE 断线重连会 replay 终态且消息按稳定 ID 去重', async ({ page, context }) => {
  const text = 'SSE 断线期间完成的唯一消息';
  const draft = page.getByLabel('协调助手草稿');
  await draft.fill(text);
  await draft.press('Enter');
  await expect(page.getByText('协调助手正在处理')).toBeVisible();

  await context.setOffline(true);
  await page.waitForTimeout(800);
  await context.setOffline(false);

  await expect(page.getByText('处理完成')).toBeVisible();
  await expect(page.getByText(text, { exact: true })).toHaveCount(1);
  const currentMessage = page.locator('article.chat-row.user').filter({ hasText: text });
  await expect(currentMessage).toHaveCount(1);
  await expect(currentMessage.locator('xpath=following-sibling::article[1]'))
    .toContainText('Fake 协调助手已处理当前消息。');
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
    serverRequest = request.post('http://127.0.0.1:4317/api/assistant/turns', {
      data: route.request().postDataJSON(),
    });
    await route.abort('failed');
  });
  await page.route('**/api/assistant/commands/*', async (route) => {
    commandQueries += 1;
    await route.continue();
  });

  const text = 'expired cursor 恢复后的唯一消息';
  const draft = page.getByLabel('协调助手草稿');
  await draft.fill(text);
  await draft.press('Enter');
  await expect(page.getByText('协调助手正在处理')).toBeVisible();

  await context.setOffline(true);
  await page.waitForTimeout(800);
  await page.goto('about:blank');
  expireNextConnection = true;
  await context.setOffline(false);
  await page.goBack();

  await expect(page.getByText('处理完成')).toBeVisible();
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
    serverRequest = request.post('http://127.0.0.1:4317/api/assistant/turns', {
      data: route.request().postDataJSON(),
    });
    await route.abort('failed');
  });

  const draft = page.getByLabel('协调助手草稿');
  await draft.fill(text);
  await expect(page.getByText('草稿保存失败：网络连接不可用，请重试。')).toBeVisible();
  await draft.press('Enter');
  await expect(page.getByText('处理完成')).toBeVisible();
  await expect(draft).toHaveValue('');
  await expect(page.locator('.save-error')).toHaveCount(0);
  await expect(page.getByText('草稿已保存')).toBeVisible();
  expect((await serverRequest)?.ok()).toBe(true);
});

test('移动端运行状态、行为选择和 composer 不重叠', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const draft = page.getByLabel('协调助手草稿');
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
});
