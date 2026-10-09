import { test, expect, type APIRequestContext } from '@playwright/test';
import { fakeApiRoot, resetE2eState, openPanel } from './test-state.js';

async function createSession(request: APIRequestContext, sessionId: string, title: string) {
  const response = await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title } });
  expect(response.ok()).toBeTruthy();
}
async function send(request: APIRequestContext, sessionId: string, commandId: string, text: string, wait = true) {
  const response = await request.post(`${fakeApiRoot}/api/sessions/${sessionId}/turns`, { data: { commandId, assistantSessionId: sessionId, text, contextRefs: [] } });
  expect(response.ok()).toBeTruthy();
  if (wait) await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/sessions/${sessionId}/commands/${commandId}`)).json()).status).toBe('terminal');
}
const script = 'node -e \'console.log("bash-background-ready");require("node:http").createServer((q,r)=>r.end("managed")).listen(0,"127.0.0.1")\'';
async function start(request: APIRequestContext, sessionId: string, commandId: string, name: string, timeout?: number) {
  await send(request, sessionId, commandId, `bash执行：${JSON.stringify({ command: script, mode: 'background', name, ...(timeout === undefined ? {} : { timeout }) })}`);
  const list = await (await request.get(`${fakeApiRoot}/api/processes`)).json();
  const process = list.processes.find((item: { name: string }) => item.name === name);
  expect(process).toBeTruthy(); expect(process.taskId).toBeNull(); expect(process.executionId).toBe(commandId);
  return process;
}

test('工作会话后台 bash 在回复结束后保留，运行页来源、日志、跳转和单进程停止共享事实', async ({ page, request }) => {
  await resetE2eState(request);
  const sessionId = 'bash-ui-session'; await createSession(request, sessionId, '原型开发');
  const process = await start(request, sessionId, 'bash-ui-start', 'UI 原型服务', 1);
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '运行', exact: true }).click();
  const row = page.locator(`[data-process-id="${process.processId}"]`);
  await expect(row.getByText('UI 原型服务', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: '原型开发', exact: true })).toBeVisible();
  await row.getByRole('button', { name: '日志', exact: true }).click();
  await expect(row.locator('pre')).toContainText('bash-background-ready');
  await page.waitForTimeout(1200);
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/processes`)).json()).processes.find((item: { processId: string }) => item.processId === process.processId).port).toBeTruthy();
  const observed = (await (await request.get(`${fakeApiRoot}/api/processes`)).json()).processes.find((item: { processId: string }) => item.processId === process.processId);
  expect((await request.get(`http://127.0.0.1:${observed.port}/`)).status()).toBe(200);
  await row.getByRole('button', { name: '原型开发', exact: true }).click();
  await expect(page.locator('.conversation-panel:visible')).toContainText('原型开发');
  expect((await (await request.get(`${fakeApiRoot}/api/processes`)).json()).processes.find((item: { processId: string }) => item.processId === process.processId).state).toBe('running');
  await send(request, sessionId, 'bash-ui-followup', '继续讨论');
  await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '运行', exact: true }).click();
  await row.getByRole('button', { name: '停止', exact: true }).click();
  await expect(row).toHaveCount(0);
});

