import type { ExternalOperation } from '@multivac/contracts';

/** 外发操作（例如 Git 发布）的持久记录；结果未知时只读对账，不重放。 */
export interface ExternalOperationRepository {
  operations(): ExternalOperation[];
  operation(id: string): ExternalOperation | null;
  saveOperation(operation: ExternalOperation): void;
}

/** 尚未终结的外发操作会阻止任务继续、完成或删除，与待处理人工请求同属人工门禁。 */
export function blocksTask(operation: ExternalOperation, taskId: string): boolean {
  return operation.taskId === taskId && ['pending', 'executing', 'unknown'].includes(operation.status);
}
