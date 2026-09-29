import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request, type ClientRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  GLOBAL_ASSISTANT_SESSION_ID,
  type AssistantPublicEvent,
  type AssistantSessionPageResponse,
} from '@multivac/contracts';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

/**
 * 应用级内部工具：Fake 模式下按消息脚本调用内部工具，走真实的注册表、目录边界、项目与会话服务、SQLite 与 HTTP。
 * 全局 Multivac 可以调用，工具记录与公共事件只公开结果摘要与对象；工作会话中同名工具不可用。
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

/** 订阅会话的 SSE，收集公共事件；until 等待满足条件的事件出现。 */
function subscribe(port: number, path: string) {
  const events: AssistantPublicEvent[] = [];
  const waiters: Array<{ predicate: (event: AssistantPublicEvent) => boolean; resolve: () => void }> = [];
  let outgoing!: ClientRequest;
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
        events.push(JSON.parse(data.slice(6)) as AssistantPublicEvent);
        for (const waiter of waiters.filter((candidate) => candidate.predicate(events.at(-1)!))) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    });
  });
  return {
    events,
    opened,
    until(predicate: (event: AssistantPublicEvent) => boolean): Promise<void> {
      if (events.some(predicate)) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
    close() { outgoing.destroy(); },
  };
}

async function startApplication(root: string) {
  const app = createMultivacApplication(testApplicationEnvironment(root));
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

/** 会话的接口前缀：全局 Multivac 为 /api/assistant，工作会话为 /api/sessions/:id。 */
const base = (sessionId: string) =>
  sessionId === GLOBAL_ASSISTANT_SESSION_ID ? '/api/assistant' : `/api/sessions/${sessionId}`;

async function send(port: number, sessionId: string, commandId: string, text: string) {
  const response = await httpJson(port, `${base(sessionId)}/turns`, 'POST', {
    commandId, assistantSessionId: sessionId, text, contextRefs: [],
  });
  assert.equal(response.body.terminalOutcome, 'succeeded', JSON.stringify(response.body));
  const page = await httpJson(port, `${base(sessionId)}/session`);
  assert.equal(page.status, 200);
  const snapshot = page.body as AssistantSessionPageResponse;
  return {
    tools: snapshot.toolExecutions?.filter((tool) => tool.commandId === commandId) ?? [],
    reply: snapshot.messages.at(-1)!,
  };
}

test('HTTP（Fake）：全局 Multivac 调用示例内部工具读到真实数据，只公开结果摘要；工作会话中同名工具不可用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-internal-tools-http-'));
  const { port, stop } = await startApplication(root);
  let stream: ReturnType<typeof subscribe> | undefined;
  try {
    const created = await httpJson(port, '/api/projects', 'POST', { name: '研究项目' });
    assert.equal(created.status, 201);
    const projectId = created.body.project.projectId as string;
    const cursor = (await httpJson(port, '/api/assistant/session')).body.eventCursor as string;
    stream = subscribe(port, `/api/assistant/events?after=${cursor}`);
    await stream.opened;

    const listed = await send(port, GLOBAL_ASSISTANT_SESSION_ID, 'cmd-list', '看看有哪些工作区\n内部工具：list_workspaces');
    assert.equal(listed.tools.length, 1);
    const [tool] = listed.tools;
    assert.equal(tool!.toolName, 'list_workspaces');
    assert.equal(tool!.displayName, '列出工作区');
    assert.equal(tool!.status, 'succeeded');
    assert.equal(tool!.authorization, null);
    assert.deepEqual(tool!.result, {
      summary: '共 2 个工作区',
      refs: [
        { kind: 'workspace', workspaceId: projectId, label: '研究项目' },
        { kind: 'workspace', workspaceId: 'default', label: '默认工作区' },
      ],
    });
    assert.equal(listed.reply.role, 'assistant');
    assert.match(listed.reply.text, /共 2 个工作区：\n- \[研究项目\]\(multivac:\/\/workspace\//u);

    // 公共事件：结束事件只带公开的结果；工具正文（含目录路径）不进入工具事件，也没有授权请求。
    await stream.until((event) => event.type === 'assistant.run.succeeded' && event.commandId === 'cmd-list');
    const events = stream.events;
    const ended = events.find((event) => event.type === 'assistant.tool.ended' && event.commandId === 'cmd-list');
    assert.ok(ended?.type === 'assistant.tool.ended');
    assert.deepEqual(ended.data.result, tool!.result);
    // （Fake 把工具正文当作回复，回复正文照常公开；这里只看工具事件。）
    assert.equal(JSON.stringify(events.filter((event) => event.type.startsWith('assistant.tool.'))).includes('主目录'), false);
    assert.equal(events.some((event) => event.type.startsWith('assistant.authorization.')), false);

    // 参数校验失败：不执行，回复里是中文原因，工具记录没有公开结果。
    const invalid = await send(port, GLOBAL_ASSISTANT_SESSION_ID, 'cmd-invalid', '内部工具：list_workspaces {"workspaceId":"default"}');
    assert.equal(invalid.tools[0]!.status, 'failed');
    assert.equal(invalid.tools[0]!.result, undefined);
    assert.match(invalid.reply.text, /参数不符合要求：不支持参数 workspaceId/u);

    // 工作会话：没有注入内部工具，与 Pi 一样报告找不到，没有执行。
    assert.equal((await httpJson(port, '/api/sessions', 'POST', { sessionId: 'work-a', title: '工作会话' })).status, 201);
    const work = await send(port, 'work-a', 'cmd-work', '内部工具：list_workspaces');
    assert.equal(work.tools[0]!.status, 'failed');
    assert.equal(work.tools[0]!.result, undefined);
    assert.match(work.reply.text, /list_workspaces 没有完成：Tool list_workspaces not found/u);
  } finally {
    stream?.close();
    stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('HTTP（Fake）：发送时带上的当前视图只作为这一轮的来源交给 get_current_view，不进入幂等指纹；读取其他会话只公开摘要', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-query-tools-http-'));
  const { port, stop } = await startApplication(root);
  try {
    assert.equal((await httpJson(port, '/api/sessions', 'POST', { sessionId: 'work-a', title: '接口调研' })).status, 201);
    assert.equal((await httpJson(port, '/api/sessions', 'POST', { sessionId: 'work-b', title: '写周报' })).status, 201);
    await send(port, 'work-a', 'cmd-work', '先把接口列一下');

    const view = {
      panel: 'workspace', narrow: false,
      workspace: { workspaceId: 'default', scene: { parallelCount: 2, viewMode: 'parallel', slots: ['work-b', 'work-a'], focusedSessionId: 'work-a' } },
      management: null,
    };
    const body = {
      commandId: 'cmd-view', assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, contextRefs: [], view,
      text: '第二栏在做什么\n内部工具：get_current_view\n内部工具：read_session_recent {"sessionId":"work-a"}',
    };
    const accepted = await httpJson(port, '/api/assistant/turns', 'POST', body);
    assert.equal(accepted.body.terminalOutcome, 'succeeded', JSON.stringify(accepted.body));
    const page = (await httpJson(port, '/api/assistant/session')).body as AssistantSessionPageResponse;
    const reply = page.messages.at(-1)!.text;
    assert.match(reply, /- 第 2 栏：\[接口调研\]\(multivac:\/\/session\/work-a\)/u);
    assert.match(reply, /用户（[^）]+）：先把接口列一下/u);
    const tools = page.toolExecutions!.filter((tool) => tool.commandId === 'cmd-view');
    assert.deepEqual(tools.map((tool) => [tool.displayName, tool.result?.summary]), [
      ['读取当前视图', '工作区「默认工作区」· 并排 2 栏'],
      ['读取会话内容', '读取「接口调研」最近 2 条'],
    ]);
    // 工具记录只有摘要与对象，不带会话正文。
    assert.equal(JSON.stringify(tools).includes('先把接口列一下'), false);

    // 同一命令换一个视图重试：视图不属于发送内容，按重放返回原回执，不判为冲突。
    const retried = await httpJson(port, '/api/assistant/turns', 'POST', { ...body, view: { ...view, panel: 'home' } });
    assert.equal(retried.status, 200);
    assert.equal(retried.body.commandId, 'cmd-view');
    // 不合法的视图（多余字段）整体拒绝。
    const invalid = await httpJson(port, '/api/assistant/turns', 'POST', {
      ...body, commandId: 'cmd-invalid-view', view: { ...view, title: '伪造的标题' },
    });
    assert.equal(invalid.status, 400);

    // 没有带视图：如实说明拿不到。
    const withoutView = await send(port, GLOBAL_ASSISTANT_SESSION_ID, 'cmd-no-view', '这个是什么\n内部工具：get_current_view');
    assert.equal(withoutView.tools[0]!.status, 'failed');
    assert.match(withoutView.reply.text, /拿不到发起这条消息的窗口的当前视图/u);
  } finally {
    stop();
    await rm(root, { recursive: true, force: true });
  }
});
