import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import {
  IGNORED_PI_EVENT_TYPES,
  PiCoordinatorEventMapper,
  normalizePiUsage,
  toolInputText,
} from '../src/runtime/executors/pi-event-mapper.js';

function event(value: object): AgentSessionEvent {
  return value as AgentSessionEvent;
}

const usage = {
  input: 10,
  output: 4,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: 17,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};

test('同时间戳助手消息拥有独立身份，恢复时从历史计数继续且增量/结束身份稳定', () => {
  const mapper = new PiCoordinatorEventMapper({
    assistantSessionId: 'a', piSessionId: 'p', sourceInstanceId: 'instance',
    initialMessageIds: ['assistant:9', 'assistant:9'],
  });
  const message = { role: 'assistant', timestamp: 9, content: [] };
  for (const suffix of [3, 4]) {
    const started = mapper.map(event({ type: 'message_start', message }));
    const updated = mapper.map(event({ type: 'message_update', message: { ...message },
      assistantMessageEvent: { type: 'text_delta', delta: '正文' } }));
    const ended = mapper.map(event({ type: 'message_end', message: { ...message } }));
    for (const mapped of [started, updated, ended]) {
      assert.equal(mapped && 'messageId' in mapped ? mapped.messageId : null, `assistant:9:${suffix}`);
    }
  }
});

test('PiCoordinatorEventMapper 保留事件顺序、工具关联和 Pi usage', () => {
  const mapper = new PiCoordinatorEventMapper({
    assistantSessionId: 'assistant-1',
    piSessionId: 'pi-1',
    sourceInstanceId: 'test-instance',
    initialSequence: 7,
    now: () => '2026-09-14T08:00:00.000Z',
  });

  const started = mapper.map(event({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'read', args: { z: 1, a: 2 } }));
  const ended = mapper.map(event({
    type: 'tool_execution_end',
    toolCallId: 'a',
    toolName: 'read',
    result: { content: [{ type: 'text', text: '文件内容' }] },
    isError: false,
  }));
  const messageEnded = mapper.map(
    event({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        api: 'test',
        provider: 'test',
        model: 'test',
        usage,
        stopReason: 'stop',
        timestamp: 42,
      },
    }),
  );

  assert.deepEqual(started, {
    eventId: 'pi-1:test-instance:8',
    cursor: 'pi-1:test-instance:8',
    sequence: 8,
    sourceInstanceId: 'test-instance',
    assistantSessionId: 'assistant-1',
    piSessionId: 'pi-1',
    occurredAt: '2026-09-14T08:00:00.000Z',
    type: 'coordinator.tool.started',
    toolCallId: 'b',
    toolName: 'read',
    argumentKeys: ['a', 'z'],
    inputText: 'z: 1\na: 2',
    inputTruncated: false,
  });
  assert.equal(ended?.type, 'coordinator.tool.ended');
  if (ended?.type === 'coordinator.tool.ended') {
    assert.equal(ended.toolCallId, 'a');
    assert.equal(ended.sequence, 9);
    assert.equal('outputText' in ended, false);
  }
  assert.equal(messageEnded?.type, 'coordinator.message.ended');
  if (messageEnded?.type === 'coordinator.message.ended') {
    assert.equal(messageEnded.usage?.totalTokens, 17);
  }
});

test('PiCoordinatorEventMapper 将失败和取消收敛为 run result', () => {
  for (const [stopReason, expected] of [
    ['error', 'failed'],
    ['aborted', 'cancelled'],
  ] as const) {
    const mapper = new PiCoordinatorEventMapper({
      assistantSessionId: 'a', piSessionId: 'p', sourceInstanceId: 'test-instance',
    });
    mapper.map(event({ type: 'agent_start' }));
    mapper.map(
      event({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          api: 'test',
          provider: 'test',
          model: 'test',
          usage,
          stopReason,
          timestamp: 1,
        },
      }),
    );
    const settled = mapper.map(event({ type: 'agent_settled' }));

    assert.equal(settled?.type, `coordinator.run.${expected}`);
    assert.equal(mapper.getLastRunResult()?.status, expected);
  }
});

test('PiCoordinatorEventMapper 保留摘要重试 attempt', () => {
  const mapper = new PiCoordinatorEventMapper({
    assistantSessionId: 'a', piSessionId: 'p', sourceInstanceId: 'test-instance',
  });
  mapper.map(event({
    type: 'summarization_retry_scheduled',
    attempt: 2,
    maxAttempts: 3,
    delayMs: 500,
    errorMessage: 'temporary',
  }));
  const finished = mapper.map(event({ type: 'summarization_retry_finished' }));

  assert.equal(finished?.type, 'coordinator.retry.ended');
  if (finished?.type === 'coordinator.retry.ended') {
    assert.equal(finished.scope, 'summarization');
    assert.equal(finished.attempt, 2);
    assert.equal(finished.outcome, 'unknown');
  }
});

