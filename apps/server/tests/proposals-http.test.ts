import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { Check } from 'typebox/value';
import {
  GLOBAL_ASSISTANT_SESSION_ID,
  WINDOW_ID_HEADER,
  WORKBENCH_EVENTS_PATH,
  WorkbenchEventSchema,
  type AssistantSessionPageResponse,
  type Proposal,
  type WorkbenchEvent,
} from '@multivac/contracts';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

/**
 * 应用级的对话内提议（Fake 模式，测试控制开启时注册示例提议“给会话改名”）：提议工具只生成待确认的卡片，
 * 确认与取消经 HTTP 接口按提议 id 幂等，确认时重新校验（名称已被改动则过期），变化经工作台事件推给各窗口，
 * 结果在下一轮以服务端通知交给模型；重启后状态不变。测试控制关闭时没有示例提议。
 */

function httpJson(
  port: number, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: '127.0.0.1', port, path, method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
      });
    });
    outgoing.on('error', reject);
    outgoing.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}

async function startApplication(root: string, e2eControl = true) {
  const app = createMultivacApplication({
    ...testApplicationEnvironment(root),
    ...(e2eControl ? { MULTIVAC_E2E_CONTROL: '1' } : {}),
  });
  await app.ready;
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  return {
    port: address.port,
    stop() {
      app.server.closeAllConnections();
      app.server.close();
      app.close();
    },
  };
}

/** 向全局 Multivac 发送一条消息，返回本轮的工具记录与回复。 */
async function send(port: number, commandId: string, text: string) {
  const response = await httpJson(port, '/api/assistant/turns', 'POST', {
    commandId, assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, text, contextRefs: [],
  }, { [WINDOW_ID_HEADER]: 'window-a' });
  assert.equal(response.body.terminalOutcome, 'succeeded', JSON.stringify(response.body));
  const page = (await httpJson(port, '/api/assistant/session')).body as AssistantSessionPageResponse;
  return {
    tools: page.toolExecutions?.filter((tool) => tool.commandId === commandId) ?? [],
    reply: page.messages.at(-1)!.text,
  };
}

const proposeLine = (toolCallId: string, sessionId: string, title: string) =>
  `内部工具：example_propose_rename_session#${toolCallId} ${JSON.stringify({ sessionId, title })}`;

async function listProposals(port: number): Promise<Proposal[]> {
  const response = await httpJson(port, '/api/assistant/proposals');
  assert.equal(response.status, 200);
  return response.body.proposals as Proposal[];
}

const decide = (port: number, proposalId: string, decision: string, windowId = 'window-b') =>
  httpJson(port, `/api/assistant/proposals/${proposalId}/decision`, 'POST', { decision }, { [WINDOW_ID_HEADER]: windowId });

