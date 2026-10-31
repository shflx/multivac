import { createHash } from 'node:crypto';
import type { ScheduleInputRequest, InboxDecision } from '@multivac/contracts';
import type { ScheduleRepository } from '../modules/schedules/repository.js';
import { TaskServiceError } from '../modules/tasks/task-error.js';
import { fingerprint } from './task-service.js';
export interface ScheduleInputRepository { all(): ScheduleInputRequest[]; get(id: string): ScheduleInputRequest | null; save(item: ScheduleInputRequest): void }

/** 独立定时会话的澄清请求，无任务外键；只接受 Inbox 的原请求决定。 */
export class ScheduleInputService {
  private readonly waits = new Map<string, { resolve: (value: ScheduleInputRequest) => void; reject: (error: Error) => void }>();
  constructor(private readonly repository: ScheduleInputRepository, private readonly schedules: ScheduleRepository, private readonly changed: (id: string) => void) {}
  all() { return this.repository.all(); }
  recover(): void { for (const item of this.all()) if (item.status === 'pending') this.invalidate(item, '服务重启，旧等待已失效。'); }
  cancel(sessionId: string): void { for (const item of this.all()) if (item.sessionId === sessionId && item.status === 'pending') this.invalidate(item, '本次执行已停止。'); }
  async ask(sessionId: string, commandId: string, question: string, signal: AbortSignal): Promise<ScheduleInputRequest> {
    signal.throwIfAborted();
    const occurrence = this.schedules.bySession(sessionId);
    if (!occurrence || !['running','waiting'].includes(occurrence.status)) throw new Error('当前没有可等待的定时执行。');
    const requestId = `schedule-input:${createHash('sha256').update(JSON.stringify([sessionId, commandId])).digest('hex')}`;
    const existing = this.repository.get(requestId);
    if (existing && existing.question !== question) throw new Error('原请求与本次问题不同。');
    if (existing?.status === 'answered') return existing;
    if (existing?.status === 'invalidated') throw new Error('原请求已失效，不能重开。');
    const now = new Date().toISOString();
    const request: ScheduleInputRequest = existing ?? { requestId, sessionId, scheduleId: occurrence.scheduleId, occurrenceId: occurrence.occurrenceId, revision: 1, question, status: 'pending', answer: '', createdAt: now, updatedAt: now };
    this.schedules.transaction(() => {
      this.repository.save(request);
      this.schedules.saveOccurrence({ ...occurrence, status: 'waiting', reason: '等待 Inbox 回应。' });
    });
    this.changed(requestId);
    return new Promise((resolve, reject) => {
      const onAbort = () => this.invalidate(request, '本次执行已停止。');
      this.waits.set(requestId, { resolve: value => { signal.removeEventListener('abort', onAbort); resolve(value); }, reject: error => { signal.removeEventListener('abort', onAbort); reject(error); } });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
  decide(id: string, input: InboxDecision): void {
    const result = this.schedules.command(`schedule-input-decision:${input.commandId}`, fingerprint({ id, ...input }), () => {
      const request = this.repository.get(id);
      if (!request) throw new TaskServiceError('NOT_FOUND', '请求不存在。');
      const occurrence = this.schedules.occurrence(request.occurrenceId);
      if (request.revision !== input.revision || request.status !== 'pending' || !this.waits.has(id) || !occurrence || !['running','waiting'].includes(occurrence.status)) throw new TaskServiceError('TASK_CONFLICT', '请求或执行已变化，旧回应不会恢复执行。');
      if (!['answer','deny'].includes(input.decision) || input.decision === 'answer' && !input.answer?.trim()) throw new TaskServiceError('INVALID_REQUEST', '请填写回应或选择不采用。');
      const next: ScheduleInputRequest = { ...request, revision: request.revision + 1, status: 'answered', answer: input.decision === 'deny' ? '用户不采用本次建议。' : input.answer!, updatedAt: new Date().toISOString() };
      this.repository.save(next); this.schedules.saveOccurrence({ ...occurrence, status: 'running', reason: null }); return next;
    });
    const wait = this.waits.get(id); this.waits.delete(id); wait?.resolve(result); this.changed(id);
  }
  private invalidate(item: ScheduleInputRequest, reason: string): void {
    const current = this.repository.get(item.requestId);
    if (!current || current.status !== 'pending') return;
    this.repository.save({ ...current, status: 'invalidated', revision: current.revision + 1, answer: reason, updatedAt: new Date().toISOString() });
    const wait = this.waits.get(item.requestId); this.waits.delete(item.requestId); wait?.reject(new Error(reason)); this.changed(item.requestId);
  }
}