test('PiCoordinatorEventMapper 覆盖运行、消息、工具和队列事件序列', () => {
  const mapper = new PiCoordinatorEventMapper({
    assistantSessionId: 'a', piSessionId: 'p', sourceInstanceId: 'test-instance',
  });
  const message = {
    role: 'assistant',
    content: [],
    api: 'test',
    provider: 'test',
    model: 'test',
    usage,
    stopReason: 'stop',
    timestamp: 9,
  };
  const mapped = [
    mapper.map(event({ type: 'agent_start' })),
    mapper.map(event({ type: 'turn_start' })),
    mapper.map(event({ type: 'message_start', message })),
    mapper.map(event({
      type: 'message_update',
      message,
      assistantMessageEvent: { type: 'text_delta', delta: 'text' },
    })),
    mapper.map(event({
      type: 'message_update',
      message,
      assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' },
    })),
    mapper.map(event({
      type: 'tool_execution_update',
      toolCallId: 'tool-1',
      toolName: 'propose_task',
      args: {},
      partialResult: {},
    })),
    mapper.map(event({ type: 'queue_update', steering: ['a'], followUp: ['b', 'c'] })),
    mapper.map(event({ type: 'turn_end', message, toolResults: [] })),
    mapper.map(event({ type: 'agent_end', messages: [message], willRetry: false })),
    mapper.map(event({ type: 'agent_settled' })),
  ];

  assert.deepEqual(mapped.map((item) => item?.type), [
    'coordinator.run.started',
    'coordinator.turn.started',
    'coordinator.message.started',
    'coordinator.message.delta',
    'coordinator.message.delta',
    'coordinator.tool.updated',
    'coordinator.queue.updated',
    'coordinator.turn.ended',
    'coordinator.run.ended',
    'coordinator.run.completed',
  ]);
  assert.deepEqual(mapped.map((item) => item?.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(mapped[3]?.type === 'coordinator.message.delta' ? mapped[3].channel : undefined, 'text');
  assert.equal(mapped[4]?.type === 'coordinator.message.delta' ? mapped[4].channel : undefined, 'thinking');
  assert.deepEqual(
    mapped[6]?.type === 'coordinator.queue.updated'
      ? [mapped[6].steeringCount, mapped[6].followUpCount]
      : undefined,
    [1, 2],
  );
});

test('PiCoordinatorEventMapper 区分重试取消、耗尽和成功终态', () => {
  const scenarios = [
    {
      name: 'backoff cancelled',
      retryEnd: { type: 'auto_retry_end', success: false, attempt: 1, finalError: 'Retry cancelled' },
      finalMessage: undefined,
      outcome: 'cancelled',
      runStatus: 'cancelled',
    },
    {
      name: 'retry exhausted',
      retryEnd: { type: 'auto_retry_end', success: false, attempt: 2, finalError: 'provider failed' },
      finalMessage: undefined,
      outcome: 'failed',
      runStatus: 'failed',
    },
    {
      name: 'retry succeeded',
      retryEnd: { type: 'auto_retry_end', success: true, attempt: 1 },
      finalMessage: { stopReason: 'stop' },
      outcome: 'succeeded',
      runStatus: 'completed',
    },
  ] as const;

  for (const scenario of scenarios) {
    const mapper = new PiCoordinatorEventMapper({
      assistantSessionId: 'a', piSessionId: 'p', sourceInstanceId: 'test-instance',
    });
    mapper.map(event({ type: 'agent_start' }));
    mapper.map(event({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        api: 'test',
        provider: 'test',
        model: 'test',
        usage,
        stopReason: 'error',
        timestamp: 1,
      },
    }));
    mapper.map(event({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 2,
      delayMs: 100,
      errorMessage: 'sanitized by mapper',
    }));
    if (scenario.finalMessage) {
      mapper.map(event({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          api: 'test',
          provider: 'test',
          model: 'test',
          usage,
          stopReason: scenario.finalMessage.stopReason,
          timestamp: 2,
        },
      }));
    }
    const retryEnded = mapper.map(event(scenario.retryEnd));
    const settled = mapper.map(event({ type: 'agent_settled' }));

    assert.equal(
      retryEnded?.type === 'coordinator.retry.ended' ? retryEnded.outcome : undefined,
      scenario.outcome,
      scenario.name,
    );
    assert.equal(mapper.getLastRunResult()?.status, scenario.runStatus, scenario.name);
    assert.equal(settled?.type, `coordinator.run.${scenario.runStatus}`, scenario.name);
  }
});

