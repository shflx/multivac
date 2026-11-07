import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

async function until(check: () => boolean) {
  const end = Date.now() + 10000;
  while (!check()) { if (Date.now() > end) throw new Error('等待子智能体超时'); await new Promise(r => setTimeout(r, 20)); }
}
async function fixture(adapter?: FakeCoordinatorAdapter) {
  await mkdir('.tmp', { recursive: true }); const root = await mkdtemp(resolve('.tmp/subagent-app-'));
  const app = createMultivacApplication(testApplicationEnvironment(root), adapter ? { coordinatorAdapter: adapter } : {});
  await app.ready;
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const address = app.server.address() as { port: number };
  const http = async (path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  await app.agents.update('general', { commandId: 'delegable', revision: 1, patch: { delegable: true, description: '适合独立检查，不适合需要授权的工作' } });
  assert.equal((await http('/api/sessions', { sessionId: 'parent', title: '父级' })).status, 201);
  const send = (text: string, commandId = 'send') => http('/api/sessions/parent/turns', { assistantSessionId: 'parent', commandId, text, contextRefs: [] });
  return { app, root, http, send, async close() { await new Promise<void>(r => app.server.close(() => r())); await app.close(); await rm(root, { recursive: true, force: true }); } };
}
const input = { agentId: 'general', mode: 'read', goal: '独立检查', context: '资料', deliverable: '给出结论', reason: '并行分析' };
const script = (args = input, call = 'delegate') => `内部工具：delegate_to_subagent#${call} ${JSON.stringify(args)}`;

test('实际父工具同批并行五个，第六个拒绝，结论有界且子会话不进入列表', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const adapter = new FakeCoordinatorAdapter({ seedsHistory: () => false, promptScenarioResolver: text => text.startsWith('目标：') ? 'success' : 'internalTools' });
  const original = adapter.prompt.bind(adapter);
  adapter.prompt = async (id, text, ...args) => { if (text.startsWith('目标：')) await gate; return original(id, text, ...args); };
  const f = await fixture(adapter);
  try {
    const pending = f.send(Array.from({ length: 6 }, (_, i) => script(input, `call-${i}`)).join('\n'));
    await until(() => f.app.subagents.repository.page('parent', 0, 20).total === 5);
    const running = f.app.subagents.repository.page('parent', 0, 20).items;
    assert.equal(running.filter(r => r.run.status === 'running').length, 5);
    release(); assert.equal((await pending).status, 200);
    await until(() => !f.app.subagents.occupies('parent'));
    const records = f.app.subagents.repository.page('parent', 0, 20).items;
    assert.ok(records.every(r => r.run.status === 'succeeded'), JSON.stringify(records.map(r => ({ status: r.run.status, summary: r.run.summary }))));
    assert.ok(records.every(r => r.run.outputBytes > 0 && r.run.executor));
    const history = await f.http('/api/sessions/parent/session');
    assert.match(JSON.stringify(history.body), /最多并发 5/);
    const sessions = JSON.stringify((await f.http('/api/sessions')).body);
    assert.ok(records.every(r => !sessions.includes(r.run.sessionId)));
    assert.ok(records.every(r => r.run.summary.length <= 8000));
  } finally { release(); await f.close(); }
});

test('实际 execute 子级使用共用 bash 真实写入，取消父级确认子级和进程停止', async () => {
  const f = await fixture();
  try {
    const command = "printf 'child' > child.txt && node -e \"setInterval(()=>{},1000)\"";
    const pending = f.send(script({ ...input, mode: 'execute', writeScope: ['child.txt'], context: `bash执行：${JSON.stringify({ command, mode: 'foreground' })}` } as any));
    await until(() => f.app.managedProcesses.list(true).some(p => p.state === 'running'));
    const record = f.app.subagents.repository.page('parent', 0, 20).items[0]!;
    assert.equal(await readFile(join(record.workingDirectory.path, 'child.txt'), 'utf8'), 'child');
    await f.http('/api/sessions/parent/turns/current/cancel', { assistantSessionId: 'parent', commandId: 'cancel' });
    await pending;
    await until(() => !f.app.subagents.occupies('parent'));
    assert.ok(f.app.managedProcesses.list(true).every(p => ['exited', 'failed'].includes(p.state)));
    assert.equal(f.app.subagents.get(record.run.id).stopConfirmed, true);
  } finally { await f.close(); }
});

