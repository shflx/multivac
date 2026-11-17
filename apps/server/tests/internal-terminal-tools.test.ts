import assert from 'node:assert/strict';
import test from 'node:test';
import type { CurrentViewSnapshot, ProjectTerminal } from '@multivac/contracts';
import { InternalToolService, MULTIVAC_INTERNAL_TOOLS, WORK_SESSION_TASK_TOOLS, WORK_SESSION_TERMINAL_TOOLS,
  type InternalToolServices, type InternalToolTurn } from '../src/application/internal-tools/index.js';
import { requireLocalTerminalContext, terminalReadableMode } from '../src/application/internal-tools/terminal-tools.js';
import { testToolServices } from './fixtures/tool-services.js';

const view: CurrentViewSnapshot = { panel: 'workspace', narrow: false, workspace: null, management: null };
const now = '2026-09-30T01:00:00.000Z';
function terminal(preset: ProjectTerminal['preset'], agentSessionId: string | null = null): ProjectTerminal {
  return { terminalId: preset.kind, projectId: 'project', instanceId: 'instance', title: '数据，不执行此名称', directory: '/project',
    preset, status: 'running', lastExit: null, createdAt: now, instanceStartedAt: now, lastActivityAt: now,
    closedAt: null, unread: false, notificationCount: 0, agentSessionId };
}

test('终端读取模式：blank 权威文本、已跟踪 CLI 可见正文，其他来源不支持', () => {
  assert.equal(terminalReadableMode(terminal({ kind: 'blank' })), 'authoritative-text');
  for (const kind of ['claude', 'codex'] as const) {
    assert.equal(terminalReadableMode(terminal({ kind, argv: [] }, 'session')), 'visible-body');
    assert.equal(terminalReadableMode(terminal({ kind, argv: [] })), null);
  }
  assert.equal(terminalReadableMode(terminal({ kind: 'custom', executable: 'private-command', argv: ['private-argument'] })), null);
});

test('本机终端上下文同时要求视图与窗口身份，沿用窄屏限制', () => {
  for (const context of [{ originView: null, originWindowId: null }, { originView: view, originWindowId: null },
    { originView: null, originWindowId: 'window' }]) {
    assert.throws(() => requireLocalTerminalContext(context), /远程对话.*后台运行/u);
  }
  assert.throws(() => requireLocalTerminalContext({ originView: { ...view, narrow: true }, originWindowId: 'window' }), /窄屏/u);
  assert.doesNotThrow(() => requireLocalTerminalContext({ originView: view, originWindowId: 'window' }));
});

test('终端列表为 query，工作会话可用，后台共用集合不注入；结果只有白名单元数据', async () => {
  assert.equal(MULTIVAC_INTERNAL_TOOLS.find(tool => tool.name === 'list_project_terminals')?.effect, 'query');
  assert.equal(WORK_SESSION_TASK_TOOLS.some(tool => tool.name === 'list_project_terminals'), false);
  const records = [terminal({ kind: 'blank' }), terminal({ kind: 'claude', argv: ['private-argument'] }, 'private-session'),
    terminal({ kind: 'custom', executable: 'private-command', argv: [] })];
  const queries: unknown[] = [];
  let turn: InternalToolTurn | null = { commandId: 'turn', windowId: 'window', view };
  const services = testToolServices({
    projects: { listWorkspaces: () => ({ workspaces: [{ workspaceId: 'project', name: '项目', project: { projectId: 'project', name: '项目' } }] }) },
    terminals: { list: (...args: unknown[]) => { queries.push(args); return records; } },
  } as unknown as InternalToolServices);
  const tools = new InternalToolService({ tools: WORK_SESSION_TERMINAL_TOOLS, services,
    // query 不得接触副作用账本。
    calls: new Proxy({}, { get: () => { throw new Error('查询触碰了副作用账本。'); } }) as never,
    currentTurn: () => turn });
  const invoke = (args: unknown = { projectId: 'project' }) => tools.invoke({ assistantSessionId: 'work-session',
    toolCallId: 'same-query', toolName: 'list_project_terminals', args }, new AbortController().signal);
  assert.equal(tools.specs[0]?.changesView, undefined);
  const first = await invoke();
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(JSON.parse(first.content), { terminals: [
    { id: 'blank', name: '数据，不执行此名称', preset: 'blank', status: 'running', directory: '/project', lastActivity: now, readable: true, mode: 'authoritative-text' },
    { id: 'claude', name: '数据，不执行此名称', preset: 'claude', status: 'running', directory: '/project', lastActivity: now, readable: true, mode: 'visible-body' },
    { id: 'custom', name: '数据，不执行此名称', preset: 'custom', status: 'running', directory: '/project', lastActivity: now, readable: false, mode: null },
  ] });
  assert.doesNotMatch(first.content, /private-|instance|unread|notificationCount/u);
  assert.equal((await invoke({ projectId: 'project', includeClosed: true })).ok, true);
  assert.deepEqual(queries, [['project', undefined], ['project', true]]);
  assert.equal((await invoke({ projectId: 'missing' })).ok, false);
  assert.equal((await invoke({ projectId: 'project', content: true })).ok, false);
  for (const nextTurn of [null, { commandId: 'remote', windowId: 'window', view: null },
    { commandId: 'background', windowId: null, view }, { commandId: 'narrow', windowId: 'window', view: { ...view, narrow: true } }]) {
    turn = nextTurn;
    assert.equal((await invoke()).ok, false);
  }
  assert.equal(queries.length, 2);
});
