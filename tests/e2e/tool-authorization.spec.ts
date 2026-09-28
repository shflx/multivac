import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import type { ToolAuthorizationRequest } from '@multivac/contracts';
import { fakeApiRoot, resetE2eState } from './test-state.js';

/**
 * 目录外访问的授权：Fake 服务的越界写入场景走真实的目录边界判定、授权服务与 SQLite，
 * 本文件只经 HTTP 接口操作与断言（界面授权卡另行覆盖）。
 * 批准后探针文件真实写入目标路径；拒绝、取消、超时与失效时目标文件不存在。
 */

interface OutsideWrite {
  sessionId: string;
  commandId: string;
  /** 发送请求：本轮结束时返回回执。 */
  send: Promise<APIResponse | null>;
  request: ToolAuthorizationRequest;
}

async function listAuthorizations(request: APIRequestContext, sessionId: string): Promise<ToolAuthorizationRequest[]> {
  const response = await request.get(`${fakeApiRoot}/api/sessions/${sessionId}/authorizations`);
  expect(response.status()).toBe(200);
  return (await response.json() as { requests: ToolAuthorizationRequest[] }).requests;
}

function decide(request: APIRequestContext, target: OutsideWrite, decision: 'once' | 'deny') {
  return request.post(
    `${fakeApiRoot}/api/sessions/${target.sessionId}/authorizations/${target.request.requestId}/decision`,
    { data: { decision } },
  );
}

/** 新建工作会话并让 Agent 越界写入，等到请求进入待授权。 */
async function startOutsideWrite(request: APIRequestContext): Promise<OutsideWrite> {
  const sessionId = `authorization-${randomUUID().slice(0, 8)}`;
  expect((await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: '授权' } })).status()).toBe(201);
  const commandId = `command-${randomUUID()}`;
  // 服务重启时进行中的发送会断开，这里只关心回执。
  const send = request.post(`${fakeApiRoot}/api/sessions/${sessionId}/turns`, {
    data: { commandId, assistantSessionId: sessionId, text: '越界写入场景', contextRefs: [] },
    timeout: 20_000,
  }).catch(() => null);
  await expect.poll(async () => (await listAuthorizations(request, sessionId)).map((item) => item.status)).toEqual(['pending']);
  const [pending] = await listAuthorizations(request, sessionId);
  expect(pending!.commandId).toBe(commandId);
  expect(pending!.toolName).toBe('write');
  // 等待期间本轮保持运行，工具没有执行。
  const receipt = await (await request.get(`${fakeApiRoot}/api/sessions/${sessionId}/commands/${commandId}`)).json();
  expect(receipt.status).toBe('running');
  expect(existsSync(pending!.targetPath)).toBe(false);
  return { sessionId, commandId, send, request: pending! };
}

async function terminalOutcome(target: OutsideWrite): Promise<string> {
  const response = await target.send;
  expect(response?.status()).toBe(200);
  return (await response!.json() as { terminalOutcome: string }).terminalOutcome;
}

async function expectNotPending(request: APIRequestContext, target: OutsideWrite, message: RegExp): Promise<void> {
  const response = await decide(request, target, 'once');
  expect(response.status()).toBe(409);
  const body = await response.json() as { error: { code: string; message: string } };
  expect(body.error.code).toBe('AUTHORIZATION_NOT_PENDING');
  expect(body.error.message).toMatch(message);
  expect(existsSync(target.request.targetPath)).toBe(false);
}

test.beforeEach(async ({ request }) => {
  await resetE2eState(request);
});

