import { test, expect } from '@playwright/test';
import { fakeApiRoot, resetE2eState, openPanel } from './test-state.js';

test('运行页只显示活跃任务会话，排队不占列表，暂停后移出并同步空状态', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  const create = async (commandId: string, title: string, dependencyIds: string[] = []) => {
    const response = await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId, title, goal: '核对来源', dependencyIds } });
    expect(response.ok()).toBeTruthy(); return (await response.json()).task;
  };
  const dependency = await create('runs-dep', '未完成的前置');
  const queued = await create('runs-queued', '等待前置的任务', [dependency.taskId]);
  await request.post(`${fakeApiRoot}/api/tasks/${queued.taskId}/control`, { data: { commandId: 'runs-queue', revision: queued.revision, action: 'start' } });
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '运行', exact: true }).click();
  const section = page.getByRole('region', { name: '任务会话', exact: true });
  await expect(section.locator('.run-row')).toHaveCount(0);
  await expect(section.getByRole('heading', { name: '没有正在运行的任务会话' })).toBeVisible();
  const idle = page.getByRole('button', { name: /^空闲：/ });
  await idle.click();
  const popover = page.getByRole('dialog', { name: '运行状态', exact: true });
  await expect(popover.locator('header')).toHaveText('空闲');
  await expect(popover.getByText('没有运行中的任务会话或进程。', { exact: true })).toHaveCount(1);
  await popover.screenshot({ path: testInfo.outputPath('run-popover-idle.png'), animations: 'disabled' });
  await page.keyboard.press('Escape'); await expect(idle).toBeFocused();
  const queuedNow = (await (await request.get(`${fakeApiRoot}/api/tasks/${queued.taskId}`)).json()).task;
  expect((await request.post(`${fakeApiRoot}/api/tasks/${queued.taskId}/control`, { data: { commandId: 'runs-queue-cleanup', revision: queuedNow.revision, action: 'cancel' } })).ok()).toBeTruthy();
  await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`);
  const task = await create('runs-task', '核对很长的运行任务名称与执行事实，保留可读的任务标题和准确的状态说明');
  await request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/control`, { data: { commandId: 'runs-start', revision: task.revision, action: 'start' } });
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).task.status).toBe('running');
  await expect(section.locator('.run-row')).toHaveCount(1);
  await expect(section.getByRole('button', { name: task.title, exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('runs-1440.png') });
  await page.setViewportSize({ width: 1120, height: 740 });
  await expect(section.getByRole('button', { name: '暂停', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('runs-1120.png') });
  await section.getByRole('button', { name: '暂停', exact: true }).click();
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).runs[0].stopIntent).toBe('pause');
  await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`);
  await expect(section.locator('.run-row')).toHaveCount(0);
  await expect(section.getByRole('heading', { name: '没有正在运行的任务会话' })).toBeVisible();
  expect((await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).task.status).toBe('paused');
  await expect(page.getByRole('button', { name: /^空闲：/ })).toBeVisible();
});

test('独立进程在任务结束后保留，对话查询与用户确认停止复用同一事实', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`);
  const task = (await (await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: 'retained-task', title: '独立进程来源', goal: '保留后台服务' } })).json()).task;
  await request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/control`, { data: { commandId: 'retained-start', revision: task.revision, action: 'start' } });
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).task.status).toBe('running');
  const item = await (await request.post(`${fakeApiRoot}/api/__e2e/managed-process`, { data: { taskId: task.taskId, required: false } })).json();
  await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`);
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).task.status).toBe('waiting');
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^运行中：.*1 个进程/ })).toBeVisible();
  const draft = page.getByLabel('Multivac 草稿');
  await draft.fill(`查询并停止这个进程\n内部工具：list_runs#query-runs {}\n内部工具：list_managed_processes#query-processes {}\n内部工具：propose_stop_managed_process#stop-retained ${JSON.stringify({ processId: item.processId })}`);
  await draft.press('Enter');
  const card = page.locator('.proposal-card[data-tool-call-id="stop-retained"]');
  await expect(card.getByRole('button', { name: '仍然停止' })).toBeVisible();
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/processes`)).json()).processes[0].state).toBe('running');
  await page.screenshot({ path: testInfo.outputPath('process-proposal.png'), animations: 'disabled' });
  await card.getByRole('button', { name: '仍然停止' }).click();
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/processes`)).json()).processes[0].state).toBe('exited');
});

