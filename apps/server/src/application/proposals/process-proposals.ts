import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { TaskIdSchema, type ProcessPreview, type ProcessStop, type ManagedProcess } from '@multivac/contracts';
import { defineProposalKind, ProposalExecutionError, type ProposalKind } from '../../modules/proposals/proposal.js';
import { fingerprint } from '../task-service.js';

const Payload = Type.Object({ processId: TaskIdSchema }, { additionalProperties: false });
export function stopProcessKind(service: { preview(id: string): ProcessPreview; stop(id: string, input: ProcessStop): Promise<ManagedProcess> }): ProposalKind {
  return defineProposalKind<typeof Payload, ProcessPreview>({
    kind: 'process.stop', payload: Payload,
    prepare(payload) {
      const preview = service.preview(payload.processId);
      return { title: `停止「${preview.process.name}」`, preview, problem: null, refs: [] };
    },
    revalidate(payload, preview) {
      try {
        const current = service.preview(payload.processId);
        return current.process.revision === preview.process.revision && current.taskRevision === preview.taskRevision ? null : '进程或来源任务状态已变化，请重新核对停止影响。';
      } catch { return '托管进程已不可用。'; }
    },
    async execute(payload, preview, origin) {
      const hash = createHash('sha256').update(fingerprint({ payload, preview, commandId: origin.commandId })).digest('hex');
      try {
        await service.stop(payload.processId, { commandId: `process-stop:${hash}`, revision: preview.process.revision, taskRevision: preview.taskRevision, confirmed: true });
        return { summary: '停止请求已受理，实际退出状态请查看运行页。', refs: [] };
      } catch (error) { throw new ProposalExecutionError(error instanceof Error ? error.message : '停止请求未完成。'); }
    },
  });
}
