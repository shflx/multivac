import { test, expect } from '@playwright/test';
import { fakeApiRoot, resetE2eState, openPanel, openCreationDialog } from './test-state.js';

test('工作会话并行委派、完成卡片及只读完整抽屉，运行和用量归属可见', async ({ page, request }) => {
  await resetE2eState(request);
  const agent = await request.post(`${fakeApiRoot}/api/agents`, { data: { commandId: crypto.randomUUID(), name: '独立核对', description: '适合自包含的检查，不适合授权或外发', delegable: true, instructions: '返回简短结论。' } });
  expect(agent.ok()).toBe(true);
  const { agent: { agentId } } = await agent.json();
  await page.goto('/'); await expect(page.getByLabel('Multivac 草稿')).toBeEditable();
  await openPanel(page, 'workspace'); await openCreationDialog(page);
  const creation = page.getByRole('dialog', { name: '创建新会话' });
  await creation.getByLabel('会话名称').fill('委派验证'); await creation.getByRole('button', { name: '创建', exact: true }).click();
  const panel = page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: '委派验证', exact: true }) });
  const draft = panel.getByLabel('Multivac 草稿');
  const sessionId = await panel.getAttribute('data-session-id');
  const delegate = (reason: string, extra = {}) => '内部工具：delegate_to_subagent ' + JSON.stringify({ agentId, mode: 'read', goal: reason, context: '仅处理本次给出的资料。', deliverable: '给出结论', reason, ...extra });
  await draft.fill([delegate('核对两个来源'), delegate('检查重复内容')].join('\n'));
  await panel.getByRole('button', { name: '发送消息', exact: true }).click();
  const cards = panel.locator('.subagent-open');
  await expect(cards).toHaveCount(2);
  await expect(panel.locator('.subagent-item.succeeded')).toHaveCount(2);
  await cards.first().click();
  const drawer = page.getByRole('dialog', { name: '子智能体只读过程' });
  await expect(drawer).toContainText('完整过程'); await expect(drawer).toContainText('来自 委派验证');
  await expect(drawer.locator('textarea,input,[contenteditable=true]')).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: '发送消息' })).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(drawer).toHaveCount(0);
  await expect(cards.first()).toBeFocused();
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/subagents?parentSessionId=${sessionId}`)).json()).items.length).toBe(2);
  const sessions = await (await request.get(`${fakeApiRoot}/api/sessions`)).json();
  const runs = await (await request.get(`${fakeApiRoot}/api/subagents?parentSessionId=${sessionId}`)).json();
  expect(runs.items.every((item: any) => !JSON.stringify(sessions).includes(item.sessionId))).toBe(true);
  await draft.fill(delegate('运行局部检查', { mode: 'execute', writeScope: ['report.txt'], context: 'bash执行：' + JSON.stringify({ command: "printf '独立完整工具输出'", timeout: 5 }) }));
  await panel.getByRole('button', { name: '发送消息', exact: true }).click();
  const execute = panel.getByRole('button', { name: '查看子智能体过程：运行局部检查' });
  await expect(execute).toBeVisible();
  await expect(panel.locator('.subagent-item.succeeded')).toHaveCount(3);
  await execute.click(); await expect(drawer).toContainText('bash · 输出'); await expect(drawer.locator('.subagent-process-entry.tool').last()).toContainText('独立完整工具输出');
  await page.screenshot({ path: 'artifacts/subagent-drawer-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(drawer).toBeVisible();
  expect(await drawer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/subagent-drawer-narrow.png' });
  await drawer.getByRole('button', { name: '关闭子智能体过程' }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.app-shell')).not.toHaveClass(/narrow/);
  await page.getByRole('banner').getByRole('button', { name: '快捷键', exact: true }).focus();
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '运行', exact: true }).click();
  const runPanel = page.getByRole('region', { name: '子智能体运行' });
  await expect(runPanel).toContainText('委派验证'); await expect(runPanel.getByRole('button', { name: '查看子智能体过程：运行局部检查' })).toBeVisible();
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '统计', exact: true }).click();
  await expect(page.locator('.usage-page')).toContainText('子智能体用量');
  await expect(page.locator('.usage-page')).toContainText('委派验证');
});

test('任务详情和任务会话时间线展示两个委派及独立只读过程', async ({ page, request }) => {
  await resetE2eState(request);
  const createdAgent = await (await request.post(`${fakeApiRoot}/api/agents`, { data: { commandId: crypto.randomUUID(), name: '任务独立检查', description: '适合独立分析，不适合外发', delegable: true, instructions: '' } })).json();
  const goal = ['接口核对', '文档核对'].map(reason => '内部工具：delegate_to_subagent ' + JSON.stringify({ agentId: createdAgent.agent.agentId, mode: 'read', goal: reason, reason, context: '仅当前资料', deliverable: '简短结论' })).join('\n');
  const { task } = await (await request.post(`${fakeApiRoot}/api/tasks`, { data: { commandId: crypto.randomUUID(), title: '任务委派验证', goal } })).json();
  expect((await request.post(`${fakeApiRoot}/api/tasks/${task.taskId}/control`, { data: { commandId: crypto.randomUUID(), revision: task.revision, action: 'start' } })).ok()).toBe(true);
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/subagents?taskId=${task.taskId}`)).json()).items.filter((item: any) => item.status === 'succeeded').length).toBe(2);
  await page.goto('/'); await expect(page.getByRole('button', { name: '快捷键', exact: true })).toBeVisible();
  await openPanel(page, 'management'); await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '待办', exact: true }).click();
  await page.getByRole('button', { name: `查看任务：${task.title}`, exact: true }).click();
  let relationReads = 0;
  page.on('request', request => { if (request.url().includes('/relations?') || request.url().includes('/api/tasks?parentTaskId=')) relationReads++; });
  const inspector = page.getByRole('complementary', { name: '任务详情' });
  await expect(inspector.locator('.subagent-open')).toHaveCount(2);
  await inspector.getByRole('button', { name: `打开任务会话：${task.title}`, exact: true }).click();
  const timeline = page.getByRole('region', { name: '任务会话视图' });
  await expect(timeline.locator('.subagent-open')).toHaveCount(2);
  await timeline.locator('.subagent-open').first().click();
  const drawer = page.getByRole('dialog', { name: '子智能体只读过程' });
  await expect(drawer).toContainText('任务执行'); await expect(drawer).toContainText('完整过程');
  await drawer.getByRole('button', { name: '关闭子智能体过程' }).click();
  // 委派区域与关系区域不能共用 key；查询结果写回缓存后应保留原组件。
  expect(relationReads).toBeLessThan(10);
});