test('真实后台进程日志、影响确认取消与停止，跨窗口同步', async ({ page, context, request }, testInfo) => {
  await resetE2eState(request);
  await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/arm`);
  const created = await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: 'process-task', title: '后台进程来源', goal: '验证后台日志' } });
  const task = (await created.json()).task;
  await request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/control`, { data: { commandId: 'process-start', revision: task.revision, action: 'start' } });
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/tasks/${task.taskId}`)).json()).task.status).toBe('running');
  const start = await request.post(`${fakeApiRoot}/api/__e2e/managed-process`, { data: { taskId: task.taskId } });
  expect(start.ok()).toBeTruthy();
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '运行', exact: true }).click();
  const section = page.getByRole('region', { name: '后台进程', exact: true });
  await expect(section.getByText('真实测试后台进程', { exact: true })).toBeVisible();
  await section.getByRole('button', { name: '日志', exact: true }).click();
  await expect(section.locator('pre')).toContainText('真实日志追加');
  await expect(section.locator('pre')).toContainText('<script>not-executed</script>');
  await expect(section.locator('pre')).not.toContainText('must-hide');
  await expect(section.locator('script')).toHaveCount(0);
  await section.getByRole('button', { name: '停止', exact: true }).click();
  const confirm = section.getByRole('alert', { name: '停止「真实测试后台进程」', exact: true });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await expect(page.getByRole('dialog', { name: '停止「真实测试后台进程」' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('process-confirm.png'), animations: 'disabled' });
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(section.getByRole('button', { name: '停止', exact: true })).toBeEnabled();
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/processes`)).json()).processes[0].state).toBe('running');
  await section.getByRole('button', { name: '停止', exact: true }).click();
  await expect(confirm.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(section.getByRole('button', { name: '停止', exact: true })).toBeFocused();
  await expect(page.getByRole('heading', { name: '运行', exact: true })).toBeVisible();
  const other = await context.newPage(); await other.goto('/'); await openPanel(other, 'management');
  await other.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '运行', exact: true }).click();
  await section.getByRole('button', { name: '停止', exact: true }).click();
  const commandIds: string[] = [];
  await page.route('**/api/processes/*/stop', async (route) => {
    commandIds.push(route.request().postDataJSON().commandId);
    if (commandIds.length === 1) { await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await request.post(`${fakeApiRoot}/api/__e2e/events/disconnect`);
  await confirm.getByRole('button', { name: '仍然停止', exact: true }).click();
  await expect(confirm.getByRole('alert')).toBeVisible();
  await confirm.getByRole('button', { name: '仍然停止', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  expect(commandIds).toHaveLength(2);
  expect(commandIds[0]).toBe(commandIds[1]);
  await expect(section.locator('.process-row')).toHaveCount(0);
  await expect(other.getByRole('region', { name: '后台进程', exact: true }).locator('.process-row')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('process-exited.png'), animations: 'disabled' });
  await request.post(`${fakeApiRoot}/api/__e2e/assistant/prompt-completion/release`);
  await other.close();
});

test('运行页对齐原型的四列、异常标记和深色日志，侧栏展开按可用宽度排版', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  const now = new Date().toISOString();
  const items = [
    { title: '重建知识库索引', state: 'running', anomaly: true, reason: '索引进程 25 分钟没有新进展', elapsedMs: 52 * 60000, lastTool: '运行 build-index.sh' },
    { title: '执行中断的代码修改', state: 'recovery', anomaly: true, reason: '上次关闭时命令状态不明确', elapsedMs: 31 * 60000, lastTool: '运行 apply-patch' },
    { title: '检查构建环境', state: 'failed', anomaly: true, reason: '构建失败：缺少演示环境的 TypeScript 配置', elapsedMs: 4000, lastTool: null },
    { title: '整理 MVP 原型范围', state: 'running', anomaly: false, reason: '整理页面状态与交互说明', elapsedMs: 18 * 60000, lastTool: '读取 .my-docs/mvp.html' },
    { title: '梳理授权边界', state: 'running', anomaly: false, reason: '补齐权限提示文案', elapsedMs: 11 * 60000, lastTool: '编辑 permission-copy.md' },
    { title: '验证命令隔离', state: 'running', anomaly: false, reason: '核对探针结果', elapsedMs: 46 * 60000, lastTool: '运行 probe-isolation.sh' },
  ].map((item, index) => ({ ...item, taskId: `visual-task-${index}`, runId: `visual-run-${index}`, sessionId: `visual-session-${index}`, revision: 1,
    nextStep: '核对现场', startedAt: new Date(Date.now() - item.elapsedMs).toISOString(), endedAt: item.state === 'running' ? null : now,
    lastToolAt: item.lastTool ? new Date(Date.now() - 60000).toISOString() : null, canPause: !item.anomaly, taskAvailable: true, sessionAvailable: true,
  }));
  await page.route('**/api/runs?**', route => route.fulfill({ json: { version: 1, observedAt: now, items: items.filter(item => item.state === 'running'), highlights: items.filter(item => item.state === 'running'),
    total: 4, nextOffset: null, counts: { running: 4, queued: 0, anomalies: 1, waiting: 0, processesRunning: 1, processesRecovery: 0 },
  } }));
  await page.route('**/api/processes?**', route => route.fulfill({ json: { total: 1, nextOffset: null, processes: [{
    processId: 'visual-process', taskId: 'visual-task-3', runId: 'visual-run-3', sessionId: 'visual-session-3', revision: 1,
    name: '原型开发服务', command: 'node preview.cjs --port 5173', state: 'running', requiredWhileRunning: true,
    startedAt: new Date(Date.now() - 42 * 60000).toISOString(), endedAt: null, port: 5173, exitCode: null,
    reason: '执行中', taskTitle: '整理 MVP 原型范围', taskAvailable: true, taskRunning: true,
  }] } }));
  await page.route('**/api/processes/visual-process/logs?**', route => route.fulfill({ json: {
    text: '14:05:12  预览服务已启动\n14:05:12  http://localhost:5173/\n14:32:05  页面已更新\n', cursor: 100, available: true, unchanged: false, truncated: false,
  } }));
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '运行', exact: true }).click();
  const runs = page.locator('.runs-page');
  await expect(runs.locator('.run-row')).toHaveCount(4);
  await expect(runs.locator('.runs-intro')).toHaveCount(0);
  await expect(runs.locator('.run-stalled').first()).toHaveText('疑似无进展');
  await expect(runs.getByText('检查构建环境', { exact: true })).toHaveCount(0);
  await expect(runs.getByText('执行中断的代码修改', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('runs-aligned-1440.png'), animations: 'disabled' });

  const indicator = page.locator('.run-indicator');
  await expect(indicator).toHaveText('需要留意');
  await indicator.click();
  const popover = page.getByRole('dialog', { name: '运行状态', exact: true });
  await expect(popover.getByRole('region', { name: '异常', exact: true }).locator('.run-state-badge')).toHaveCount(1);
  await expect(popover.getByRole('region', { name: '执行中', exact: true }).locator('.run-state-badge')).toHaveCount(3);
  await expect(popover.getByRole('button', { name: /重建知识库索引/ })).toHaveCount(1);
  await expect(popover.locator('header')).not.toContainText('0 个');
  await page.screenshot({ path: testInfo.outputPath('run-popover-aligned.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(indicator).toBeFocused();

  const process = page.getByRole('region', { name: '后台进程', exact: true });
  await process.getByRole('button', { name: '日志', exact: true }).click();
  await expect(process.locator('pre')).toContainText('页面已更新');
  const colors = await process.locator('pre').evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color, height: element.clientHeight };
  });
  expect(colors.background).toBe('rgb(27, 32, 35)');
  expect(colors.color).toBe('rgb(238, 241, 243)');
  expect(colors.height).toBeLessThanOrEqual(160);
  await expect(process.getByRole('button', { name: '日志', exact: true })).toHaveClass(/active/);
  await page.screenshot({ path: testInfo.outputPath('process-log-aligned.png'), animations: 'disabled' });

  await page.setViewportSize({ width: 1120, height: 900 });
  await expect(runs.getByRole('button', { name: '暂停', exact: true }).first()).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('runs-aligned-1120.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press('ControlOrMeta+J');
  await expect(page.locator('.multivac-sidebar')).toBeVisible();
  const row = runs.locator('.run-row').last();
  await expect.poll(async () => {
    const facts = await row.locator('.run-row-facts').boundingBox();
    const main = await row.locator('.run-row-main').boundingBox();
    return !!facts && !!main && facts.y > main.y;
  }).toBe(true);
  await expect.poll(() => runs.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll('.run-row-actions')].every(row => row.getBoundingClientRect().right <= bounds.right + 1);
  })).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('runs-aligned-sidebar.png'), animations: 'disabled' });
});


