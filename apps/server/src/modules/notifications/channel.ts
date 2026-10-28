import type { NotificationChannel, NotificationContent } from '@multivac/contracts';

export type ChannelReadiness = { state: 'ready' } | { state: 'waiting' | 'invalid'; diagnostic: string };
/** diagnostic 只能使用本地固定说明，不得携带协议正文、token 或任意远端错误。 */
export type ChannelSendResult =
  | { outcome: 'accepted'; serverMessageId: string | null }
  | { outcome: 'rejected'; diagnostic: string; credentialsInvalid?: boolean }
  | { outcome: 'not-sent'; diagnostic: string }
  | { outcome: 'unknown'; diagnostic: string };
export interface ChannelSendContext {
  channel: NotificationChannel;
  localMessageId: string;
  signal: AbortSignal;
}
/** 通用层负责互斥、期限与恢复。适配器不接收 Inbox 仓储或业务决定接口。 */
export interface NotificationChannelAdapter {
  readonly type: string;
  readonly capabilities: {
    idempotency: boolean;
    resultQuery: boolean;
  };
  /** 仅在该渠道独立验证后声明。通用执行器仍默认保留未知，不自动重放。 */
  queryResult?(localMessageId: string, context: ChannelSendContext): Promise<ChannelSendResult>;
  readiness(channel: NotificationChannel): ChannelReadiness;
  format(content: NotificationContent): string;
  send(text: string, context: ChannelSendContext): Promise<ChannelSendResult>;
}
export interface StoredDeliveryContent {
  content: NotificationContent;
}
