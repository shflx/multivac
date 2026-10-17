import type { AssistantApiErrorCode } from '@multivac/contracts';

/**
 * 任务及其相邻业务（人工请求、Inbox、提醒、进程与 Git 通道）的领域错误。
 * code 是对外稳定的错误码，由 HTTP 与工具适配层映射为响应；存储实现直接从这里导入，不依赖应用服务。
 */
export class TaskServiceError extends Error {
  constructor(readonly code: AssistantApiErrorCode, message: string) { super(message); }
}