test('真实重启中断执行子级并回收进程，原委派不重放，过程仍可读', async ({ page, request }) => {
  await resetE2eState(request);
  const { agent } = await (await request.post(`${fakeApiRoot}/api/agents`, { data: { commandId: crypto.randomUUID(), name: '重启独立检查', description: '适合运行检查，不适合外发', delegable: true, instructions: '' } })).json();
  const sessionId = crypto.randomUUID();
  expect((await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: '重启委派父级' } })).ok()).toBe(true);
  const text = '内部工具：delegate_to_subagent#restart-delegate ' + JSON.stringify({ agentId: agent.agentId, mode: 'execute', goal: '等待核对', reason: '重启停止验证', deliverable: '进程退出证据', context: 'bash执行：' + JSON.stringify({ command: 'node -e "setInterval(()=>{},1000)"', mode: 'foreground' }), writeScope: ['check.txt'] });
  const pending = request.post(`${fakeApiRoot}/api/sessions/${sessionId}/turns`, { data: { assistantSessionId: sessionId, commandId: 'restart-parent', text, contextRefs: [] } }).catch(() => null);
  let child: any;
  await expect.poll(async () => {
    const result = await (await request.get(`${fakeApiRoot}/api/subagents?parentSessionId=${sessionId}`)).json(); child = result.items[0];
    const processes = await (await request.get(`${fakeApiRoot}/api/processes?activeOnly=true`)).json();
    return child?.status === 'running' && processes.processes.some((process: any) => process.sessionId === child.sessionId && process.state === 'running' && process.pid);
  }).toBe(true);
  await page.goto('/'); await expect(page.getByRole('button', { name: '快捷键', exact: true })).toBeVisible();
  await openPanel(page, 'management'); await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.getByRole('region', { name: '子智能体运行' }).getByRole('button', { name: '查看子智能体过程：重启停止验证' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/subagent-running.png' });
  expect((await request.post(`${fakeApiRoot}/api/__e2e/restart`)).status()).toBe(202);
  let wentDown = false;
  await expect.poll(async () => {
    try { const response = await request.get(`${fakeApiRoot}/api/assistant/page-state`, { timeout: 500 }); if (!response.ok()) wentDown = true; return response.ok() && wentDown; }
    catch { wentDown = true; return false; }
  }, { timeout: 30000, intervals: [50, 100, 250] }).toBe(true);
  await pending;
  const after = await (await request.get(`${fakeApiRoot}/api/subagents?parentSessionId=${sessionId}`)).json();
  expect(after.items).toHaveLength(1); expect(after.items[0].id).toBe(child.id); expect(after.items[0].status).toBe('interrupted'); expect(after.items[0].summary).toContain('未自动重放');
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/subagents?parentSessionId=${sessionId}`)).json()).items[0].stopConfirmed, { timeout: 15000 }).toBe(true);
  const process = await (await request.get(`${fakeApiRoot}/api/subagents/${child.id}/process`)).json();
  expect(process.available).toBe(true); expect(process.items.some((item: any) => item.role === 'tool' && item.phase === 'input')).toBe(true);
});
