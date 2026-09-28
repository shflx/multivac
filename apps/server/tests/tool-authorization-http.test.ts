import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request, type ClientRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  GLOBAL_ASSISTANT_SESSION_ID,
  type AssistantPublicEvent,
  type AssistantSessionPageResponse,
  type ToolAuthorizationRequest,
  type WorkspaceSession,
} from '@multivac/contracts';
import { createMultivacApplication, type MultivacApplicationOptions } from '../src/bootstrap/application.js';
import { isPathWithin } from '../src/modules/sessions/working-directory.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

/**
 * 应用级授权流程：Fake 模式下的越界写入场景走真实的目录边界判定、授权服务、SQLite 与 HTTP 接口。
 */

function httpJson(port: number, path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: '127.0.0.1', port, path, method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
      });
    });
    outgoing.on('error', reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** 订阅会话 SSE，按条件等待事件。 */
function subscribe(port: number, path: string) {
  const events: AssistantPublicEvent[] = [];
  let outgoing!: ClientRequest;
  const waiters: Array<{ predicate: (event: AssistantPublicEvent) => boolean; resolve: (event: AssistantPublicEvent) => void }> = [];
  const opened = new Promise<IncomingMessage>((resolve, reject) => {
    outgoing = request({ hostname: '127.0.0.1', port, path, headers: { accept: 'text/event-stream' } }, resolve);
    outgoing.on('error', reject);
    outgoing.end();
  });
  void opened.then((response) => {
    let buffer = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      buffer += chunk;
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (!data) continue;
        const event = JSON.parse(data.slice(6)) as AssistantPublicEvent;
        events.push(event);
        for (const waiter of [...waiters]) {
          if (!waiter.predicate(event)) continue;
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(event);
        }
      }
    });
  });
  return {
    events,
    opened,
    until(predicate: (event: AssistantPublicEvent) => boolean): Promise<AssistantPublicEvent> {
      const found = events.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
    close() { outgoing.destroy(); },
  };
}

async function startApplication(root: string, options: MultivacApplicationOptions = {}) {
  const app = createMultivacApplication(testApplicationEnvironment(root), options);
  await app.ready;
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  return {
    app,
    port: address.port,
    /** 与进程退出一致：断开所有连接，不等待进行中的请求。 */
    stop() {
      app.server.closeAllConnections();
      app.server.close();
      app.close();
    },
  };
}

const SESSION_ID = 'authorization-work';

async function createSession(
  port: number,
  sessionId = SESSION_ID,
  workspaceId?: string,
): Promise<{ session: WorkspaceSession; cursor: string }> {
  const created = await httpJson(port, '/api/sessions', 'POST', {
    sessionId, title: '授权', ...(workspaceId ? { workspaceId } : {}),
  });
  assert.equal(created.status, 201);
  const page = await httpJson(port, `/api/sessions/${sessionId}/session`);
  assert.equal(page.status, 200);
  return { session: created.body as WorkspaceSession, cursor: page.body.eventCursor as string };
}

/** 发送一轮并等到回执终态（记住的授权放行时，本轮不会出现授权请求）。 */
function sendTurn(port: number, commandId: string, text = '越界写入场景', sessionId = SESSION_ID) {
  return httpJson(port, `/api/sessions/${sessionId}/turns`, 'POST', {
    commandId, assistantSessionId: sessionId, text, contextRefs: [],
  });
}

/** 发送越界写入场景，等到授权请求生成；返回仍在进行的发送请求。 */
async function startOutsideWrite(
  port: number,
  stream: ReturnType<typeof subscribe>,
  commandId: string,
  sessionId = SESSION_ID,
  text = '越界写入场景',
) {
  const send = sendTurn(port, commandId, text, sessionId);
  // 断言失败时发送请求会随服务关闭而中断；避免它掩盖真正的失败原因。
  send.catch(() => {});
  const requested = await stream.until((event) =>
    event.type === 'assistant.authorization.requested' && event.commandId === commandId);
  assert.equal(requested.type, 'assistant.authorization.requested');
  return { send, request: requested.data.request };
}

function decide(port: number, requestId: string, decision: unknown, sessionId = SESSION_ID) {
  return httpJson(port, `/api/sessions/${sessionId}/authorizations/${encodeURIComponent(requestId)}/decision`, 'POST', { decision });
}

