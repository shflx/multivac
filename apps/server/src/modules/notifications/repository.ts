import type { NotificationChannel, NotificationChannelOperation, NotificationContent, NotificationDelivery } from '@multivac/contracts';
import type { ChannelSendResult } from './channel.js';

/** 通知业务使用的持久化端口；同步命令保证事实与回执在同一短事务内提交。 */
export interface NotificationChannelRepository {
  command<T>(id: string, fingerprint: string, operation: () => T): T;
  beginOperation(id: string, fingerprint: string): boolean;
  operation(id: string): NotificationChannelOperation;
  finishOperation(id: string, state: 'done' | 'unknown'): void;
  channels(): NotificationChannel[];
  channel(id: string): NotificationChannel | null;
  ensureChannel(id: string, type: string): NotificationChannel;
  requireVersion(id: string, version: number): NotificationChannel;
  setReadiness(id: string, readiness: NotificationChannel['readiness'], diagnostic: string | null): void;
  setEnabled(id: string, version: number, enabled: boolean, now: string): NotificationChannel;
  resetBinding(id: string, version: number, now: string): NotificationChannel;
  deliveries(channelId: string, offset: number, limit: number): { items: NotificationDelivery[]; total: number; nextOffset: number | null };
  content(id: string): NotificationContent;
  saveDelivery(record: NotificationDelivery): void;
  createTest(id: string, version: number, now: string): NotificationDelivery;
  confirmTest(id: string, version: number, deliveryId: string, now: string): NotificationChannel;
  reconcile(now: string): number;
  recover(now: string): void;
  acquire(id: string, owner: string, now: string): NotificationDelivery | null;
  release(id: string, owner: string): void;
  wait(id: string, owner: string, now: string, diagnostic: string): void;
  beginSend(id: string, owner: string, now: string): NotificationDelivery | null;
  finish(sent: NotificationDelivery, owner: string, result: ChannelSendResult, now: string): void;
}
