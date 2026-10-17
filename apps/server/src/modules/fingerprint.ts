import { createHash } from 'node:crypto';

/**
 * 按 JSON.stringify 原样编码后取 SHA-256 的命令指纹：字段顺序敏感，undefined 字段被省略。
 * 笔记、模型设置与会话发送命令的账本都使用这一编码；已持久化的指纹按原编码核对，修改会让历史重放变成冲突。
 *
 * 任务命令（task-service 的 fingerprint，按键排序且不取哈希）与内部工具参数指纹（按键排序后取哈希）
 * 是不同的编码，不能与此合并。
 */
export function jsonSha256Fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
