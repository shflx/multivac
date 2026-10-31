import { createHash, randomUUID } from 'node:crypto';
import { Check } from 'typebox/value';
import { CreateScheduleSchema, UpdateScheduleSchema, ControlScheduleSchema, ScheduleDraftSchema, previewSchedule, validateScheduleZone, validateScheduleRule, reminderLocalTime, ScheduleQuerySchema, DEFAULT_TASK_BUDGET, DEFAULT_AGENT_ID,
  type Schedule, type ScheduleDraft, type CreateSchedule, type UpdateSchedule, type ControlSchedule, type ScheduleOccurrence, type ScheduleQuery } from '@multivac/contracts';
import type { ScheduleRepository } from '../modules/schedules/repository.js';
import { makeOccurrence } from '../modules/schedules/occurrence.js';
import { TaskServiceError } from '../modules/tasks/task-error.js';
import { fingerprint } from './task-service.js';

/** 独立安排的命令入口。事务仅记录事实；执行由调度器在事务外进行。 */
export class ScheduleService {
  constructor(readonly repository: ScheduleRepository, private readonly now: () => Date = () => new Date(),
    private readonly changed: (id: string) => void = () => {}, private readonly validateAction: (draft: ScheduleDraft) => void = () => {}, private readonly defaultBudget: () => { maxMillis: number; maxOutputBytes: number } = () => DEFAULT_TASK_BUDGET) {}
  get(id: string): Schedule {
    const item = this.repository.get(id);
    if (!item) throw new TaskServiceError('NOT_FOUND', '定时安排不存在。');
    return item;
  }
  context(timeZone?: string) {
    try { if (timeZone) validateScheduleZone(timeZone); }
    catch { throw new TaskServiceError('INVALID_REQUEST', '用户时区无效，请核对 IANA 时区。'); }
    return { currentTime: this.now().toISOString(), timeZone: timeZone ?? null, localTime: timeZone ? reminderLocalTime(this.now(), timeZone) : null,
      defaultAgentId: DEFAULT_AGENT_ID, defaultBudget: { maxMillis: this.defaultBudget().maxMillis, maxOutputBytes: this.defaultBudget().maxOutputBytes, maxToolCalls: 256 },
      limitation: '服务关闭或系统休眠时不执行。周期及 Agent 默认跳过错过，可选只补最近一次；旧单次提醒补发。同安排不重叠，未知结果不重放。Agent 结果只进 Inbox，权限仍走原人工授权。' };
  }
  preview(draft: ScheduleDraft) {
    if (!Check(ScheduleDraftSchema, draft)) throw new TaskServiceError('INVALID_REQUEST', '安排预览参数无效。');
    try {
      const now = this.now();
      validateScheduleRule(draft.rule, draft.timeZone, now);
      return previewSchedule(draft.rule, draft.timeZone, now);
    } catch (error) {
      throw new TaskServiceError('INVALID_REQUEST', error instanceof Error ? error.message : '预览时间无效。');
    }
  }
  page(query: ScheduleQuery = {}) {
    if (!Check(ScheduleQuerySchema, query)) throw new TaskServiceError('INVALID_REQUEST', '安排查询无效。');
    const page = this.repository.page(query);
    return { ...page, items: page.items.map(item => {
      const latest = this.repository.history(item.scheduleId, 0, 1).items[0];
      return { ...item, latest: latest ? { occurrenceId: latest.occurrenceId, status: latest.status, plannedAt: latest.plannedAt } : null };
    }) };
  }
  detail(id: string, offset = 0, limit = 30) {
    const schedule = this.get(id);
    return { schedule, active: this.repository.active(id), history: this.repository.history(id, offset, limit),
      preview: schedule.state === 'active' ? previewSchedule(schedule.rule, schedule.timeZone, this.now()) : [] };
  }
  reconcile(actor: string, commandId: string) {
    const receipt = this.repository.receipt<Schedule | ScheduleOccurrence>(this.commandKey(actor, commandId));
    return { commandId, saved: Boolean(receipt), result: receipt?.result ?? null };
  }
  create(actor: string, input: CreateSchedule): Schedule {
    if (!Check(CreateScheduleSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '创建安排参数无效。');
    const result = this.repository.command(this.commandKey(actor, input.commandId), fingerprint({ actor, kind: 'create', ...input }), () => {
      const draft = this.draft(input);
      const now = this.now().toISOString();
      const item: Schedule = { ...draft, scheduleId: randomUUID(), revision: 1, state: 'active', sourceSessionId: actor,
        createdAt: now, updatedAt: now, legacyReminderId: null, nextAt: previewSchedule(draft.rule, draft.timeZone, this.now(), 1)[0]?.scheduledAt ?? null };
      this.repository.save(item);
      return item;
    });
    this.changed(result.scheduleId);
    return result;
  }
  update(actor: string, input: UpdateSchedule): Schedule {
    if (!Check(UpdateScheduleSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '编辑安排参数无效。');
    const result = this.repository.command(this.commandKey(actor, input.commandId), fingerprint({ actor, kind: 'update', ...input }), () => {
      const current = this.current(input);
      const draft = this.draft(input);
      if (current.action.kind !== draft.action.kind) throw new TaskServiceError('INVALID_REQUEST', '动作类型创建后不能更改。');
      const item: Schedule = { ...current, ...draft, revision: current.revision + 1, updatedAt: this.now().toISOString(),
        nextAt: current.state === 'active' ? previewSchedule(draft.rule, draft.timeZone, this.now(), 1)[0]?.scheduledAt ?? null : null };
      this.repository.save(item);
      this.invalidatePending(current.scheduleId, '安排已编辑，旧配置未开始执行。');
      return item;
    });
    this.changed(result.scheduleId);
    return result;
  }
  control(actor: string, input: ControlSchedule): Schedule | ScheduleOccurrence {
    if (!Check(ControlScheduleSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '控制安排参数无效。');
    const result = this.repository.command(this.commandKey(actor, input.commandId), fingerprint({ actor, kind: 'control', ...input }), () => {
      const current = this.current(input);
      const active = this.repository.active(current.scheduleId);
      if (input.operation === 'trigger') {
        const item = makeOccurrence(current, `manual:${createHash('sha256').update(this.commandKey(actor, input.commandId)).digest('hex')}`, this.now().toISOString(), 'manual');
        if (active) Object.assign(item, { status: 'skipped', reason: '上一轮尚未结束或待核对，本轮不重叠。', endedAt: this.now().toISOString() });
        this.repository.saveOccurrence(item);
        return item;
      }
      if (input.operation === 'stop') {
        if (!active) throw new TaskServiceError('INVALID_REQUEST', '没有可停止的本次执行。');
        if (active.status === 'reconcile') throw new TaskServiceError('INVALID_REQUEST', '旧执行停止事实未知，请先在执行会话核对。');
        const item: ScheduleOccurrence = { ...active, status: active.status === 'pending' ? 'stopped' : 'stopping', reason: '用户要求停止本次。',
          endedAt: active.status === 'pending' ? this.now().toISOString() : null };
        this.repository.saveOccurrence(item);
        return item;
      }
      if (input.operation === 'delete' && active) throw new TaskServiceError('INVALID_REQUEST', '本次尚未结束，请先停止或等待，再删除安排。');
      const state = input.operation === 'pause' ? 'paused' : input.operation === 'enable' ? 'active' : 'deleted';
      const nextAt = state === 'active' ? previewSchedule(current.rule, current.timeZone, this.now(), 1)[0]?.scheduledAt ?? null : null;
      const item: Schedule = { ...current, state: state === 'active' && !nextAt ? 'completed' : state, nextAt,
        revision: current.revision + 1, updatedAt: this.now().toISOString() };
      this.repository.save(item);
      if (state !== 'active') this.invalidatePending(current.scheduleId, '安排已暂停或删除，尚未开始的触发不再执行。');
      return item;
    });
    this.changed(result.scheduleId);
    return result;
  }
  private current(input: { scheduleId: string; revision: number }): Schedule {
    const item = this.get(input.scheduleId);
    if (item.revision !== input.revision) throw new TaskServiceError('TASK_CONFLICT', '安排版本已变化，请读取最新版本。');
    if (item.state === 'deleted') throw new TaskServiceError('INVALID_REQUEST', '安排已删除，历史仅可读取。');
    return item;
  }
  private draft(input: ScheduleDraft): ScheduleDraft {
    if (!input.name.trim() || !(input.action.kind === 'agent' ? input.action.instruction : input.action.text).trim()) throw new TaskServiceError('INVALID_REQUEST', '名称与动作内容不能为空。');
    try { validateScheduleRule(input.rule, input.timeZone, this.now()); this.validateAction(input); }
    catch (error) { throw new TaskServiceError('INVALID_REQUEST', error instanceof Error ? error.message : '安排无效。'); }
    return { name: input.name.trim(), action: input.action, rule: input.rule, timeZone: input.timeZone, missedPolicy: input.missedPolicy };
  }
  private invalidatePending(id: string, reason: string): void {
    const active = this.repository.active(id);
    if (active?.status === 'pending') this.repository.saveOccurrence({ ...active, status: 'skipped', reason, endedAt: this.now().toISOString() });
  }
  private commandKey(actor: string, commandId: string): string { return `schedule:${createHash('sha256').update(JSON.stringify([actor, commandId])).digest('hex')}`; }
}
