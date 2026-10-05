import { SkillDraftSchema, type SkillPreview } from '@multivac/contracts';
import { defineProposalKind, ProposalExecutionError } from '../../modules/proposals/proposal.js';
import type { SkillService } from '../skill-service.js';
export function createSkillKind(service: () => SkillService) {
  return defineProposalKind<typeof SkillDraftSchema, SkillPreview>({
    kind: 'skill.register',
    payload: SkillDraftSchema,
    prepare(payload) {
      const preview = service().previewDraft(payload);
      return {
        title: `${payload.skillId ? '更新' : '登记'} Skill「${payload.displayName || preview.manifest.name}」`,
        preview,
      };
    },
    revalidate(_payload, preview) {
      return service().revalidatePreview(preview);
    },
    execute(_payload, preview) {
      try {
        const record = service().confirm(`skill-proposal:${preview.previewId}`, preview.previewId);
        return { summary: `已登记 Skill「${record.displayName}」，版本 ${record.version}。`, refs: [] };
      } catch (e) {
        throw new ProposalExecutionError((e as Error).message);
      }
    },
  });
}
