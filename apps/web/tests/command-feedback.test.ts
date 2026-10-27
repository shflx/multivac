import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantPublicEvent } from '@multivac/contracts';
import { progressFeedback } from '../src/features/assistant/command-feedback.js';

const base = {
  cursor: '1', eventId: 'compaction', assistantSessionId: 'session',
  commandId: 'command', occurredAt: '2026-10-26T00:00:00.000Z',
};

function ended(status: 'succeeded' | 'failed' | 'cancelled', willRetry: boolean): AssistantPublicEvent {
  return { ...base, type: 'assistant.compaction.ended', data: { reason: 'threshold', status, willRetry } };
}

test('上下文压缩开始时仍展示压缩过程', () => {
  assert.deepEqual(progressFeedback({ ...base, type: 'assistant.compaction.started', data: { reason: 'threshold' } }), {
    phase: 'compaction', message: '正在压缩会话上下文',
  });
});

test('上下文压缩取消不显示完成，也不提前终结所属运行', () => {
  for (const willRetry of [false, true]) {
    assert.deepEqual(progressFeedback(ended('cancelled', willRetry)), {
      phase: 'processing', message: '会话上下文压缩已取消，继续等待运行结果',
    });
  }
});

test('上下文压缩失败继续等待所属运行的最终结果', () => {
  for (const willRetry of [false, true]) {
    assert.deepEqual(progressFeedback(ended('failed', willRetry)), {
      phase: 'processing', message: '会话上下文压缩失败，继续等待运行结果',
    });
  }
});

test('仅成功压缩显示完成，压缩完成不代表所属运行完成', () => {
  assert.deepEqual(progressFeedback(ended('succeeded', false)), {
    phase: 'processing', message: '上下文压缩完成',
  });
});