test('PiCoordinatorEventMapper 用后续 compaction 结果表达摘要重试成功、失败和取消', () => {
  const scenarios = [
    {
      name: 'success',
      compaction: { type: 'compaction_end', reason: 'threshold', result: { summary: 'secret' }, aborted: false, willRetry: false },
      status: 'succeeded',
      errorCode: undefined,
    },
    {
      name: 'exhausted',
      compaction: { type: 'compaction_end', reason: 'threshold', result: undefined, aborted: false, willRetry: false, errorMessage: 'provider secret' },
      status: 'failed',
      errorCode: 'COMPACTION_FAILED',
    },
    {
      name: 'cancelled',
      compaction: { type: 'compaction_end', reason: 'threshold', result: undefined, aborted: true, willRetry: false },
      status: 'cancelled',
      errorCode: undefined,
    },
  ] as const;

  for (const scenario of scenarios) {
    const mapper = new PiCoordinatorEventMapper({
      assistantSessionId: 'a', piSessionId: 'p', sourceInstanceId: 'test-instance',
    });
    mapper.map(event({
      type: 'summarization_retry_scheduled',
      attempt: 2,
      maxAttempts: 2,
      delayMs: 50,
      errorMessage: 'provider secret',
    }));
    const finished = mapper.map(event({ type: 'summarization_retry_finished' }));
    const compacted = mapper.map(event(scenario.compaction));

    assert.equal(
      finished?.type === 'coordinator.retry.ended' ? finished.outcome : undefined,
      'unknown',
      scenario.name,
    );
    assert.equal(
      compacted?.type === 'coordinator.compaction.ended' ? compacted.status : undefined,
      scenario.status,
      scenario.name,
    );
    assert.equal(
      compacted?.type === 'coordinator.compaction.ended' ? compacted.errorCode : undefined,
      scenario.errorCode,
      scenario.name,
    );
    assert.equal(JSON.stringify(compacted).includes('provider secret'), false, scenario.name);
    assert.equal(JSON.stringify(compacted).includes('secret'), false, scenario.name);
  }
});

test('PiCoordinatorEventMapper 显式忽略无产品语义事件并净化未知事件', () => {
  const mapper = new PiCoordinatorEventMapper({
    assistantSessionId: 'a', piSessionId: 'p', sourceInstanceId: 'test-instance',
  });
  for (const type of IGNORED_PI_EVENT_TYPES) {
    assert.equal(mapper.map({ type }), null);
  }

  const unknown = mapper.map({ type: 'future_secret_event', secret: 'do-not-leak' } as {
    type: string;
  });
  assert.equal(unknown?.type, 'coordinator.unknown');
  assert.equal(JSON.stringify(unknown).includes('do-not-leak'), false);
});

test('normalizePiUsage 拒绝不完整 usage，且不重新计算数值', () => {
  assert.equal(normalizePiUsage({ input: 1 }), undefined);
  assert.deepEqual(normalizePiUsage(usage), {
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    totalTokens: 17,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  });
});

test('工具入参投影为显式字段并隐藏凭据形态文本', () => {
  assert.equal(toolInputText({ command: 'ls -la', timeout: 5000 }), 'command: ls -la\ntimeout: 5000');
  assert.equal(toolInputText(undefined), '');
  // 凭据形态文本不得进入公共执行记录。
  const redacted = toolInputText({ command: 'curl -H "Authorization: Bearer sk-abcdefghijklmnop" https://api.example' });
  assert.equal(redacted.includes('sk-abcdefghijklmnop'), false);
  assert.equal(redacted.includes('[已隐藏凭据]'), true);
});

test('工具输入按 1 KiB UTF-8 截断，结果正文不进入适配事件', () => {
  const mapper = new PiCoordinatorEventMapper({
    assistantSessionId: 'a', piSessionId: 'p', sourceInstanceId: 'test-instance',
  });
  const started = mapper.map(event({
    type: 'tool_execution_start', toolCallId: 'tool-large', toolName: 'bash',
    args: { command: '中'.repeat(400) },
  }));
  assert.equal(started?.type, 'coordinator.tool.started');
  if (started?.type === 'coordinator.tool.started') {
    assert.equal(started.inputTruncated, true);
    assert.equal(Buffer.byteLength(started.inputText, 'utf8') <= 1024, true);
    assert.equal(started.inputText.includes('\uFFFD'), false);
  }

  const ended = mapper.map(event({
    type: 'tool_execution_end', toolCallId: 'tool-large', toolName: 'bash',
    result: { content: [{ type: 'text', text: 'private-output' }] }, isError: false,
  }));
  assert.equal(ended?.type, 'coordinator.tool.ended');
  assert.equal(JSON.stringify(ended).includes('private-output'), false);
});