test('只读子级没有嵌套、MCP、Skill、人工或成果工具', async () => {
  const adapter = new FakeCoordinatorAdapter({ seedsHistory: () => false, promptScenarioResolver: () => 'internalTools' });
  const f = await fixture(adapter);
  try {
    await f.send(script({ ...input, context: '内部工具：request_task_input {"question":"越权"}' }));
    const record = f.app.subagents.repository.page('parent', 0, 20).items[0]!;
    assert.match(record.run.summary, /request_task_input/);
    const creation = adapter.calls.find(c => c.method === 'createSession' && c.input.assistantSessionId === record.run.sessionId);
    assert.ok(creation && creation.method === 'createSession');
    const specs = creation.input.internalTools!.specs.map(s => s.name);
    for (const forbidden of ['delegate_to_subagent', 'request_task_input', 'submit_task_result', 'call_mcp_tool', 'skill_load', 'propose_git_publish']) assert.ok(!specs.includes(forbidden));
  } finally { await f.close(); }
});

test('任务 Run 实际委派多个只读子级，输出归入父任务额度', async () => {
  const f = await fixture();
  try {
    const task = f.app.tasks.create({ commandId: 'task-create', title: '并行检查', goal: [script(input, 'task-a'), script(input, 'task-b')].join('\n') }).task;
    await f.app.taskExecution.control(task.taskId, { commandId: 'task-start', revision: task.revision, action: 'start' });
    await f.app.taskExecution.idle();
    const detail = f.app.tasks.detail(task.taskId);
    const run = detail.runs![0]!;
    const children = f.app.subagents.repository.page(run.sessionId, 0, 20).items;
    assert.equal(children.length, 2);
    assert.ok(children.every(r => r.run.taskRunId === run.runId && r.run.taskId === task.taskId && r.run.status === 'succeeded'), JSON.stringify(children.map(r => r.run)));
    assert.ok(run.outputBytes! >= children.reduce((n, r) => n + r.run.outputBytes, 0));
  } finally { await f.close(); }
});

test('只读过程接口返回完整工具输入输出、分页及真实身份，不提供发送入口', async () => {
  const f = await fixture();
  try {
    await f.send(script({ ...input, mode: 'execute', writeScope: ['output.txt'], context: 'bash执行：' + JSON.stringify({ command: "printf '独立完整输出'", timeout: 5 }) } as any));
    const record = f.app.subagents.repository.page('parent', 0, 20).items[0]!;
    assert.equal(record.run.status, 'succeeded');
    const listing = await f.http('/api/subagents?parentSessionId=parent');
    assert.equal(listing.status, 200); assert.equal(listing.body.items[0].parentTitle, '父级');
    assert.ok(listing.body.items[0].toolCalls > 0);
    const endpoint = `/api/subagents/${record.run.id}/process`;
    const page = await f.http(endpoint + '?limit=2');
    assert.equal(page.body.available, true); assert.equal(page.body.items.length, 2); assert.equal(page.body.nextOffset, 2);
    const full = await f.http(endpoint + '?limit=100');
    assert.ok(full.body.items.some((entry: any) => entry.role === 'tool' && entry.phase === 'input' && entry.text.includes('printf')));
    assert.ok(full.body.items.some((entry: any) => entry.role === 'tool' && entry.phase === 'output' && entry.text.includes('独立完整输出')));
    assert.equal((await f.http(endpoint, {})).status, 405);
    assert.equal((await f.http(`/api/sessions/${record.run.sessionId}/turns`, { commandId: 'bad', assistantSessionId: record.run.sessionId, text: '重新运行', contextRefs: [] })).status, 404);
  } finally { await f.close(); }
});
