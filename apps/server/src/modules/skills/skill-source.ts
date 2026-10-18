import type { SkillAvailability, SkillContext, SkillRef } from '@multivac/contracts';
import type { SkillRepository } from './skill-repository.js';

/**
 * 执行器装载 Skill 时读取的能力：会话可用的 Skill 目录、资源与正文，以及有副作用调用的幂等账本。
 * 可用范围与授权由 Skill 服务判定，执行器只负责以自己的方式交给 Agent。
 */
export interface SkillSource {
  context(sessionId: string): SkillContext;
  catalog(context: SkillContext): SkillAvailability[];
  resource(sessionId: string, ref: SkillRef, path: string, toolCallId: string): Buffer;
  load(sessionId: string, ref: SkillRef, toolCallId: string): string;
  readonly repository: Pick<SkillRepository, 'beginEffect' | 'endEffect'>;
}
