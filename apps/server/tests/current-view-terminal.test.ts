import assert from 'node:assert/strict';
import test from 'node:test';
import type { CurrentViewSnapshot, ProjectTerminal } from '@multivac/contracts';
import { InternalToolService, WORK_SESSION_TASK_TOOLS, WORK_SESSION_TERMINAL_TOOLS, type InternalToolServices, type InternalToolTurn } from '../src/application/internal-tools/index.js';
import { TerminalError } from '../src/application/terminal-service.js';
import { testToolServices } from './fixtures/tool-services.js';

const view: CurrentViewSnapshot = { panel: 'workspace', narrow: false, management: null,
  workspace: { workspaceId: 'project', scene: null, terminalId: 'terminal' } };
const record: ProjectTerminal = { terminalId: 'terminal', projectId: 'project', instanceId: 'private-instance', title: '当前终端', directory: '/private-directory',
  preset: { kind: 'codex', argv: ['private-argument'] }, status: 'running', lastExit: null, createdAt: 'now', instanceStartedAt: 'now', lastActivityAt: 'now',
  closedAt: null, unread: true, notificationCount: 1, agentSessionId: 'private-session' };

function fixture() {
  let turn: InternalToolTurn = { commandId: 'turn', windowId: 'window', view, terminalAccessAllowed: true };
  let terminal = { ...record };
  let get = () => terminal;
  let recentDays = 7;
  const services = testToolServices({
    projects: { listWorkspaces: () => ({ workspaces: [{ workspaceId: 'default', name: '默认工作区', project: null }, { workspaceId: 'project', name: '当前项目', project: { projectId: 'project', name: '当前项目' } }] }) },
    sessions: { list: () => ({ sessions: [] }), presentedScene: () => ({ scene: { parallelCount: 2, viewMode: 'focus', slots: [], focusedSessionId: null } }) },
    terminals: { get: () => get() },
    recentDays: () => recentDays,
  } as unknown as InternalToolServices);
  const service = new InternalToolService({ tools: WORK_SESSION_TERMINAL_TOOLS, services,
    calls: new Proxy({}, { get: () => { throw new Error('query 不得写入账本'); } }) as never, currentTurn: () => turn });
  return { services, setRecentDays: (value: number) => { recentDays = value; }, setRecord: (value: ProjectTerminal) => { terminal = value; },
    setAccess: (value: boolean | undefined) => { turn = { ...turn, terminalAccessAllowed: value }; },
    setGet: (value: typeof get) => { get = value; },
    setView: (value: CurrentViewSnapshot, windowId: string | null = 'window') => { turn = { ...turn, view: value, windowId }; },
    invoke: (args: unknown = {}) => service.invoke({ assistantSessionId: 'work', toolCallId: 'query', toolName: 'get_current_view', args }, new AbortController().signal) };
}

test('工作会话当前视图明确报告终端和读取方式，不回退为焦点会话，不暴露私有元数据', async () => {
  assert.ok(WORK_SESSION_TERMINAL_TOOLS.some(tool => tool.name === 'get_current_view'));
  assert.equal(WORK_SESSION_TASK_TOOLS.some(tool => tool.name === 'get_current_view'), false);
  const f = fixture();
  for (const [preset, agentSessionId, mode, entry] of [
    [{ kind: 'codex', argv: [] }, 'private-session', 'visible-body', 'read_terminal_message'],
    [{ kind: 'claude', argv: [] }, 'private-session', 'visible-body', 'read_terminal_history'],
    [{ kind: 'blank' }, null, 'authoritative-text', 'read_terminal_screen'],
    [{ kind: 'custom', executable: 'private-executable', argv: [] }, null, null, '没有受支持的读取来源'],
    [{ kind: 'codex', argv: [] }, null, null, '没有受支持的读取来源'],
  ] as const) {
    f.setRecord({ ...record, preset: preset as ProjectTerminal['preset'], agentSessionId });
    const outcome = await f.invoke();
    assert.equal(outcome.ok, true);
    if (!outcome.ok) continue;
    assert.equal(outcome.result.summary, '终端「当前终端」');
    assert.match(outcome.content, /当前焦点终端.*"terminalId":"terminal".*"name":"当前终端"/u);
    assert.ok(outcome.content.includes(JSON.stringify({ mode }).slice(1, -1)));
    assert.ok(outcome.content.includes(entry));
    assert.doesNotMatch(outcome.content, /当前焦点会话|private-/u);
  }
  assert.equal((await f.invoke({ terminalId: 'terminal' })).ok, false);
});

