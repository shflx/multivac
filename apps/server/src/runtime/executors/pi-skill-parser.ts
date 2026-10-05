import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import type { SkillFrontmatterParser } from '../../modules/skills/skill-package.js';
/** SDK 类型留在执行适配层，包校验通过窄接口复用 Pi 的解析语义。 */
export const parseSkillFrontmatter: SkillFrontmatterParser = (text) =>
  parseFrontmatter<Record<string, unknown>>(text);
