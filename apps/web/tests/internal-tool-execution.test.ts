import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantPublicEvent } from '@multivac/contracts';
import { assistantToolDisplayName, assistantToolInputSummary } from '@multivac/contracts';
import { applyToolExecutionEvent, toolExecutionStateLabel } from '../src/features/assistant/tool-executions.js';

let cursor = 0;
function event<T extends AssistantPublicEvent['type']>(
  type: T,
  data: Extract<AssistantPublicEvent, { type: T }>['data'],
): AssistantPublicEvent {
  cursor += 1;
  return {
    cursor: String(cursor), eventId: `event-${cursor}`, assistantSessionId: 'global-coordinator',
    commandId: 'command-1', occurredAt: '2026-09-30T08:00:00.000Z', type, data,
  } as AssistantPublicEvent;
}

test('内部工具的工具行：动作 + 对象取自契约的展示口径，成功时带公开的结果摘要，失败时没有', () => {
  assert.equal(assistantToolDisplayName('list_workspaces'), '列出工作区');
  // 没有参数：工具行只写“列出工作区”。
  assert.equal(assistantToolInputSummary('list_workspaces', ''), null);
  // 原型链上的名字不会被当作工具口径。
  assert.equal(assistantToolDisplayName('toString'), 'toString');

  const result = { summary: '共 2 个工作区', refs: [{ kind: 'workspace' as const, workspaceId: 'default', label: '默认工作区' }] };
  const started = applyToolExecutionEvent([], event('assistant.tool.started', {
    toolCallId: 'tool-1', toolName: 'list_workspaces', inputText: '', inputTruncated: false,
  }));
  assert.equal(started[0]!.displayName, '列出工作区');
  assert.equal(started[0]!.detail, null);
  assert.equal(started[0]!.result, undefined);

  const succeeded = applyToolExecutionEvent(started, event('assistant.tool.ended', {
    toolCallId: 'tool-1', toolName: 'list_workspaces', isError: false, result,
  }));
  assert.equal(toolExecutionStateLabel(succeeded[0]!), '已完成');
  assert.deepEqual(succeeded[0]!.result, result);

  const failed = applyToolExecutionEvent(started, event('assistant.tool.ended', {
    toolCallId: 'tool-1', toolName: 'list_workspaces', isError: true,
  }));
  assert.equal(toolExecutionStateLabel(failed[0]!), '失败');
  assert.equal(failed[0]!.result, undefined);
});