test('当前视图核对日常终端的默认工作区归属', async () => {
  const f = fixture();
  f.setView({ ...view, workspace: { ...view.workspace!, workspaceId: 'default' } });
  f.setRecord({ ...record, projectId: null });
  const outcome = await f.invoke();
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.match(outcome.content, /当前焦点终端.*"terminalId":"terminal"/u);
});

test('当前视图在来源未核定或被撤销后不读取终端元数据，也不回退为焦点会话', async () => {
  const f = fixture();
  let lookups = 0;
  f.setGet(() => { lookups++; return record; });
  for (const allowed of [undefined, false]) {
    f.setAccess(allowed);
    const outcome = await f.invoke();
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.match(outcome.content, /本轮未获本机终端访问资格/u);
      assert.doesNotMatch(outcome.content, /"terminalId"|"preset"|当前终端|read_terminal_|当前焦点会话/u);
    }
  }
  assert.equal(lookups, 0);
  f.setAccess(true);
  const local = await f.invoke();
  assert.equal(local.ok, true);
  if (local.ok) assert.match(local.content, /"terminalId":"terminal"/u);
  assert.equal(lookups, 1);
});

test('当前终端失效、跨项目、服务缺失均如实说明，旧客户端和隐藏工作区不推断终端', async () => {
  const f = fixture();
  f.setGet(() => { throw new TerminalError(404, '终端不存在。'); });
  let outcome = await f.invoke();
  assert.equal(outcome.ok, true);
  if (outcome.ok) { assert.match(outcome.content, /受管理终端已不存在/u); assert.doesNotMatch(outcome.content, /当前焦点会话/u); }
  f.setGet(() => ({ ...record, projectId: 'other-project' }));
  outcome = await f.invoke();
  assert.equal(outcome.ok, true);
  if (outcome.ok) { assert.match(outcome.content, /终端不属于当前工作区/u); assert.doesNotMatch(outcome.content, /read_terminal_|当前终端/u); }
  // 服务暂时不可用不能冒充对象已不存在。
  f.setGet(() => { throw new Error('终端服务故障'); });
  assert.equal((await f.invoke()).ok, false);
  f.services.terminals = undefined;
  outcome = await f.invoke();
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.match(outcome.content, /不支持终端，无法核对/u);
  let hiddenLookups = 0;
  f.services.terminals = { get: () => { hiddenLookups++; return record; } } as NonNullable<InternalToolServices['terminals']>;
  for (const next of [{ ...view, panel: 'home' as const }, { ...view, panel: 'management' as const },
    { ...view, narrow: true }, { ...view, workspace: { workspaceId: 'project', scene: null } }]) {
    f.setView(next);
    outcome = await f.invoke();
    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.doesNotMatch(outcome.content, /"terminalId"|当前终端|read_terminal_/u);
  }
  f.setView(view, null);
  outcome = await f.invoke();
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.doesNotMatch(outcome.content, /"terminalId"/u);
  assert.equal(hiddenLookups, 0);
});


test('最近核对终端真实归属、活动窗口和本机来源', async () => {
  const f = fixture();
  f.setView({ ...view, workspace: { ...view.workspace!, workspaceId: 'recent' } });
  const active = { ...record, lastActivityAt: new Date().toISOString() };
  for (const projectId of ['project', null]) {
    f.setRecord({ ...active, projectId });
    const outcome = await f.invoke();
    assert.ok(outcome.ok);
    assert.equal(outcome.result.summary, '终端「当前终端」');
    assert.ok(outcome.content.includes(`"workspaceId":"${projectId ?? 'default'}"`));
  }
  for (const terminal of [
    { ...active, projectId: 'deleted-project' },
    { ...active, closedAt: active.lastActivityAt },
    { ...active, lastActivityAt: new Date(Date.now() - 2 * 86_400_000).toISOString() },
  ]) {
    f.setRecentDays(1);
    f.setRecord(terminal);
    const outcome = await f.invoke();
    assert.ok(outcome.ok);
    assert.match(outcome.content, /已不在最近集合/u);
    assert.doesNotMatch(outcome.content, /"preset"|read_terminal_|当前焦点会话/u);
  }
  f.setRecord(active);
  f.setRecentDays(0);
  const hidden = await f.invoke();
  assert.ok(hidden.ok);
  assert.match(hidden.content, /已不在最近集合/u);
  f.setAccess(false);
  f.setGet(() => { throw new Error('未获本机访问资格时不得读取终端记录'); });
  const denied = await f.invoke();
  assert.ok(denied.ok);
  assert.match(denied.content, /本轮未获本机终端访问资格/u);
});