test('批准：仅这一次放行，工具随后执行，本轮完成；重复批准返回同一结果，改为拒绝报冲突', async ({ request }) => {
  const target = await startOutsideWrite(request);

  const approved = await decide(request, target, 'once');
  expect(approved.status()).toBe(200);
  expect((await approved.json()).request.status).toBe('approved');
  expect(await terminalOutcome(target)).toBe('succeeded');
  expect(readFileSync(target.request.targetPath, 'utf8')).toBe('Fake 越界写入');

  expect(await (await decide(request, target, 'once')).json()).toEqual(await approved.json());
  const conflict = await decide(request, target, 'deny');
  expect(conflict.status()).toBe(409);
  expect((await conflict.json()).error.code).toBe('AUTHORIZATION_CONFLICT');
});

test('拒绝：工具不执行，Agent 收到原因后继续回应，本轮完成', async ({ request }) => {
  const target = await startOutsideWrite(request);

  expect((await (await decide(request, target, 'deny')).json()).request.status).toBe('denied');
  expect(await terminalOutcome(target)).toBe('succeeded');
  expect(existsSync(target.request.targetPath)).toBe(false);
  const page = await (await request.get(`${fakeApiRoot}/api/sessions/${target.sessionId}/session`)).json() as {
    messages: Array<{ role: string; text: string }>;
  };
  expect(page.messages.at(-1)?.text).toMatch(/用户拒绝了这次授权：没有写入/u);
});

test('取消：等待中停止本轮，本轮立即结束，请求记为已取消，之后的批准不执行任何操作', async ({ request }) => {
  const target = await startOutsideWrite(request);

  const cancel = await request.post(`${fakeApiRoot}/api/sessions/${target.sessionId}/turns/current/cancel`, {
    data: { commandId: `cancel-${randomUUID()}`, assistantSessionId: target.sessionId },
  });
  expect(cancel.ok()).toBe(true);
  expect(await terminalOutcome(target)).toBe('cancelled');
  expect((await listAuthorizations(request, target.sessionId))[0]!.status).toBe('cancelled');
  await expectNotPending(request, target, /已取消/u);
});

test('超时：等待超过时限后本轮结束，请求可查且为已过期，之后的批准不执行任何操作', async ({ request }) => {
  expect((await request.post(`${fakeApiRoot}/api/__e2e/tool-authorization`, { data: { timeoutMs: 1_500 } })).ok()).toBe(true);
  const target = await startOutsideWrite(request);
  expect(Date.parse(target.request.expiresAt) - Date.parse(target.request.createdAt)).toBe(1_500);

  expect(await terminalOutcome(target)).toBe('cancelled');
  expect((await listAuthorizations(request, target.sessionId))[0]!.status).toBe('expired');
  await expectNotPending(request, target, /已过期/u);
});

test('重启：等待中重启服务，请求显示为已失效，对它的批准不执行任何操作，本轮按中断处理', async ({ request }) => {
  test.setTimeout(60_000);
  const target = await startOutsideWrite(request);

  expect((await request.post(`${fakeApiRoot}/api/__e2e/restart`)).status()).toBe(202);
  expect(await target.send).toBeNull();
  // 服务脚本用同一数据目录重新拉起服务。
  await expect.poll(async () => {
    try {
      return (await request.get(`${fakeApiRoot}/api/assistant/page-state`, { timeout: 1_000 })).status();
    } catch {
      return 0;
    }
  }, { timeout: 30_000 }).toBe(200);

  const [invalidated] = await listAuthorizations(request, target.sessionId);
  expect(invalidated!.requestId).toBe(target.request.requestId);
  expect(invalidated!.status).toBe('invalidated');
  await expectNotPending(request, target, /已失效/u);
  expect((await listAuthorizations(request, target.sessionId))[0]!.status).toBe('invalidated');

  // 会话恢复后，等待中的那一轮按中断处理。
  expect((await request.get(`${fakeApiRoot}/api/sessions/${target.sessionId}/session`)).status()).toBe(200);
  const receipt = await (await request.get(`${fakeApiRoot}/api/sessions/${target.sessionId}/commands/${target.commandId}`)).json();
  expect(receipt.status).toBe('terminal');
  expect(receipt.receipt.error.code).toBe('COMMAND_INTERRUPTED');
});
