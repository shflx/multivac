import { expect, test } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

test('Inbox 抽屉共享持久草稿、查看计数、原位回执与窄屏焦点', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  const taskResponse = await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: 'inbox-create', title: '来源核对', goal: '核对资料' } });
  expect(taskResponse.ok()).toBeTruthy();
  const { task } = await taskResponse.json();
  const ask = await request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/requests`, { data: { commandId: 'inbox-ask', question: '采用哪份资料？' } });
  expect(ask.ok()).toBeTruthy();
  const { request: human } = await ask.json();
  const fresh = await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json();
  await request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/control`, { data: { commandId: 'inbox-pause', revision: fresh.task.revision, action: 'pause' } });
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Inbox，1 项待处理', exact: true });
  await expect(trigger).toBeVisible(); await trigger.click();
  const drawer = page.getByRole('dialog', { name: 'Inbox', exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('img', { name: '未查看', exact: true })).toHaveCount(1);
  await drawer.locator('.inbox-item').click();
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/inbox/${human.requestId}`)).json()).item.state.seen).toBe(true);
  await expect(trigger).toHaveText(/1/);
  await drawer.getByRole('textbox', { name: '澄清回应' }).fill('仅采用已授权项目资料');
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/inbox/${human.requestId}`)).json()).item.state.draft).toBe('仅采用已授权项目资料');
  await page.screenshot({ path: testInfo.outputPath('inbox-desktop.png'), animations: 'disabled' });
  await drawer.getByRole('button', { name: '展开到管理', exact: true }).click();
  await expect(drawer).not.toBeVisible();
  const management = page.getByRole('main', { name: 'Inbox', exact: true });
  await expect(management.getByRole('textbox', { name: '澄清回应' })).toHaveValue('仅采用已授权项目资料');
  await page.screenshot({ path: testInfo.outputPath('inbox-management.png'), animations: 'disabled' });
  await trigger.click();
  await page.keyboard.press('Escape'); await expect(drawer).not.toBeVisible(); await expect(trigger).toBeFocused();
  await page.reload(); await trigger.click(); await drawer.locator('.inbox-item').click();
  await expect(drawer.getByRole('textbox', { name: '澄清回应' })).toHaveValue('仅采用已授权项目资料');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('inbox-narrow.png'), animations: 'disabled' });
  for (let index = 0; index < 12; index++) { await page.keyboard.press('Tab'); expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(true); }
  await drawer.getByRole('button', { name: '提交回应', exact: true }).click();
  await expect(drawer).toContainText('回应已保存');
  await expect(page.getByRole('button', { name: 'Inbox，0 项待处理', exact: true })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: '采用哪份资料？', exact: true })).toBeVisible();
  const updated = await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json();
  expect(updated.task.pauseSource).toBe('user'); expect(updated.task.currentRunId).toBe(null);
  await drawer.locator('.inbox-action-bar').getByRole('button', { name: '关闭 Inbox', exact: true }).click();
  await page.getByRole('button', { name: 'Inbox，0 项待处理', exact: true }).click();
  await expect(drawer).toContainText('全部处理完毕');
  await expect(drawer.getByRole('heading', { name: '采用哪份资料？', exact: true })).toHaveCount(0);
  await expect(drawer.locator('.inbox-decision-result')).toHaveCount(0);
});

test('Inbox 验收绑定工作会话完成说明并保留修改回执', async ({ page, request }) => {
  await resetE2eState(request);
  const sessionId = 'inbox-review';
  await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: '验收来源' } });
  const { task } = await (await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: 'review-create', title: '核对报告', goal: '核对证据', acceptance: true } })).json();
  await request.post(`${fakeApiRoot}/api/sessions/${sessionId}/turns`, { data: { commandId: 'review-report', assistantSessionId: sessionId, contextRefs: [], text: `内部工具：complete_task ${JSON.stringify({ taskId: task.taskId, revision: task.revision, summary: '报告已完成，需要用户核对来源日期。' })}` } });
  await page.goto('/'); await page.getByRole('button', { name: 'Inbox，1 项待处理', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Inbox', exact: true });
  await drawer.locator('.inbox-item').click();
  await expect(drawer).toContainText('没有后台运行或文件成果自检证据');
  await drawer.getByRole('button', { name: '提出修改', exact: true }).click();
  await expect(drawer.getByRole('button', { name: '提交修改意见', exact: true })).toBeDisabled();
  await drawer.getByRole('textbox', { name: '修改意见' }).fill('补充来源日期');
  await drawer.getByRole('button', { name: '提交修改意见', exact: true }).click();
  await expect(drawer).toContainText('回应已保存：补充来源日期');
  const detail = await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json();
  expect(detail.task.status).toBe('paused'); expect(detail.task.pauseSource).toBe('user');
});