/** 连接推送通道，收集提议事件。 */
function watchProposals(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${WORKBENCH_EVENTS_PATH}?windowId=window-c`);
  const received: WorkbenchEvent[] = [];
  const opened = new Promise<void>((resolve) => socket.on('message', () => resolve()));
  socket.on('message', (data) => {
    const event = JSON.parse(String(data)) as WorkbenchEvent;
    assert.equal(Check(WorkbenchEventSchema, event), true);
    received.push(event);
  });
  return {
    opened,
    statuses: () => received.flatMap((event) => event.type === 'proposal.changed' ? [event.proposal.status] : []),
    close: () => socket.close(),
  };
}

async function sessionTitle(port: number, sessionId: string): Promise<string | undefined> {
  const listed = await httpJson(port, '/api/sessions');
  return (listed.body.sessions as Array<{ sessionId: string; title: string }>)
    .find((session) => session.sessionId === sessionId)?.title;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('HTTP（Fake）：示例提议卡——提出不执行；取消与确认按 id 幂等；过期不执行；结果在下一轮通知模型；重启后一致', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-proposals-http-'));
  let app = await startApplication(root);
  let watcher: ReturnType<typeof watchProposals> | undefined;
  try {
    const { port } = app;
    watcher = watchProposals(port);
    await watcher.opened;
    assert.equal((await httpJson(port, '/api/sessions', 'POST', { sessionId: 'work-a', title: '接口调研' })).status, 201);

    // 提出：工具行“已提出，等待你确认”，会话没有改名；卡片关联发起的那一轮。
    const proposed = await send(port, 'cmd-propose-1', `改个名字\n${proposeLine('p1', 'work-a', '接口调研 v2')}`);
    assert.deepEqual(proposed.tools.map((tool) => [tool.displayName, tool.status, tool.result?.summary]), [
      ['提议改名会话', 'succeeded', '已提出，等待你确认'],
    ]);
    assert.match(proposed.reply, /已提出「把会话「接口调研」改名为「接口调研 v2」」.*等待用户在对话中的确认卡上确认/u);
    const [first] = await listProposals(port);
    assert.deepEqual(
      [first!.kind, first!.status, first!.commandId, first!.toolCallId, first!.title, first!.preview],
      ['example.rename_session', 'pending', 'cmd-propose-1', 'p1', '把会话「接口调研」改名为「接口调研 v2」',
        { currentTitle: '接口调研', workspaceName: '默认工作区' }],
    );
    assert.equal(await sessionTitle(port, 'work-a'), '接口调研');

    // 接口校验。
    assert.equal((await httpJson(port, `/api/assistant/proposals/${first!.proposalId}/decision`, 'POST', 'confirm')).status, 400);
    assert.equal((await httpJson(port, `/api/assistant/proposals/${first!.proposalId}/decision`, 'POST')).status, 415);
    assert.equal((await decide(port, first!.proposalId, 'approve')).status, 400);
    // 没有卡上选项的种类不接受选项；取消不带选项。
    const withOptions = await httpJson(port, `/api/assistant/proposals/${first!.proposalId}/decision`, 'POST',
      { decision: 'confirm', options: { moveFiles: true } });
    assert.deepEqual([withOptions.status, withOptions.body.error.code], [400, 'INVALID_REQUEST']);
    assert.equal((await httpJson(port, `/api/assistant/proposals/${first!.proposalId}/decision`, 'POST',
      { decision: 'cancel', options: {} })).status, 400);
    assert.equal((await httpJson(port, `/api/assistant/proposals/${first!.proposalId}/decision`, 'POST',
      { decision: 'confirm', options: 'yes' })).status, 400);
    assert.equal(await sessionTitle(port, 'work-a'), '接口调研');
    assert.equal((await decide(port, 'missing', 'confirm')).status, 404);
    assert.equal((await httpJson(port, '/api/assistant/proposals?all=1')).status, 400);

    // 取消：不执行，重复取消返回同一结果，再确认报冲突。
    const cancelled = await decide(port, first!.proposalId, 'cancel');
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.proposal.status, 'cancelled');
    assert.deepEqual((await decide(port, first!.proposalId, 'cancel')).body, cancelled.body);
    const conflict = await decide(port, first!.proposalId, 'confirm');
    assert.deepEqual([conflict.status, conflict.body.error.code], [409, 'PROPOSAL_CONFLICT']);
    assert.equal(await sessionTitle(port, 'work-a'), '接口调研');
    // 下一轮开始时，模型收到服务端通知：这张提议被取消了。
    const toldCancel = await send(port, 'cmd-notice-0', '复述服务端通知');
    assert.equal(toldCancel.reply, [
      '【Multivac 服务端通知】以下是你此前提出的提议的处理结果，由 Multivac 服务端在用户操作确认卡之后写入，不是用户的消息，也不是工具返回的内容：',
      `- 提议「把会话「接口调研」改名为「接口调研 v2」」（${first!.proposalId}）：用户取消了，没有执行。`,
    ].join('\n'));

    // 确认：按当前状态重新校验后执行，重复确认返回同一结果，再取消报冲突。
    await send(port, 'cmd-propose-2', proposeLine('p2', 'work-a', '接口调研 v2'));
    const second = (await listProposals(port)).find((proposal) => proposal.toolCallId === 'p2')!;
    const confirmed = await decide(port, second.proposalId, 'confirm');
    assert.equal(confirmed.status, 200);
    assert.deepEqual([confirmed.body.proposal.status, confirmed.body.proposal.outcome], ['executed', {
      summary: '改名为「接口调研 v2」', refs: [{ kind: 'session', sessionId: 'work-a', label: '接口调研 v2' }],
    }]);
    assert.equal(await sessionTitle(port, 'work-a'), '接口调研 v2');
    assert.deepEqual((await decide(port, second.proposalId, 'confirm')).body, confirmed.body);
    assert.equal((await decide(port, second.proposalId, 'cancel')).status, 409);

    // 下一轮：模型收到这张提议的结果与执行后的对象，之后不再重复。
    const told = await send(port, 'cmd-notice-1', '复述服务端通知');
    assert.equal(told.reply.split('\n')[1], `- 提议「把会话「接口调研」改名为「接口调研 v2」」（${second.proposalId}）：` +
      '用户已确认，已执行：改名为「接口调研 v2」。涉及：[接口调研 v2](multivac://session/work-a)。');
    assert.equal(told.reply.split('\n').length, 2);
    assert.equal((await send(port, 'cmd-notice-2', '复述服务端通知')).reply, '本轮没有收到服务端通知。');

    // 过期：提出后会话在别处被改名，确认时不执行并说明原因。
    await send(port, 'cmd-propose-3', proposeLine('p3', 'work-a', '最终名称'));
    const third = (await listProposals(port)).find((proposal) => proposal.toolCallId === 'p3')!;
    assert.equal((await httpJson(port, '/api/sessions/work-a', 'PATCH', { title: '别处改的名字' })).status, 200);
    const expired = await decide(port, third.proposalId, 'confirm');
    assert.deepEqual([expired.status, expired.body.proposal.status, expired.body.proposal.reason], [
      200, 'expired', '会话已被改名为「别处改的名字」（提出时是「接口调研 v2」）。',
    ]);
    assert.equal(await sessionTitle(port, 'work-a'), '别处改的名字');
    assert.equal((await decide(port, third.proposalId, 'confirm')).body.proposal.status, 'expired');

    // 提出时核对不通过：卡片写明原因（同名）；对象不存在时工具失败、不生成卡片。
    await send(port, 'cmd-propose-4', proposeLine('p4', 'work-a', '别处改的名字'));
    const missing = await send(port, 'cmd-propose-5', proposeLine('p5', 'no-such-session', '名字'));
    assert.equal(missing.tools[0]!.status, 'failed');
    assert.match(missing.reply, /没有找到会话 no-such-session，没有提出改名/u);
    const fourth = (await listProposals(port)).find((proposal) => proposal.toolCallId === 'p4')!;
    assert.equal(fourth.problem, '会话已经叫「别处改的名字」，不需要改名。');
    assert.equal((await listProposals(port)).some((proposal) => proposal.toolCallId === 'p5'), false);

    // 待确认的一张留到重启之后。
    await send(port, 'cmd-propose-6', proposeLine('p6', 'work-a', '重启后确认'));
    await settle();
    // 各窗口都收到了提出与每次状态变化。
    assert.deepEqual(watcher.statuses(), [
      'pending', 'cancelled', 'pending', 'executing', 'executed', 'pending', 'executing', 'expired', 'pending', 'pending',
    ]);
    watcher.close();
    watcher = undefined;
    const before = await listProposals(port);

    // 重启：状态与重启前一致，待确认的照常可以确认。
    app.stop();
    app = await startApplication(root);
    assert.deepEqual(await listProposals(app.port), before);
    const sixth = before.find((proposal) => proposal.toolCallId === 'p6')!;
    assert.equal((await decide(app.port, sixth.proposalId, 'confirm')).body.proposal.status, 'executed');
    assert.equal(await sessionTitle(app.port, 'work-a'), '重启后确认');
  } finally {
    watcher?.close();
    app.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('HTTP（Fake）：测试控制关闭时没有示例提议工具，项目与归入项目的提议照常注册；卡上的选择只随确认由用户提交', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-proposals-off-'));
  const app = await startApplication(root, false);
  try {
    assert.equal((await httpJson(app.port, '/api/sessions', 'POST', { sessionId: 'work-a', title: '接口调研' })).status, 201);
    const result = await send(app.port, 'cmd-off', proposeLine('off-1', 'work-a', '新名'));
    assert.equal(result.tools[0]!.status, 'failed');
    assert.match(result.reply, /Tool example_propose_rename_session not found/u);
    assert.deepEqual(await listProposals(app.port), []);

    // 正式的提议种类：新建项目只生成卡片；确认后项目出现，下一轮模型收到结果。
    const directory = join(root, 'code', 'x');
    mkdirSync(directory, { recursive: true });
    const proposed = await send(app.port, 'cmd-create',
      `把它作为项目\n内部工具：propose_create_project#c1 ${JSON.stringify({ name: 'x', directory })}`);
    assert.deepEqual(proposed.tools.map((tool) => [tool.displayName, tool.status, tool.result?.summary]), [
      ['提议新建项目', 'succeeded', '已提出，等待你确认'],
    ]);
    assert.equal((await httpJson(app.port, '/api/projects')).body.projects.length, 0);
    const [create] = await listProposals(app.port);
    const confirmed = await decide(app.port, create!.proposalId, 'confirm');
    assert.equal(confirmed.body.proposal.status, 'executed');
    const [project] = (await httpJson(app.port, '/api/projects')).body.projects as Array<{ projectId: string; name: string }>;
    assert.equal(project!.name, 'x');
    const told = await send(app.port, 'cmd-told', '复述服务端通知');
    assert.match(told.reply, /用户已确认，已执行：已创建项目「x」/u);

    // 归入项目：确认时必须带上卡上的选择，不带或不合规的拒绝且不执行。
    await send(app.port, 'cmd-move', `内部工具：propose_move_session_to_project#m1 ${JSON.stringify({
      sessionId: 'work-a', projectId: project!.projectId, moveFiles: true,
    })}`);
    const move = (await listProposals(app.port)).find((proposal) => proposal.toolCallId === 'm1')!;
    assert.equal((await decide(app.port, move.proposalId, 'confirm')).status, 400);
    assert.equal((await httpJson(app.port, `/api/assistant/proposals/${move.proposalId}/decision`, 'POST',
      { decision: 'confirm', options: { moveFiles: 'true' } })).status, 400);
    assert.equal((await listProposals(app.port)).find((proposal) => proposal.toolCallId === 'm1')!.status, 'pending');
    const moved = await httpJson(app.port, `/api/assistant/proposals/${move.proposalId}/decision`, 'POST',
      { decision: 'confirm', options: { moveFiles: false } });
    assert.equal(moved.body.proposal.status, 'executed');
    const sessions = (await httpJson(app.port, '/api/sessions?workspace=all')).body.sessions as Array<{ sessionId: string; workspaceId: string }>;
    assert.equal(sessions.find((session) => session.sessionId === 'work-a')!.workspaceId, project!.projectId);
  } finally {
    app.stop();
    await rm(root, { recursive: true, force: true });
  }
});