test('只有后台进程时浮层显示进程名称、来源和端口，无空白夹层和双分隔线', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  await page.route('**/api/runs?**', route => route.fulfill({ json: {
    version: 1, observedAt: new Date().toISOString(), items: [], highlights: [], total: 0, nextOffset: null,
    counts: { running: 0, queued: 0, anomalies: 0, waiting: 0, processesRunning: 1, processesRecovery: 0 },
  } }));
  await page.route('**/api/processes?**', route => route.fulfill({ json: { total: 1, nextOffset: null, processes: [{
    processId: 'process-only', taskId: null, runId: null, sessionId: 'prototype-session', revision: 1,
    mode: 'background', name: 'UI 原型 · 25173', command: 'node vite.js --port 25173', state: 'running', requiredWhileRunning: false,
    startedAt: new Date().toISOString(), endedAt: null, port: 25173, exitCode: null, reason: '运行中',
    sessionTitle: '原型', sessionAvailable: true, taskTitle: null, taskAvailable: false, taskRunning: false,
  }] } }));
  await page.goto('/');
  const indicator = page.getByRole('button', { name: /^运行中：1 个进程/ });
  await indicator.click();
  const popover = page.getByRole('dialog', { name: '运行状态', exact: true });
  await expect(popover.getByRole('button', { name: /UI 原型 · 25173/ })).toBeVisible();
  await expect(popover.getByText('原型 · 端口 25173')).toBeVisible();
  await expect(popover.locator('.run-popover-empty')).toHaveCount(0);
  expect(await popover.locator('header').evaluate(node => getComputedStyle(node).borderBottomWidth)).toBe('0px');
  expect(await popover.locator('footer').evaluate(node => getComputedStyle(node).marginTop)).toBe('0px');
  await page.screenshot({ path: testInfo.outputPath('run-popover-process-only.png'), animations: 'disabled' });
  await popover.screenshot({ path: testInfo.outputPath('run-popover-process-only-detail.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1120, height: 740 });
  await expect(popover).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('run-popover-process-only-1120.png'), animations: 'disabled' });
  await page.keyboard.press('Escape'); await expect(indicator).toBeFocused();
});