test('Inbox 恢复重做使用新会话并保留真实目录变更', async ({ page, request }) => {
  test.skip(process.platform !== 'darwin', '后台隔离仅在 macOS 验证');
  await resetE2eState(request);
  const { task } = await (await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: 'recovery-create', title: '恢复现场', goal: '核对旧目录' } })).json();
  await request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/control`, { data: { commandId: 'recovery-start', revision: 1, action: 'start' } });
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).runs[0]?.stopConfirmed).toBe(true);
  const before = await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json();
  const original = before.runs[0]; const path = join(original.directory.path, 'preserved.txt');
  writeFileSync(path, '已有用户变更');
  expect((await request.post(`${fakeApiRoot}/api/__e2e/inbox/recovery`, { data: { taskId: task.taskId } })).ok()).toBeTruthy();
  await page.goto('/'); await page.getByRole('button', { name: 'Inbox，1 项待处理', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Inbox', exact: true }); await drawer.locator('.inbox-item').click();
  await expect(drawer.getByRole('button', { name: '确认恢复方式', exact: true })).toBeDisabled();
  await drawer.getByRole('radio', { name: /从安全起点重新执行/ }).check();
  await drawer.getByRole('button', { name: '确认恢复方式', exact: true }).click();
  await expect(drawer).toContainText('回应已保存');
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).runs.length).toBe(2);
  const after = await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json();
  expect(after.runs[0].sessionId).not.toBe(original.sessionId); expect(readFileSync(path, 'utf8')).toBe('已有用户变更');
});

test('Inbox 外发展示固定提交，拒绝后保留本地成果且不发布', async ({ page, request }) => {
  await resetE2eState(request);
  const sessionId = 'inbox-publish';
  await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: '发布来源' } });
  const { sessions } = await (await request.get(`${fakeApiRoot}/api/sessions?workspace=all&archived=include`)).json();
  const cwd = sessions.find((session: { sessionId: string }) => session.sessionId === sessionId).workingDirectory.path;
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); writeFileSync(join(cwd, 'publish.txt'), '固定发布成果'); git('add', '.'); git('-c', 'user.name=测试', '-c', 'user.email=test@example.invalid', 'commit', '-qm', '待发布成果');
  git('remote', 'add', 'origin', 'https://example.invalid/inbox.git');
  const commit = git('rev-parse', 'HEAD');
  await request.post(`${fakeApiRoot}/api/sessions/${sessionId}/turns`, { data: { commandId: 'publish-propose', assistantSessionId: sessionId, contextRefs: [], text: '内部工具：propose_git_publish {"remote":"origin","branch":"inbox-test"}' } });
  await page.goto('/'); await page.getByRole('button', { name: 'Inbox，1 项待处理', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Inbox', exact: true }); await drawer.locator('.inbox-item').click();
  await expect(drawer).toContainText(commit); await expect(drawer).toContainText('https://example.invalid/inbox.git');
  await drawer.getByRole('button', { name: '拒绝发布', exact: true }).click();
  await expect(drawer).toContainText('用户拒绝，未执行发布');
  expect(readFileSync(join(cwd, 'publish.txt'), 'utf8')).toBe('固定发布成果');
});

test('普通会话授权在多窗口 Inbox 同步，来源跳转不另建请求', async ({ page, context, request }) => {
  await resetE2eState(request);
  const sessionId = 'inbox-auth-session';
  expect((await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: 'Inbox 来源会话' } })).ok()).toBeTruthy();
  const send = request.post(`${fakeApiRoot}/api/sessions/${sessionId}/turns`, { data: { commandId: 'inbox-outside', assistantSessionId: sessionId, text: '越界写入场景', contextRefs: [] }, timeout: 20000 });
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/inbox`)).json()).pendingCount).toBe(1);
  const { items } = await (await request.get(`${fakeApiRoot}/api/inbox`)).json();
  expect(items[0].taskId).toBe(null); expect(existsSync(items[0].authorization.targetPath)).toBe(false);
  const other = await context.newPage();
  try {
    await page.goto('/'); await other.goto('/');
    for (const window of [page, other]) {
      await window.getByRole('button', { name: 'Inbox，1 项待处理', exact: true }).click();
      await window.getByRole('dialog', { name: 'Inbox', exact: true }).locator('.inbox-item').click();
    }
    const drawer = page.getByRole('dialog', { name: 'Inbox', exact: true });
    await drawer.locator('.inbox-supporting-details summary').click();
    await expect(drawer.getByRole('button', { name: '返回来源会话', exact: true })).toBeVisible();
    await expect(drawer.getByRole('radio', { name: /仅这一次/ })).toBeChecked();
    await drawer.getByRole('button', { name: '允许并继续', exact: true }).click();
    expect((await send).ok()).toBeTruthy();
    expect(existsSync(items[0].authorization.targetPath)).toBe(true);
    await expect(other.getByRole('button', { name: 'Inbox，0 项待处理', exact: true })).toBeVisible();
    await expect(other.getByRole('dialog', { name: 'Inbox', exact: true })).toContainText('已批准');
    await drawer.getByRole('button', { name: '返回来源会话', exact: true }).click();
    await expect(drawer).not.toBeVisible();
    await expect(page.locator('.conversation-panel:visible')).toContainText('Inbox 来源会话');
  } finally { await other.close(); await send.catch(() => undefined); }
});