/** 会话快照中某一轮的工具记录与运行轨迹：刷新页面时界面据此还原。 */
async function snapshotOf(port: number, commandId: string) {
  const page = await httpJson(port, `/api/sessions/${SESSION_ID}/session`);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  const snapshot = page.body as AssistantSessionPageResponse;
  return {
    tool: snapshot.toolExecutions?.find((tool) => tool.commandId === commandId),
    trace: snapshot.runTraces?.find((trace) => trace.commandId === commandId),
  };
}

async function listAuthorizations(port: number, sessionId = SESSION_ID): Promise<ToolAuthorizationRequest[]> {
  const response = await httpJson(port, `/api/sessions/${sessionId}/authorizations`);
  assert.equal(response.status, 200);
  assert.equal(response.body.sessionId, sessionId);
  return response.body.requests as ToolAuthorizationRequest[];
}

test('HTTP：批准后执行、拒绝后 Agent 收到原因继续回应、等待中停止本轮立即结束；决定按请求 id 幂等', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-authorization-http-'));
  const { port, stop } = await startApplication(root);
  let stream: ReturnType<typeof subscribe> | undefined;
  try {
    const { session, cursor } = await createSession(port);
    stream = subscribe(port, `/api/sessions/${SESSION_ID}/events?after=${cursor}`);
    await stream.opened;

    // 批准：等待期间 Turn 保持运行，批准后写入目录外的文件。
    const approve = await startOutsideWrite(port, stream, 'cmd-approve');
    const started = stream.events.find((event) => event.type === 'assistant.tool.started' && event.commandId === 'cmd-approve');
    assert.ok(started?.type === 'assistant.tool.started');
    assert.equal(approve.request.toolCallId, started.data.toolCallId);
    assert.equal(approve.request.toolName, 'write');
    assert.equal(approve.request.status, 'pending');
    assert.deepEqual(approve.request.workingDirectory, session.workingDirectory);
    assert.equal(isPathWithin(session.workingDirectory.path, approve.request.targetPath), false);
    assert.equal((await httpJson(port, `/api/sessions/${SESSION_ID}/commands/cmd-approve`)).body.status, 'running');
    assert.deepEqual((await listAuthorizations(port)).map((item) => item.status), ['pending']);
    // 工具开始事件已到达，但等待授权期间工具记录是“待授权”，不是执行中。
    const waiting = await snapshotOf(port, 'cmd-approve');
    assert.equal(waiting.tool?.status, 'awaiting_authorization');
    assert.equal(waiting.tool?.summary, '写入文件等待授权');
    assert.deepEqual(waiting.tool?.authorization, { requestId: approve.request.requestId, status: 'pending', approval: null });
    assert.equal(waiting.tool?.endedAt, null);
    assert.equal(waiting.trace?.status, 'running');

    const approved = await decide(port, approve.request.requestId, 'once');
    assert.equal(approved.status, 200);
    assert.equal(approved.body.request.status, 'approved');
    assert.equal((await approve.send).body.terminalOutcome, 'succeeded');
    assert.equal(readFileSync(approve.request.targetPath, 'utf8'), 'Fake 越界写入');
    const executed = (await snapshotOf(port, 'cmd-approve')).tool;
    assert.equal(executed?.status, 'succeeded');
    assert.deepEqual(executed?.authorization, {
      requestId: approve.request.requestId,
      status: 'approved',
      approval: { scope: 'once', source: 'user', grantId: null },
    });
    // 重复提交同一决定返回同一结果；冲突的决定返回冲突错误。
    assert.deepEqual((await decide(port, approve.request.requestId, 'once')).body, approved.body);
    const conflict = await decide(port, approve.request.requestId, 'deny');
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'AUTHORIZATION_CONFLICT');

    // 拒绝：不写入，Agent 带着拒绝原因继续回应，本轮正常完成。
    const deny = await startOutsideWrite(port, stream, 'cmd-deny');
    assert.equal((await decide(port, deny.request.requestId, 'deny')).body.request.status, 'denied');
    assert.equal((await deny.send).body.terminalOutcome, 'succeeded');
    assert.equal(existsSync(deny.request.targetPath), false);
    const page = await httpJson(port, `/api/sessions/${SESSION_ID}/session`);
    assert.match(page.body.messages.at(-1).text, /用户拒绝了这次授权：没有写入/u);
    // 拒绝的调用没有执行：记录以失败结束，原因由授权状态说明。
    const denied = await snapshotOf(port, 'cmd-deny');
    assert.equal(denied.tool?.status, 'failed');
    assert.equal(denied.tool?.authorization?.status, 'denied');
    assert.equal(denied.trace?.status, 'succeeded');

    // 停止本轮：等待立即结束，本轮取消，请求记为已取消，之后的批准不执行任何操作。
    const cancel = await startOutsideWrite(port, stream, 'cmd-cancel');
    const cancelled = await httpJson(port, `/api/sessions/${SESSION_ID}/turns/current/cancel`, 'POST', {
      commandId: 'cmd-cancel-stop', assistantSessionId: SESSION_ID,
    });
    assert.ok([200, 202].includes(cancelled.status));
    assert.equal((await cancel.send).body.terminalOutcome, 'cancelled');
    const late = await decide(port, cancel.request.requestId, 'once');
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, 'AUTHORIZATION_NOT_PENDING');
    assert.match(late.body.error.message, /已取消/u);
    assert.equal(existsSync(cancel.request.targetPath), false);
    const stopped = await snapshotOf(port, 'cmd-cancel');
    assert.equal(stopped.tool?.status, 'failed');
    assert.equal(stopped.tool?.authorization?.status, 'cancelled');
    assert.equal(stopped.trace?.status, 'cancelled');

    // 查询含历史，按时间排序；状态变化都经事件流推送。
    assert.deepEqual((await listAuthorizations(port)).map((item) => [item.commandId, item.status]), [
      ['cmd-approve', 'approved'], ['cmd-deny', 'denied'], ['cmd-cancel', 'cancelled'],
    ]);
    assert.deepEqual(stream.events.flatMap((event) => event.type === 'assistant.authorization.resolved'
      ? [[event.commandId, event.data.request.status]] : []), [
      ['cmd-approve', 'approved'], ['cmd-deny', 'denied'], ['cmd-cancel', 'cancelled'],
    ]);
    // 授权事件不混入工具执行记录。
    const tools = await httpJson(port, `/api/sessions/${SESSION_ID}/tools`);
    assert.deepEqual(tools.body.tools.map((tool: { toolName: string }) => tool.toolName), ['write', 'write', 'write']);

    // 参数与会话校验。
    assert.equal((await decide(port, approve.request.requestId, 'always')).status, 400);
    assert.equal((await decide(port, 'missing', 'once')).status, 404);
    assert.equal((await decide(port, approve.request.requestId, 'once', 'missing-session')).status, 404);
    const global = await httpJson(port, '/api/assistant/authorizations');
    assert.deepEqual(global.body, { sessionId: GLOBAL_ASSISTANT_SESSION_ID, requests: [] });
  } finally {
    stream?.close();
    stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('HTTP：等待超时后本轮结束，请求保留为已过期，批准不执行任何操作', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-authorization-timeout-'));
  const { port, stop } = await startApplication(root, { toolAuthorizationTimeoutMs: 200 });
  let stream: ReturnType<typeof subscribe> | undefined;
  try {
    const { cursor } = await createSession(port);
    stream = subscribe(port, `/api/sessions/${SESSION_ID}/events?after=${cursor}`);
    await stream.opened;

    const expire = await startOutsideWrite(port, stream, 'cmd-expire');
    assert.equal((await expire.send).body.terminalOutcome, 'cancelled');
    const [expired] = await listAuthorizations(port);
    assert.equal(expired!.status, 'expired');
    const ended = stream.events.find((event) => event.type === 'assistant.tool.ended' && event.commandId === 'cmd-expire');
    assert.ok(ended?.type === 'assistant.tool.ended' && ended.data.isError);

    const timedOut = await snapshotOf(port, 'cmd-expire');
    assert.equal(timedOut.tool?.status, 'failed');
    assert.equal(timedOut.tool?.authorization?.status, 'expired');
    assert.equal(timedOut.trace?.status, 'cancelled');

    const late = await decide(port, expired!.requestId, 'once');
    assert.equal(late.status, 409);
    assert.match(late.body.error.message, /已过期/u);
    assert.equal(existsSync(expired!.targetPath), false);
  } finally {
    stream?.close();
    stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('HTTP：等待中重启服务，请求显示为已失效，对它的批准不执行任何操作，对应 Turn 按中断处理', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-authorization-restart-'));
  const first = await startApplication(root);
  let pending: ToolAuthorizationRequest;
  let cursor: string;
  try {
    ({ cursor } = await createSession(first.port));
    const stream = subscribe(first.port, `/api/sessions/${SESSION_ID}/events?after=${cursor}`);
    await stream.opened;
    const started = await startOutsideWrite(first.port, stream, 'cmd-restart');
    pending = started.request;
    stream.close();
  } finally {
    first.stop();
  }

  const second = await startApplication(root);
  let stream: ReturnType<typeof subscribe> | undefined;
  try {
    const [invalidated] = await listAuthorizations(second.port);
    assert.equal(invalidated!.requestId, pending.requestId);
    assert.equal(invalidated!.status, 'invalidated');

    const late = await decide(second.port, pending.requestId, 'once');
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, 'AUTHORIZATION_NOT_PENDING');
    assert.match(late.body.error.message, /已失效/u);
    assert.equal(existsSync(pending.targetPath), false);
    assert.equal((await listAuthorizations(second.port))[0]!.status, 'invalidated');

    // 失效也经事件流推送；会话恢复后，等待中的那一轮按中断处理。
    stream = subscribe(second.port, `/api/sessions/${SESSION_ID}/events?after=${cursor}`);
    const resolved = await stream.until((event) => event.type === 'assistant.authorization.resolved');
    assert.ok(resolved.type === 'assistant.authorization.resolved');
    assert.equal(resolved.data.request.status, 'invalidated');
    assert.equal(resolved.commandId, 'cmd-restart');
    const recovered = await httpJson(second.port, `/api/sessions/${SESSION_ID}/session`);
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    const receipt = await httpJson(second.port, `/api/sessions/${SESSION_ID}/commands/cmd-restart`);
    assert.equal(receipt.body.status, 'terminal');
    assert.equal(receipt.body.receipt.error.code, 'COMMAND_INTERRUPTED');
    // 结束事件永远不会到达：工具记录随授权失效结束，轨迹随命令中断结束，都不再显示为运行中。
    const interrupted = await snapshotOf(second.port, 'cmd-restart');
    assert.equal(interrupted.tool?.status, 'failed');
    assert.deepEqual(interrupted.tool?.authorization, { requestId: pending.requestId, status: 'invalidated', approval: null });
    assert.equal(interrupted.tool?.endedAt, invalidated!.decidedAt);
    assert.equal(interrupted.trace?.status, 'failed');
    assert.equal(interrupted.trace?.endedAt, null);
  } finally {
    stream?.close();
    second.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('HTTP：本会话内允许后同类操作直接放行、轨迹可见放行依据；授权记录可查、撤销后再次确认；重启后仍然有效', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-authorization-grants-'));
  const first = await startApplication(root);
  let stream: ReturnType<typeof subscribe> | undefined;
  let grantId: string;
  try {
    const { cursor } = await createSession(first.port);
    stream = subscribe(first.port, `/api/sessions/${SESSION_ID}/events?after=${cursor}`);
    await stream.opened;

    // 卡片上的可记住范围：目标所在目录；默认工作区的会话不属于项目，不能选本项目内。
    const initial = await startOutsideWrite(first.port, stream, 'cmd-first');
    assert.deepEqual(initial.request.remember, { directory: dirname(initial.request.targetPath), projectId: null });
    const invalid = await decide(first.port, initial.request.requestId, 'project');
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID_REQUEST');
    assert.match(invalid.body.error.message, /不属于项目/u);
    const remembered = await decide(first.port, initial.request.requestId, 'session');
    assert.equal(remembered.status, 200);
    assert.equal(remembered.body.request.approval.scope, 'session');
    assert.equal((await initial.send).body.terminalOutcome, 'succeeded');
    // 同一决定幂等，其他决定冲突。
    assert.deepEqual((await decide(first.port, initial.request.requestId, 'session')).body, remembered.body);
    assert.equal((await decide(first.port, initial.request.requestId, 'once')).status, 409);

    const grants = await httpJson(first.port, '/api/authorization-grants');
    assert.equal(grants.status, 200);
    assert.equal(grants.body.grants.length, 1);
    const [grant] = grants.body.grants;
    grantId = grant.grantId;
    assert.deepEqual([grant.scope, grant.sessionId, grant.access, grant.directory, grant.useCount], [
      'session', SESSION_ID, 'write', initial.request.remember.directory, 0,
    ]);

    // 第二次越界写入：没有待授权事件，文件写入，工具记录注明按已记住的授权放行。
    const auto = await sendTurn(first.port, 'cmd-auto');
    assert.equal(auto.body.terminalOutcome, 'succeeded');
    const requests = await listAuthorizations(first.port);
    const autoRequest = requests.at(-1)!;
    assert.equal(autoRequest.status, 'approved');
    assert.deepEqual(autoRequest.approval, { scope: 'session', source: 'grant', grantId });
    assert.equal(readFileSync(autoRequest.targetPath, 'utf8'), 'Fake 越界写入');
    const autoEvents = stream.events.filter((event) => event.commandId === 'cmd-auto' && event.type.startsWith('assistant.authorization.'));
    assert.deepEqual(autoEvents.map((event) => event.type), ['assistant.authorization.resolved']);
    const tool = (await snapshotOf(first.port, 'cmd-auto')).tool;
    assert.equal(tool?.status, 'succeeded');
    assert.deepEqual(tool?.authorization?.approval, { scope: 'session', source: 'grant', grantId });
    assert.equal((await httpJson(first.port, '/api/authorization-grants')).body.grants[0].useCount, 1);
    // 读取属于另一类，仍需确认。
    const read = await startOutsideWrite(first.port, stream, 'cmd-read', SESSION_ID, '越界读取场景');
    assert.equal(read.request.toolName, 'read');
    await decide(first.port, read.request.requestId, 'deny');
    await read.send;

    // 最近的授权请求：跨会话、最近的在前、只读。
    const history = await httpJson(first.port, '/api/authorization-requests');
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.requests.slice(0, 3).map((item: ToolAuthorizationRequest) => item.toolName), ['read', 'write', 'write']);
    assert.equal((await httpJson(first.port, '/api/authorization-requests?limit=1')).status, 400);
    assert.equal((await httpJson(first.port, '/api/authorization-grants', 'POST', {})).status, 404);
  } finally {
    stream?.close();
    first.stop();
  }

  // 重启后记住的决定仍然有效。
  const second = await startApplication(root);
  let restarted: ReturnType<typeof subscribe> | undefined;
  try {
    assert.equal((await sendTurn(second.port, 'cmd-after-restart')).body.terminalOutcome, 'succeeded');
    assert.equal((await listAuthorizations(second.port)).at(-1)?.approval?.source, 'grant');

    // 撤销：即时生效，下一次同类操作重新产生待授权请求；重复撤销幂等，不存在的授权 404。
    const revoked = await httpJson(second.port, `/api/authorization-grants/${grantId!}/revoke`, 'POST');
    assert.equal(revoked.status, 200);
    assert.notEqual(revoked.body.grant.revokedAt, null);
    assert.deepEqual((await httpJson(second.port, `/api/authorization-grants/${grantId!}/revoke`, 'POST')).body, revoked.body);
    assert.equal((await httpJson(second.port, '/api/authorization-grants/missing/revoke', 'POST')).status, 404);
    assert.deepEqual((await httpJson(second.port, '/api/authorization-grants')).body.grants, []);
    const page = await httpJson(second.port, `/api/sessions/${SESSION_ID}/session`);
    restarted = subscribe(second.port, `/api/sessions/${SESSION_ID}/events?after=${page.body.eventCursor}`);
    await restarted.opened;
    const again = await startOutsideWrite(second.port, restarted, 'cmd-again');
    assert.equal(again.request.status, 'pending');
    await decide(second.port, again.request.requestId, 'deny');
    await again.send;
  } finally {
    restarted?.close();
    second.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('HTTP：本项目内始终允许在同一项目的另一个会话中生效', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-authorization-project-grants-'));
  const { port, stop } = await startApplication(root);
  const streams: Array<ReturnType<typeof subscribe>> = [];
  try {
    const project = await httpJson(port, '/api/projects', 'POST', { name: '授权项目' });
    assert.equal(project.status, 201);
    const projectId = project.body.project.projectId as string;
    const { cursor } = await createSession(port, 'project-a', projectId);
    await createSession(port, 'project-b', projectId);
    const stream = subscribe(port, `/api/sessions/project-a/events?after=${cursor}`);
    streams.push(stream);
    await stream.opened;

    const initial = await startOutsideWrite(port, stream, 'cmd-project', 'project-a');
    assert.equal(initial.request.remember?.projectId, projectId);
    assert.equal((await decide(port, initial.request.requestId, 'project', 'project-a')).body.request.approval.scope, 'project');
    await initial.send;
    const [grant] = (await httpJson(port, '/api/authorization-grants')).body.grants;
    assert.deepEqual([grant.scope, grant.projectId, grant.sessionId], ['project', projectId, null]);

    // 同一项目的另一个会话共用项目目录，越界目标在同一目录中：直接放行。
    const sibling = await sendTurn(port, 'cmd-sibling', '越界写入场景', 'project-b');
    assert.equal(sibling.body.terminalOutcome, 'succeeded');
    assert.deepEqual((await listAuthorizations(port, 'project-b')).map((item) => item.approval?.source), ['grant']);

  } finally {
    for (const stream of streams) stream.close();
    stop();
    await rm(root, { recursive: true, force: true });
  }
});
