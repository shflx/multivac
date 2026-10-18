import type { SkillManifest, SkillPreview, SkillRecord, SkillUse } from '@multivac/contracts';

/** Skill 登记、版本快照、使用记录与偏好的仓储端口。 */
export interface SkillRepository {
  /** 副作用开始前登记意图；已有结果时返回原结果，不重复执行。 */
  beginEffect(id: string, fingerprint: string): string | null;
  endEffect(id: string, result: string): void;
  recordUse(use: SkillUse): boolean;
  uses(skillId: string): SkillUse[];
  preference(scope: string, id: string): { revision: number; hidden: boolean };
  setPreference(scope: string, id: string, revision: number, hidden: boolean, commandId: string): { revision: number; hidden: boolean; changed: boolean };
  savePreview(preview: SkillPreview): void;
  preview(id: string): SkillPreview;
  list(): SkillRecord[];
  get(id: string): SkillRecord;
  version(id: string, version: string): SkillManifest;
  receipt(id: string, fingerprint: string): SkillRecord | null;
  /** 快照落盘后与登记一起提交；decide 在事务内计算新记录。 */
  commit(commandId: string, fingerprint: string, decide: () => SkillRecord, manifest?: SkillManifest): { record: SkillRecord; changed: boolean };
}