test('Inbox 长证据独立滚动，选择随展开保留，默认首项处理后不跳到下一项', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  const requests = [];
  for (const [index, question] of ['核对资料引用范围', '核对另一项资料'].entries()) {
    const { task } = await (await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: `layout-task-${index}`, title: `布局来源 ${index}`, goal: '核对资料范围' } })).json();
    const response = await request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/requests`, { data: { commandId: `layout-ask-${index}`, question } });
    expect(response.ok()).toBeTruthy();
    requests.push((await response.json()).request);
  }
  // 补充合同允许的长范围证据以覆盖布局；查看、草稿和回应仍交给真实服务处理。
  await page.route(url => url.pathname.startsWith('/api/inbox'), async route => {
    const response = await route.fetch();
    const payload = await response.json();
    for (const item of payload.items ?? (payload.item ? [payload.item] : [])) {
      if (item.id === requests[0].requestId) item.human.clarificationScope = {
        materials: Array.from({ length: 10 }, (_, index) => `资料 ${index + 1}：${'需要核对来源的项目资料'.repeat(6)}`),
        scope: '仅引用明确列出的项目资料摘要', purpose: '核对结论与原始资料的一致性',
        evidence: '资料内容仅用于当前请求，先核对来源与限制。'.repeat(35),
      };
    }
    await route.fulfill({ response, json: payload });
  });
  await page.goto('/');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Inbox，2 项待处理', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Inbox', exact: true });
  await drawer.locator('.inbox-item').filter({ hasText: '核对资料引用范围' }).click();
  const submit = drawer.getByRole('button', { name: '确认并继续', exact: true });
  await expect(submit).toBeDisabled();
  const before = await submit.boundingBox();
  await drawer.getByRole('radio', { name: /指定其他范围/ }).check();
  await expect(submit).toBeDisabled();
  await drawer.getByRole('textbox', { name: '澄清回应' }).fill('仅采用已授权资料摘要');
  await expect(submit).toBeEnabled();
  await drawer.locator('.inbox-detail-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  expect(await submit.boundingBox()).toEqual(before);
  await expect(drawer.getByRole('heading', { name: '核对资料引用范围', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('inbox-long-evidence-narrow.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await drawer.getByRole('button', { name: '展开到管理', exact: true }).click();
  const management = page.getByRole('main', { name: 'Inbox', exact: true });
  await expect(management.getByRole('radio', { name: /指定其他范围/ })).toBeChecked();
  await expect(management.getByRole('textbox', { name: '澄清回应' })).toHaveValue('仅采用已授权资料摘要');
  await page.screenshot({ path: testInfo.outputPath('inbox-long-evidence-management.png'), animations: 'disabled' });
  // 重载让管理页按默认首项展示，不依赖用户曾点击列表来保留回执。
  await page.reload();
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: /^Inbox/ }).click();
  await expect(management.getByRole('button', { name: '确认并继续', exact: true })).toBeDisabled();
  await management.getByRole('radio', { name: /指定其他范围/ }).check();
  await expect(management.getByRole('textbox', { name: '澄清回应' })).toHaveValue('仅采用已授权资料摘要');
  await management.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(management).toContainText('回应已保存');
  await expect(management.getByRole('heading', { name: '核对资料引用范围', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Inbox，1 项待处理', exact: true })).toBeVisible();
  await management.getByRole('button', { name: '处理下一项：核对另一项资料', exact: true }).click();
  await expect(management.getByRole('heading', { name: '核对另一项资料', exact: true })).toBeVisible();
  await expect(management.getByRole('textbox', { name: '澄清回应' })).toBeEmpty();
});

test('Inbox 重新进入管理页只显示剩余待处理事项，全部处理后显示空状态', async ({ page, request }) => {
  await resetE2eState(request);
  const questions = ['重新进入前已处理的问题', '重新进入后剩余的问题'];
  for (const [index, question] of questions.entries()) {
    const created = await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: `reenter-task-${index}`, title: `重新进入来源 ${index}`, goal: '核对资料' } });
    expect(created.ok()).toBeTruthy();
    const { task } = await created.json();
    expect((await request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/requests`, { data: { commandId: `reenter-ask-${index}`, question } })).ok()).toBeTruthy();
  }
  await page.goto('/');
  await page.getByRole('button', { name: 'Inbox，2 项待处理', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Inbox', exact: true });
  await drawer.locator('.inbox-item').filter({ hasText: questions[0] }).click();
  await drawer.getByRole('textbox', { name: '澄清回应' }).fill('第一项已回应');
  await drawer.getByRole('button', { name: '提交回应', exact: true }).click();
  await expect(drawer).toContainText('回应已保存：第一项已回应');
  await expect(page.getByRole('button', { name: 'Inbox，1 项待处理', exact: true })).toBeVisible();
  // 从抽屉展开仍保留当下回执；离开后重新进入才选择剩余事项。
  await drawer.getByRole('button', { name: '展开到管理', exact: true }).click();
  const management = page.getByRole('main', { name: 'Inbox', exact: true });
  await expect(management).toContainText('回应已保存：第一项已回应');
  await expect(management.getByRole('heading', { name: questions[0], exact: true })).toBeVisible();
  const navigation = page.getByRole('complementary', { name: '管理导航' });
  const enterInbox = () => navigation.getByRole('button', { name: /^Inbox/ }).click();
  await navigation.getByRole('button', { name: '待办', exact: true }).click();
  await enterInbox();
  await expect(management.getByRole('heading', { name: questions[0], exact: true })).toHaveCount(0);
  await expect(management.getByRole('heading', { name: questions[1], exact: true })).toBeVisible();
  await expect(management.locator('.inbox-decision-result')).toHaveCount(0);
  await management.getByRole('textbox', { name: '澄清回应' }).fill('第二项已回应');
  await management.getByRole('button', { name: '提交回应', exact: true }).click();
  await expect(management).toContainText('回应已保存：第二项已回应');
  await navigation.getByRole('button', { name: '待办', exact: true }).click();
  await enterInbox();
  await expect(management).toContainText('全部处理完毕');
  await expect(management.locator('.inbox-item')).toHaveCount(0);
  await expect(management.locator('.inbox-decision-result')).toHaveCount(0);
  await expect(management.getByRole('heading', { name: questions[1], exact: true })).toHaveCount(0);
});
