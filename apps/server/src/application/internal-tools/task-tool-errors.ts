import { InternalToolError } from '../../modules/internal-tools/internal-tool.js';
import { TaskServiceError } from '../task-service.js';
import { ProjectServiceError } from '../project-service.js';

/** 将业务校验原因交回模型，便于刷新版本、处理关系或等待真实执行停止。 */
export function taskToolFailure(action: string, error: unknown): never {
  if (error instanceof TaskServiceError || error instanceof ProjectServiceError) throw new InternalToolError(`未能${action}：${error.message}`);
  throw error;
}
