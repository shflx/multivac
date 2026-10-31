import { randomUUID, createHash } from 'node:crypto';
import { OCCURRENCE_ACTIVE, previewSchedule, type Schedule, type ScheduleOccurrence } from '@multivac/contracts';
import type { ScheduleRepository } from '../modules/schedules/repository.js';
import { makeOccurrence } from './schedule-service.js';

export interface ScheduleActionResult { status: 'succeeded' | 'failed' | 'stopped' | 'reconcile'; summary: string; notificationId?: string }
export interface ScheduleActionRunner {
  /** 所有副作用之前，执行身份已在数据库提交；patch 在本轮租约内更新快照。 */
  run(item: ScheduleOccurrence, patch: (changes: Partial<Pick<ScheduleOccurrence, 'sessionId' | 'executionSnapshot' | 'status' | 'reason'>>) => void): Promise<ScheduleActionResult>;
  stop(item: ScheduleOccurrence): Promise<boolean>;
}
const LEASE_MS = 30_000;
const LATE_MS = 60_000;
export const scheduledOccurrenceId = (id: string, at: string) => `planned:${createHash('sha256').update(JSON.stringify([id, at])).digest('hex')}`;

/** 单机持久调度。只提交短事务；模型和人工等待不阻塞其他安排。 */
export class ScheduleScheduler {
  readonly owner = randomUUID();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private readonly running = new Map<string, Promise<void>>();
  private readonly stopping = new Set<string>();
  constructor(private readonly repository: ScheduleRepository, private readonly runner: ScheduleActionRunner,
    private readonly changed: (id: string) => void = () => {}, private readonly now: () => Date = () => new Date(),
    private readonly onError: (error: unknown) => void = () => console.warn('定时安排调度失败，请核对服务状态。')) {}
  start(): void {
    if (!this.stopped) return;
    this.recover(); this.stopped = false; this.poll();
  }
  /** 只在持有应用数据目录独占锁的服务启动时调用；未知执行不因租约过期重跑。 */
  recover(): void {
    this.repository.transaction(() => {
      for (const item of this.repository.unsettled()) {
        if (item.status === 'pending' || item.snapshot.action.kind === 'reminder' && item.status !== 'stopping') this.repository.saveOccurrence({ ...item, status: 'pending', leaseOwner: null, leaseUntil: null });
        else this.repository.saveOccurrence({ ...item, status: 'reconcile', reason: '服务重启，旧执行及副作用结果需要只读核对，未自动重跑。', leaseUntil: null });
      }
    });
  }
  /** 测试和轮询共用入口；首次写入触发和游标后，再领取执行。 */
  tick(): void {
    const now = this.now().toISOString();
    for (const candidate of this.repository.due(now)) {
      try {
        this.repository.transaction(() => {
          const item = this.repository.get(candidate.scheduleId);
          if (!item || item.state !== 'active' || !item.nextAt || item.nextAt > now) return;
          this.materialize(item, now);
        });
        this.changed(candidate.scheduleId);
      } catch (error) { this.onError(error); }
    }
    for (const candidate of this.repository.unsettled()) {
      if (this.running.has(candidate.occurrenceId)) {
        if (candidate.status === 'stopping') this.requestStop(candidate);
        else if (candidate.leaseOwner === this.owner) this.repository.transaction(() => {
          const current = this.repository.occurrence(candidate.occurrenceId);
          if (current?.leaseOwner === this.owner && current.status !== 'reconcile') this.repository.saveOccurrence({ ...current, leaseUntil: new Date(this.now().getTime() + LEASE_MS).toISOString() });
        });
        continue;
      }
      if (candidate.status !== 'pending') continue;
      const claim = this.claim(candidate.occurrenceId);
      if (!claim) continue;
      // 注册在途身份早于异步动作；同一 tick 的其他安排仍可领取。
      const promise = Promise.resolve().then(() => this.execute(claim)).finally(() => this.running.delete(claim.occurrenceId));
      this.running.set(claim.occurrenceId, promise);
    }
  }
  /** 停止服务不再派发；所有在途轮次须停止核对，失败保留 reconcile 占用。 */
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    const items = this.repository.unsettled().filter(item => item.leaseOwner === this.owner && item.status !== 'pending');
    await Promise.all(items.map(async item => {
      let confirmed = false;
      try { confirmed = await this.runner.stop(item); if (confirmed) await this.running.get(item.occurrenceId); } catch (error) { this.onError(error); }
      this.repository.transaction(() => {
        const current = this.repository.occurrence(item.occurrenceId);
        if (!current || !OCCURRENCE_ACTIVE.includes(current.status)) return;
        this.repository.saveOccurrence({ ...current, status: confirmed ? 'stopped' : 'reconcile', endedAt: confirmed ? this.now().toISOString() : null,
          reason: confirmed ? '服务关闭，已确认本次停止。' : '服务关闭，本次停止尚未确认，禁止自动重跑。', leaseUntil: null });
      });
    }));
  }
  async settle(): Promise<void> { await Promise.all([...this.running.values()]); }
  private materialize(schedule: Schedule, now: string): void {
    let next = schedule.nextAt!;
    // 长期离线只保留一条有界区间记录，再处理最近八天，避免逐年补扫。
    const boundary = this.now().getTime() - 8 * 86400000;
    if (schedule.rule.kind !== 'once' && Date.parse(next) < boundary) {
      const recent = previewSchedule(schedule.rule, schedule.timeZone, new Date(boundary), 16).filter(x => x.scheduledAt <= now);
      const last = recent.at(-1);
      const record = makeOccurrence(schedule, scheduledOccurrenceId(schedule.scheduleId, next), next, 'planned');
      this.savePlanned({ ...record, status: 'skipped', reason: `长期离线错过区间 ${next} 至 ${last?.scheduledAt ?? now}；仅考虑最近一次，不逐次补跑。`, endedAt: now });
      next = last?.scheduledAt ?? previewSchedule(schedule.rule, schedule.timeZone, this.now(), 1)[0]!.scheduledAt;
    }
    let count = 0;
    while (next <= now && count++ < 64) {
      const preview = previewSchedule(schedule.rule, schedule.timeZone, new Date(Date.parse(next) - 1), 1)[0];
      if (!preview) break;
      const following = previewSchedule(schedule.rule, schedule.timeZone, new Date(next), 1)[0]?.scheduledAt ?? null;
      const late = Date.parse(now) - Date.parse(next) > LATE_MS;
      const catchUp = schedule.rule.kind === 'once' && schedule.action.kind === 'reminder' || schedule.missedPolicy === 'latest' && (!following || following > now);
      const record = makeOccurrence(schedule, scheduledOccurrenceId(schedule.scheduleId, next), next, 'planned');
      record.localTime = preview.localTime;
      const reason = preview.skipReason ? 'DST 不存在的日历时刻，已跳过。' : this.repository.active(schedule.scheduleId)
        ? '上一轮尚未结束或待核对，本轮不重叠。' : late && !catchUp ? '服务离线或时间调整错过，按策略跳过。' : null;
      this.savePlanned(reason ? { ...record, status: 'skipped', reason, endedAt: now } : record);
      if (!following) { next = ''; break; }
      next = following;
    }
    this.repository.save({ ...schedule, nextAt: next || null, state: next ? schedule.state : 'completed', updatedAt: now });
  }
  private savePlanned(item: ScheduleOccurrence): void {
    if (!this.repository.occurrence(item.occurrenceId)) this.repository.saveOccurrence(item);
  }
  private claim(id: string): ScheduleOccurrence | null {
    return this.repository.transaction(() => {
      const item = this.repository.occurrence(id);
      if (!item || item.status !== 'pending' || item.leaseOwner && item.leaseUntil! > this.now().toISOString()) return null;
      const schedule = this.repository.get(item.scheduleId);
      // 原计划单次已经推进 completed，仍可消费已保存的本次触发。
      if (!schedule || schedule.state === 'deleted' || schedule.revision !== item.scheduleRevision || item.source === 'planned' && schedule.state === 'paused') {
        this.repository.saveOccurrence({ ...item, status: 'skipped', reason: '开始前安排状态或版本已变化。', endedAt: this.now().toISOString() }); return null;
      }
      const next: ScheduleOccurrence = { ...item, status: 'running', startedAt: this.now().toISOString(), leaseOwner: this.owner, leaseUntil: new Date(this.now().getTime() + LEASE_MS).toISOString() };
      this.repository.saveOccurrence(next); return next;
    });
  }
  private async execute(item: ScheduleOccurrence): Promise<void> {
    try {
      const result = await this.runner.run(item, changes => {
        this.repository.transaction(() => {
          const current = this.repository.occurrence(item.occurrenceId);
          if (!current || current.leaseOwner !== this.owner || !OCCURRENCE_ACTIVE.includes(current.status) || current.status === 'reconcile') throw new Error('本次执行归属已失效。');
          if (current.status === 'stopping' && changes.status && changes.status !== 'stopping') throw new Error('本次正在停止。');
          this.repository.saveOccurrence({ ...current, ...changes });
        }); this.changed(item.scheduleId);
      });
      this.repository.transaction(() => {
        const current = this.repository.occurrence(item.occurrenceId);
        if (!current || current.leaseOwner !== this.owner || !OCCURRENCE_ACTIVE.includes(current.status) || current.status === 'reconcile') return;
        this.repository.saveOccurrence({ ...current, status: result.status, summary: result.summary,
          notificationId: result.notificationId ?? current.notificationId, endedAt: result.status === 'reconcile' ? null : this.now().toISOString(), leaseUntil: null });
      });
    } catch (error) {
      this.repository.transaction(() => {
        const current = this.repository.occurrence(item.occurrenceId);
        if (current && OCCURRENCE_ACTIVE.includes(current.status) && current.status !== 'reconcile') this.repository.saveOccurrence({ ...current, status: 'reconcile', reason: '动作异常或结果未知，请在执行会话只读核对；未重放。', leaseUntil: null });
      }); this.onError(error);
    }
    this.changed(item.scheduleId);
  }
  private requestStop(item: ScheduleOccurrence): void {
    if (this.stopping.has(item.occurrenceId)) return;
    this.stopping.add(item.occurrenceId);
    void this.runner.stop(item).then(confirmed => {
      if (!confirmed) this.repository.transaction(() => {
        const current = this.repository.occurrence(item.occurrenceId);
        if (current?.status === 'stopping') this.repository.saveOccurrence({ ...current, status: 'reconcile', reason: '停止尚未确认，保留占用，不能开始新一轮。', leaseUntil: null });
      });
    }).catch(this.onError).finally(() => this.stopping.delete(item.occurrenceId));
  }
  private poll(): void {
    if (this.stopped) return;
    try { this.tick(); } catch (error) { this.onError(error); }
    if (!this.stopped) { this.timer = setTimeout(() => this.poll(), 1000); this.timer.unref(); }
  }
}
