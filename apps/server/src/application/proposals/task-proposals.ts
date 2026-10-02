import { TaskProposalPayloadSchema, type TaskProposalPayload } from '@multivac/contracts';
import { createHash } from 'node:crypto';
import { defineProposalKind, ProposalExecutionError, type ProposalKind } from '../../modules/proposals/proposal.js';
import type { TaskService } from '../task-service.js';
import { fingerprint } from '../task-service.js';
import { taskRef } from '../internal-tools/tool-text.js';
export function createTaskKind(service: Pick<TaskService, 'preview' | 'create'>): ProposalKind {
  return defineProposalKind<typeof TaskProposalPayloadSchema, ReturnType<TaskService['preview']>>({
    kind: 'task.create', payload: TaskProposalPayloadSchema,
    prepare(payload) { return { title: `创建任务「${payload.title}」`, preview: service.preview(payload), problem: null, refs: [] }; },
    revalidate(payload, preview) {
      try { return fingerprint(service.preview(payload)) === fingerprint(preview) ? null : '任务范围或前置条件已变化。'; }
      catch (error) { return error instanceof Error ? error.message : '任务条件无法核对。'; }
    },
    execute(payload: TaskProposalPayload, _preview, origin) {
      try {
        const key = createHash('sha256').update(`${origin.commandId ?? 'user'}:${fingerprint(payload)}`).digest('hex');
        const result = service.create({ ...payload, commandId: `task-proposal:${key}` }, origin);
        return { summary: `任务「${result.task.title}」已创建，尚未启动。`, refs: [taskRef(result.task)] };
      } catch (error) { throw new ProposalExecutionError(error instanceof Error ? error.message : '任务未创建。'); }
    },
  });
}
