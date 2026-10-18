import type { InboxNotification, Reminder, ReminderQuery, ReminderTimer } from '@multivac/contracts';

/**
 * 提醒、触发计时与 Inbox 通知的仓储端口。
 * 事实与命令回执在短同步事务内保存；不包含模型、网络或文件操作。
 */
export interface ReminderRepository {
  transaction<T>(operation: () => T): T;
  receipt<T>(commandId: string): { fingerprint: string; result: T } | null;
  /** 同命令重放返回原结果；同命令不同参数报冲突。 */
  command<T>(commandId: string, key: string, operation: () => T): T;
  get(id: string): Reminder | null;
  save(reminder: Reminder): void;
  page(query?: ReminderQuery): { items: Reminder[]; total: number; nextOffset: number | null };
  schedule(reminder: Reminder): void;
  invalidate(id: string): void;
  timer(id: string): ReminderTimer | null;
  due(now: string, limit?: number): string[];
  claim(id: string, now: string): ReminderTimer | null;
  /** 插入通知与标记触发完成原子提交，失败回滚；唯一触发身份保证补发不会重复。 */
  deliver(claim: ReminderTimer, now: string): InboxNotification | null;
  retry(claim: ReminderTimer, now: string): void;
  notifications(): InboxNotification[];
  notification(id: string): InboxNotification | null;
  acknowledge(id: string, revision: number, commandId: string, key: string, now: string): InboxNotification;
}
