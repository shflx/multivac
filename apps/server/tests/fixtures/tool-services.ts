import { MULTIVAC_INTERNAL_TOOLS, WORK_SESSION_TASK_TOOLS, type InternalToolCapability, type InternalToolServices } from '../../src/application/internal-tools/index.js';
import { TASK_EXECUTION_TOOLS } from '../../src/application/internal-tools/task-execution-tools.js';
import { READING_TOOLS } from '../../src/application/internal-tools/reading-tools.js';
import { READING_PAGE_TOOLS } from '../../src/application/internal-tools/reading-page-tools.js';
import { unusedCapability } from './unused-capability.js';

const DECLARED = new Set<InternalToolCapability>(
  [...MULTIVAC_INTERNAL_TOOLS, ...WORK_SESSION_TASK_TOOLS, ...TASK_EXECUTION_TOOLS, ...READING_TOOLS, ...READING_PAGE_TOOLS]
    .flatMap((tool) => (tool.requires ?? []) as readonly InternalToolCapability[]),
);

/**
 * 测试用的内部工具能力：用例提供实际使用的能力，其余已声明的必需能力以占位补齐，
 * 满足注册时的完整性核对；占位能力一旦被调用即抛错，避免掩盖意外的工具执行。
 */
export function testToolServices<T extends Partial<InternalToolServices>>(services: T): T & InternalToolServices {
  const filled: Record<string, unknown> = { ...services };
  for (const capability of DECLARED) if (!filled[capability]) filled[capability] = unusedCapability(capability);
  return filled as T & InternalToolServices;
}
