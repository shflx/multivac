import type { SqliteReminderRepository } from '../storage/sqlite-reminder-repository.js';
import type { WorkbenchEvents } from './workbench-events.js';
import { UNKNOWN_CHANGE_ORIGIN } from '@multivac/contracts';

/** 与任务调度分离：单次提醒只落库通知，不启动模型或会话。 */
export class ReminderScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  constructor(private readonly repository: SqliteReminderRepository, private readonly events: WorkbenchEvents,
    private readonly now: () => Date = () => new Date(), private readonly onError: () => void = () => console.warn('提醒调度存储失败，下一轮重新核对。')) {}
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.poll();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  /** 公开单轮入口供必要故障恢复测试；租约和完成事实均由数据库核对。 */
  tick(): boolean {
    const due = this.repository.due(this.now().toISOString());
    let progressed = false;
    for (const id of due) {
      let claim;
      try {
        claim = this.repository.claim(id, this.now().toISOString());
        if (!claim) { progressed = true; continue; }
        const notification = this.repository.deliver(claim, this.now().toISOString());
        progressed = true;
        if (notification) this.events.publish({ type: 'inbox.changed', id: notification.id, origin: UNKNOWN_CHANGE_ORIGIN });
      } catch {
        if (claim) {
          try { this.repository.retry(claim, this.now().toISOString()); }
          catch { /* 存储不可用时保留租约，恢复后重新认领。 */ }
        }
        this.onError();
      }
    }
    return due.length === 100 && progressed;
  }
  private poll(): void {
    if (this.stopped) return;
    let more = false;
    try { more = this.tick(); } catch { this.onError(); }
    // 大批补发分轮进行，让其他业务获得事件循环执行机会。
    if (!this.stopped) {
      this.timer = setTimeout(() => this.poll(), more ? 0 : 5000);
      this.timer.unref();
    }
  }
}
