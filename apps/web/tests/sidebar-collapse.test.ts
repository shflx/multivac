import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantRunTraceView, ToolAuthorizationRequest } from '@multivac/contracts';
import {
  multivacProcessing,
  sidebarCollapsesWhenWorking,
  type SidebarCollapseInput,
} from '../src/features/assistant/sidebar-collapse.js';

const AT = '2026-09-28T08:00:00.000Z';

function trace(status: AssistantRunTraceView['status'], cursor: string): AssistantRunTraceView {
  return {
    commandId: `command-${cursor}`, cursor, status, entries: [], thinkingTruncated: false,
    startedAt: AT, endedAt: status === 'running' ? null : AT,
  };
}

function authorization(status: ToolAuthorizationRequest['status']): ToolAuthorizationRequest {
  return {
    requestId: 'request-1', sessionId: 'global-coordinator', commandId: 'command-2', toolName: 'write',
    toolCallId: 'tool-1', requestedPath: '../outside.txt', targetPath: '/work/outside.txt',
    workingDirectory: { kind: 'multivac', path: '/work/multivac' }, status, createdAt: AT,
    expiresAt: '2026-09-28T08:30:00.000Z', decidedAt: status === 'pending' ? null : AT,
  };
}

/** 已处理完、没有未发出内容的会话；各用例只改动关心的字段。 */
function session(overrides: Partial<SidebarCollapseInput> = {}): SidebarCollapseInput {
  return {
    status: 'ready',
    pageState: { draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: 3 },
    submitting: false,
    cancelling: false,
    runBusy: false,
    runTraces: [trace('succeeded', '1')],
    authorizations: [authorization('approved')],
    ...overrides,
  };
}

test('开始干活时 Multivac 已处理完、没有未发出的内容即收起；只有空白的草稿不算未发出', () => {
  assert.equal(sidebarCollapsesWhenWorking(session()), true);
  assert.equal(sidebarCollapsesWhenWorking(session({ runTraces: [] })), true);
  assert.equal(sidebarCollapsesWhenWorking(session({
    pageState: { draft: '  \n', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: 4 },
  })), true);
});

test('还在处理（发送中、运行中、对账中、最近一轮仍在运行、等待授权）时保持展开', () => {
  for (const processing of [
    session({ submitting: true }),
    session({ cancelling: true }),
    session({ runBusy: true }),
    session({ runTraces: [trace('succeeded', '1'), trace('running', '2')] }),
    session({ authorizations: [authorization('pending')] }),
  ]) {
    assert.equal(multivacProcessing(processing), true);
    assert.equal(sidebarCollapsesWhenWorking(processing), false);
  }
  // 只看最近一轮：更早的轨迹状态不影响判断。
  assert.equal(multivacProcessing(session({ runTraces: [trace('running', '1'), trace('failed', '2')] })), false);
});

test('侧栏里有未发出的草稿或引用、会话尚未就绪时保持展开', () => {
  assert.equal(sidebarCollapsesWhenWorking(session({
    pageState: { draft: '写了一半', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: 4 },
  })), false);
  assert.equal(sidebarCollapsesWhenWorking(session({
    pageState: {
      draft: '', anchorEntryId: null, anchorOffsetPx: 0, revision: 4,
      quote: { sourcePiSessionId: 'pi-1', sourcePiEntryId: 'entry-1', sourceRole: 'assistant', text: '选中的内容' },
    },
  })), false);
  assert.equal(sidebarCollapsesWhenWorking(session({ status: 'loading' })), false);
  assert.equal(sidebarCollapsesWhenWorking(session({ status: 'error' })), false);
});
