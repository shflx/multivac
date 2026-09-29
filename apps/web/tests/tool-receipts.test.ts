import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assistantToolInputSummary,
  type AssistantToolReceipt,
  type Workspace,
  type WorkspaceSession,
} from '@multivac/contracts';
import { receiptOperations, toolReceipts } from '../src/features/assistant/tool-receipts.js';
import type { ToolExecution } from '../src/features/assistant/tool-executions.js';

function session(sessionId: string, archivedAt: string | null = null): WorkspaceSession {
  return {
    sessionId, title: `会话 ${sessionId}`, kind: 'work', workspaceId: 'default', createdAt: '2026-09-30T00:00:00.000Z',
    archivedAt, parentSessionId: null, originText: null,
    workingDirectory: { kind: 'session-temp', path: `/tmp/${sessionId}` },
  };
}

function record(toolCallId: string, status: ToolExecution['status'], receipt?: AssistantToolReceipt): ToolExecution {
  return {
    toolCallId, toolName: 'archive_session', displayName: '归档会话', detail: null, status,
    ...(receipt ? { result: { summary: '已归档', refs: [], receipt } } : {}),
  } as ToolExecution;
}

test('回执只来自成功且带回执的工具调用，按调用顺序', () => {
  const archived: AssistantToolReceipt = { headline: '已归档「甲」', detail: '', actions: [{ kind: 'restore-session', sessionId: 'a' }] };
  const created: AssistantToolReceipt = { headline: '已新建会话「乙」', detail: '在「默认工作区」中', actions: [{ kind: 'open-session', sessionId: 'b' }] };
  assert.deepEqual(toolReceipts([
    record('t1', 'succeeded', archived),
    record('t2', 'succeeded'),
    record('t3', 'failed', created),
    record('t4', 'succeeded', created),
  ]), [{ toolCallId: 't1', receipt: archived }, { toolCallId: 't4', receipt: created }]);

  // 工具行：管理类工具按“动作 + 关键参数”书写。
  assert.equal(assistantToolInputSummary('create_session', 'title: 接口调研'), '新建会话 接口调研');
  assert.equal(assistantToolInputSummary('archive_session', 'sessionId: a'), '归档会话 a');
  assert.equal(assistantToolInputSummary('restore_session', 'sessionId: a'), '恢复会话 a');
  assert.equal(assistantToolInputSummary('rename_session', 'sessionId: a\ntitle: 新名'), '会话改名为 新名');
});

test('回执上的操作按会话的当前状态：已归档时给“恢复”，已恢复的写“已恢复”并给“在工作区打开”，找不到的不给入口', () => {
  const restore = [{ kind: 'restore-session' as const, sessionId: 'a' }];
  const open = [{ kind: 'open-session' as const, sessionId: 'a' }];

  assert.deepEqual(receiptOperations(restore, [session('a', '2026-09-30T01:00:00.000Z')]).map((operation) => operation.kind), ['restore']);
  assert.deepEqual(receiptOperations(restore, [session('a')]).map((operation) => operation.kind), ['restored', 'open']);
  assert.deepEqual(receiptOperations(open, [session('a')]).map((operation) => operation.kind), ['open']);
  // 已归档的会话同样给“在工作区打开”：打开路径会先说明需要恢复。
  assert.deepEqual(receiptOperations(open, [session('a', '2026-09-30T01:00:00.000Z')]).map((operation) => operation.kind), ['open']);
  // 列表还没读到、或会话已不存在：不给入口。
  assert.deepEqual(receiptOperations(open, null), []);
  assert.deepEqual(receiptOperations(restore, [session('other')]), []);
  // 同一会话只给一个“在工作区打开”。
  assert.deepEqual(receiptOperations([...restore, ...open], [session('a')]).map((operation) => operation.kind), ['restored', 'open']);
});

test('工作区操作的回执：切到工作区（工作区在列表中时）与打开管理页；工具行按“动作 + 关键参数”', () => {
  const research: Workspace = { workspaceId: 'p-1', name: '研究项目', project: null };
  const actions = [
    { kind: 'open-workspace' as const, workspaceId: 'p-1' },
    { kind: 'open-management-page' as const, page: 'models' as const },
  ];
  assert.deepEqual(receiptOperations(actions, [], [research]), [
    { kind: 'open-workspace', workspace: research },
    { kind: 'open-page', page: 'models', label: '设置 · 模型' },
  ]);
  // 工作区列表还没读到或工作区已不存在：不给“切到工作区”。
  assert.deepEqual(receiptOperations(actions, [], null).map((operation) => operation.kind), ['open-page']);

  assert.equal(assistantToolInputSummary('open_session', 'sessionId: a\nslot: 2'), '在工作区打开 a');
  assert.equal(assistantToolInputSummary('set_parallel_count', 'count: 3'), '并排数调为 3');
  assert.equal(assistantToolInputSummary('switch_workspace', 'workspaceId: p-1'), '切到工作区 p-1');
  assert.equal(assistantToolInputSummary('open_management_page', 'page: models'), null);
});