test('结束会话运行行内确认取消与重试，清理该会话全部轮次且保留其他会话', async ({ page, request }) => {
  await resetE2eState(request);
  await createSession(request, 'bash-scope-a', '开发会话 A'); await createSession(request, 'bash-scope-b', '开发会话 B');
  const a1 = await start(request, 'bash-scope-a', 'bash-a1', '服务 A1');
  const a2 = await start(request, 'bash-scope-a', 'bash-a2', '服务 A2');
  const b = await start(request, 'bash-scope-b', 'bash-b1', '服务 B');
  await page.goto('/'); await openPanel(page, 'management');
  await page.getByRole('complementary', { name: '管理导航' }).getByRole('button', { name: '运行', exact: true }).click();
  const row = page.locator(`[data-process-id="${a1.processId}"]`);
  await row.getByRole('button', { name: '结束会话运行', exact: true }).click();
  const confirm = row.getByRole('alert', { name: '停止「开发会话 A」', exact: true });
  await expect(confirm.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(confirm).toHaveCount(0);
  expect((await (await request.get(`${fakeApiRoot}/api/processes`)).json()).processes.filter((item: { state: string }) => item.state === 'running')).toHaveLength(3);
  await row.getByRole('button', { name: '结束会话运行', exact: true }).click();
  const commandIds: string[] = [];
  await page.route('**/api/processes/sessions/bash-scope-a/stop', async route => {
    commandIds.push(route.request().postDataJSON().commandId);
    if (commandIds.length === 1) { await route.fetch(); await route.abort('failed'); } else await route.continue();
  });
  await confirm.getByRole('button', { name: '结束会话运行', exact: true }).click();
  await expect(confirm.getByRole('alert')).toBeVisible();
  const later = await start(request, 'bash-scope-a', 'bash-a3', '停止响应丢失后新服务');
  await confirm.getByRole('button', { name: '结束会话运行', exact: true }).click();
  await expect(confirm).toHaveCount(0); expect(commandIds[0]).toBe(commandIds[1]);
  await expect(page.locator(`[data-process-id="${a2.processId}"]`)).toHaveCount(0);
  const list = (await (await request.get(`${fakeApiRoot}/api/processes`)).json()).processes;
  expect(list.find((item: { processId: string }) => item.processId === b.processId).state).toBe('running');
  expect(list.find((item: { processId: string }) => item.processId === later.processId).state).toBe('running');
});

test('停止当前轮次保留此前服务；归档、恢复后新服务、再次归档均清理真实会话进程', async ({ request }) => {
  await resetE2eState(request); await createSession(request, 'bash-cancel', '执行范围');
  const retained = await start(request, 'bash-cancel', 'bash-retained', '上一轮服务');
  const sending = send(request, 'bash-cancel', 'bash-current', `bash执行：${JSON.stringify({ command: 'node -e \'console.log("foreground-ready");setInterval(()=>{},1000)\'' })}`, false);
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/processes`)).json()).processes.some((item: { executionId: string; state: string }) => item.executionId === 'bash-current' && item.state === 'running')).toBeTruthy();
  const cancel = await request.post(`${fakeApiRoot}/api/sessions/bash-cancel/turns/current/cancel`, { data: { commandId: 'bash-cancel-current', assistantSessionId: 'bash-cancel' } });
  expect(cancel.ok()).toBeTruthy();
  await sending;
  await expect.poll(async () => (await (await request.get(`${fakeApiRoot}/api/sessions/bash-cancel/commands/bash-current`)).json()).status).toBe('terminal');
  const processes = (await (await request.get(`${fakeApiRoot}/api/processes`)).json()).processes;
  expect(processes.find((item: { processId: string }) => item.processId === retained.processId).state).toBe('running');
  expect(processes.some((item: { executionId: string; state: string }) => item.executionId === 'bash-current' && item.state === 'running')).toBeFalsy();
  const archive = await request.post(`${fakeApiRoot}/api/sessions/bash-cancel/archive`); expect(archive.ok()).toBeTruthy();
  const after = (await (await request.get(`${fakeApiRoot}/api/processes`)).json()).processes;
  expect(after.find((item: { processId: string }) => item.processId === retained.processId).state).toBe('exited');
  const restore = await request.post(`${fakeApiRoot}/api/sessions/bash-cancel/restore`); expect(restore.ok()).toBeTruthy();
  const restored = await start(request, 'bash-cancel', 'bash-restored', '恢复后的服务');
  const archiveAgain = await request.post(`${fakeApiRoot}/api/sessions/bash-cancel/archive`); expect(archiveAgain.ok()).toBeTruthy();
  const final = (await (await request.get(`${fakeApiRoot}/api/processes`)).json()).processes;
  expect(final.find((item: { processId: string }) => item.processId === restored.processId).state).toBe('exited');
});


test('对话停止工具只操作当前工作会话，单进程与全部会话停止都核对同一持久事实', async ({ request }) => {
  await resetE2eState(request);
  await createSession(request, 'bash-tools-a', '工具会话 A'); await createSession(request, 'bash-tools-b', '工具会话 B');
  const a = await start(request, 'bash-tools-a', 'tools-a1', '工具服务 A');
  const b = await start(request, 'bash-tools-b', 'tools-b1', '工具服务 B');
  const state = async (processId: string) => (await (await request.get(`${fakeApiRoot}/api/processes`)).json()).processes.find((item: { processId: string }) => item.processId === processId).state;
  await send(request, 'bash-tools-a', 'tools-forbidden', `内部工具：stop_managed_process ${JSON.stringify({ processId: b.processId })}`);
  expect(await state(b.processId)).toBe('running');
  await send(request, 'bash-tools-a', 'tools-single', `内部工具：stop_managed_process ${JSON.stringify({ processId: a.processId })}`);
  expect(await state(a.processId)).toBe('exited');
  const a2 = await start(request, 'bash-tools-a', 'tools-a2', '工具服务 A2');
  const a3 = await start(request, 'bash-tools-a', 'tools-a3', '工具服务 A3');
  await send(request, 'bash-tools-a', 'tools-session', '内部工具：stop_session_processes {}');
  expect(await state(a2.processId)).toBe('exited'); expect(await state(a3.processId)).toBe('exited'); expect(await state(b.processId)).toBe('running');
});
