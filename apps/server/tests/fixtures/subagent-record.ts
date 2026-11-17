import { GLOBAL_ASSISTANT_SESSION_ID } from '@multivac/contracts';
import { presetAgents } from '../../src/modules/agents/agent.js';
import type { SubagentRecord } from '../../src/modules/agents/subagent-run.js';

/** 使用独立运行 ID 和会话 ID，避免测试把两类身份混为一谈。 */
export function subagentRecord(id: string, directory: string, writeScope: string[] = []): SubagentRecord {
  return {
    context: '', fingerprint: id, workingDirectory: { kind: 'session-temp', path: directory },
    execution: null, runtimeConfig: null, markers: {},
    run: {
      id, sessionId: `subagent-session:${id}`, parentSessionId: GLOBAL_ASSISTANT_SESSION_ID,
      parentCommandId: 'turn', parentToolCallId: `delegate:${id}`, taskId: null, taskRunId: null,
      agent: presetAgents('now')[1]!, executor: null, mode: 'execute', goal: '检查并提交',
      deliverable: '本地提交', reason: '独立执行', writeScope, status: 'running', summary: '',
      summaryTruncated: false, outputBytes: 0, elapsedMs: 0, toolCalls: 0, totalTokens: null,
      currentStep: null, changedFiles: [], commitHashes: [], maxMillis: 30000,
      maxOutputBytes: 1024 * 1024, stopConfirmed: false, createdAt: 'now', startedAt: 'now', endedAt: null,
    },
  };
}
