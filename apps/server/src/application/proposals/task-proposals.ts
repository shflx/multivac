import { TaskProposalOptionsSchema, TaskProposalPayloadSchema, type TaskProposalPayload } from '@multivac/contracts';
import { createHash } from 'node:crypto';
import { defineProposalKind, ProposalExecutionError, type ProposalKind } from '../../modules/proposals/proposal.js';
import type { TaskService } from '../task-service.js';
import { fingerprint } from '../task-service.js';
import { taskRef } from '../internal-tools/tool-text.js';

/** 确认卡选定的执行智能体：确认时核对能否执行，回执写明名称。 */
export interface TaskProposalAgents {
  /** 能用于执行时返回 null，否则返回原因（不存在、不能被任务选用、模型待核对）。 */
  check(agentId: string): Promise<string | null>;
  name(agentId: string): string;
}

/**
 * 任务确认卡：提议给出任务内容，执行智能体由用户在卡上选择（默认取提议参数，缺省为通用执行）。
 * 确认时按选择核对智能体；“我来处理”的任务不由 Agent 执行，不核对模型。
 */
export function createTaskKind(service: Pick<TaskService, 'preview' | 'create'>, agents: TaskProposalAgents): ProposalKind {
  return defineProposalKind<typeof TaskProposalPayloadSchema, ReturnType<TaskService['preview']>, typeof TaskProposalOptionsSchema>({
    kind: 'task.create', payload: TaskProposalPayloadSchema, options: TaskProposalOptionsSchema,
    prepare(payload) { return { title: `创建任务「${payload.title}」`, preview: service.preview(payload), problem: null, refs: [] }; },
    async revalidate(payload, preview, options) {
      try {
        if (fingerprint(service.preview(payload)) !== fingerprint(preview)) return '任务范围或前置条件已变化。';
        service.preview({ ...payload, agentId: options.agentId });
      } catch (error) { return error instanceof Error ? error.message : '任务条件无法核对。'; }
      return payload.humanOnly ? null : agents.check(options.agentId);
    },
    execute(payload: TaskProposalPayload, _preview, origin, options) {
      const input = { ...payload, agentId: options.agentId };
      try {
        const key = createHash('sha256').update(`${origin.commandId ?? 'user'}:${fingerprint(input)}`).digest('hex');
        const result = service.create({ ...input, commandId: `task-proposal:${key}` }, origin);
        const agent = payload.humanOnly ? '' : `执行智能体「${agents.name(options.agentId)}」，`;
        return { summary: `任务「${result.task.title}」已创建，${agent}尚未启动。`, refs: [taskRef(result.task)] };
      } catch (error) { throw new ProposalExecutionError(error instanceof Error ? error.message : '任务未创建。'); }
    },
  });
}
