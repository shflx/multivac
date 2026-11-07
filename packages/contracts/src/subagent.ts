import { Type } from 'typebox';
import { AgentIdSchema, AgentSchema, AssistantExecutorSchema } from './agent.js';

export const SUBAGENT_MAX_CONCURRENT = 5;
export const SUBAGENT_SUMMARY_MAX_LENGTH = 8000;
export const SubagentModeSchema = Type.Union([Type.Literal('read'), Type.Literal('write'), Type.Literal('execute')]);
export type SubagentMode = Type.Static<typeof SubagentModeSchema>;
export const DelegateToSubagentSchema = Type.Object({
  agentId: AgentIdSchema,
  mode: SubagentModeSchema,
  goal: Type.String({ minLength: 1, maxLength: 8000 }),
  context: Type.String({ maxLength: 16000 }),
  deliverable: Type.String({ minLength: 1, maxLength: 4000 }),
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
  writeScope: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 50 })),
}, { additionalProperties: false });
export type DelegateToSubagent = Type.Static<typeof DelegateToSubagentSchema>;
export const SubagentStatusSchema = Type.Union([
  Type.Literal('preparing'), Type.Literal('running'), Type.Literal('stopping'),
  Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled'),
  Type.Literal('exhausted'), Type.Literal('interrupted'), Type.Literal('reconcile'),
]);
export type SubagentStatus = Type.Static<typeof SubagentStatusSchema>;

/** 公共运行事实；模型配置和完整上下文保存在私有执行记录，不进入父级工具回执。 */
export const SubagentRunSchema = Type.Object({
  id: Type.String(), sessionId: Type.String(), parentSessionId: Type.String(), parentCommandId: Type.String(),
  parentToolCallId: Type.String(), taskId: Type.Union([Type.String(), Type.Null()]), taskRunId: Type.Union([Type.String(), Type.Null()]),
  agent: AgentSchema, executor: Type.Union([AssistantExecutorSchema, Type.Null()]),
  mode: SubagentModeSchema, goal: Type.String(), deliverable: Type.String(), reason: Type.String(),
  writeScope: Type.Array(Type.String()), status: SubagentStatusSchema,
  summary: Type.String({ maxLength: SUBAGENT_SUMMARY_MAX_LENGTH }), summaryTruncated: Type.Boolean(),
  outputBytes: Type.Integer({ minimum: 0 }), elapsedMs: Type.Integer({ minimum: 0 }), toolCalls: Type.Integer({ minimum: 0 }),
  totalTokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]), currentStep: Type.Union([Type.String(), Type.Null()]),
  changedFiles: Type.Array(Type.String()), commitHashes: Type.Array(Type.String()),
  maxMillis: Type.Integer({ minimum: 1 }), maxOutputBytes: Type.Integer({ minimum: 1 }),
  stopConfirmed: Type.Boolean(), createdAt: Type.String(), startedAt: Type.Union([Type.String(), Type.Null()]),
  endedAt: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });
export type SubagentRun = Type.Static<typeof SubagentRunSchema>;
