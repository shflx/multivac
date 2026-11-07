import { meterExecution } from './execution-budget-lease.js';
import { randomUUID } from 'node:crypto';
import type { AssistantPublicEvent, CoordinatorRuntimeConfig, ScheduleOccurrence, WorkingDirectory } from '@multivac/contracts';
import type { AssistantAgentExecution } from '../modules/sessions/assistant-turn.js';
import type { ScheduleRepository } from '../modules/schedules/repository.js';
import type { AssistantSessionRuntime } from './assistant-session-runtime.js';
import type { ScheduleActionResult, ScheduleActionRunner } from './schedule-scheduler.js';

export interface ScheduleExecutionSnapshot {
  runtimeConfig: CoordinatorRuntimeConfig; agentExecution: AssistantAgentExecution; workingDirectory: WorkingDirectory;
  workspaceId: string; tools: string[]; startedAt: string; outputBytes: number; toolCalls: number;
  markers: Record<string, boolean>; stopReason: string | null;
}
export interface ScheduleAgentPorts {
  prepare(item: ScheduleOccurrence, sessionId: string): Promise<Omit<ScheduleExecutionSnapshot, 'startedAt' | 'outputBytes' | 'toolCalls' | 'markers' | 'stopReason'>>;
  createSession(item: ScheduleOccurrence, snapshot: ScheduleExecutionSnapshot): void;
  runtime(sessionId: string): AssistantSessionRuntime;
  stopTools(sessionId: string, commandId: string): Promise<void>;
  stopped(sessionId: string): boolean;
  waiting(sessionId: string): boolean;
  summary(sessionId: string): string;
  notify(item: ScheduleOccurrence, text: string): string;
  changed(id: string): void;
}

/** 在普通会话运行时上叠加真实的 Occurrence 归属；不创建任务或任务运行。 */
export class ScheduleAgentExecution implements ScheduleActionRunner {
  private readonly active = new Map<string, { controller: AbortController; stopping: Promise<boolean> | null }>();
  constructor(private readonly repository: ScheduleRepository, private readonly ports: ScheduleAgentPorts, private readonly now: () => Date = () => new Date()) {}
  snapshot(sessionId: string): ScheduleExecutionSnapshot | null { return this.repository.bySession(sessionId)?.executionSnapshot as unknown as ScheduleExecutionSnapshot | null; }
  remainingMillis(sessionId: string): number {
    const item = this.repository.bySession(sessionId), snapshot = this.snapshot(sessionId);
    return item?.snapshot.action.kind === 'agent' && snapshot ? Math.max(0, item.snapshot.action.budget.maxMillis - (this.now().getTime() - Date.parse(snapshot.startedAt))) : 0;
  }
  lease(sessionId: string, phase: 'starting' | 'check' | 'progress' | 'settled', marker: string, bytes: number): number {
    const remaining = this.repository.transaction(() => {
      const item = this.repository.bySession(sessionId);
      const snapshot = item?.executionSnapshot as unknown as ScheduleExecutionSnapshot | null;
      if (!item || item.snapshot.action.kind !== 'agent' || !snapshot) throw new Error('定时执行身份不可用。');
      const budget = item.snapshot.action.budget;
      meterExecution(snapshot, phase, marker, Math.max(0, bytes));
      this.repository.saveOccurrence({ ...item, executionSnapshot: snapshot as unknown as Record<string, unknown> });
      const blocked = !['running', 'waiting'].includes(item.status) || snapshot.stopReason || this.remainingMillis(sessionId) <= 0 || snapshot.outputBytes >= budget.maxOutputBytes || snapshot.toolCalls > budget.maxToolCalls;
      return { blocked, bytes: Math.max(0, budget.maxOutputBytes - snapshot.outputBytes) };
    });
    if (phase !== 'settled' && remaining.blocked) {
      const item = this.repository.bySession(sessionId);
      if (item && ['running','waiting'].includes(item.status)) void this.stop(item, '每轮时间、输出或工具调用额度已用完。');
      throw new Error('定时执行已停止、待核对或额度耗尽。');
    }
    return remaining.bytes;
  }
  event(event: AssistantPublicEvent): void {
    if (!this.repository.bySession(event.assistantSessionId) || !['assistant.message.delta', 'assistant.thinking.delta'].includes(event.type)) return;
    try { this.lease(event.assistantSessionId, 'progress', 'model-output', Buffer.byteLength(JSON.stringify(event.data))); }
    catch { const item = this.repository.bySession(event.assistantSessionId); if (item) void this.stop(item, '每轮输出或时间额度已用完。'); }
  }
  assertSend(sessionId: string, commandId: string): void {
    const item = this.repository.bySession(sessionId);
    if (!item || commandId !== `schedule-send:${item.occurrenceId}` || !['running', 'waiting'].includes(item.status)) throw new Error('定时会话只接受本次冻结指令；请通过安排发起新一轮。');
    this.lease(sessionId, 'check', 'send', 0);
  }
  async run(item: ScheduleOccurrence, patch: Parameters<ScheduleActionRunner['run']>[1]): Promise<ScheduleActionResult> {
    if (item.snapshot.action.kind !== 'agent') throw new Error('动作类型错误。');
    const sessionId = randomUUID();
    const controller = new AbortController();
    this.active.set(item.occurrenceId, { controller, stopping: null });
    let timer: ReturnType<typeof setInterval> | undefined;
    const deadline = setTimeout(() => { void this.stop(item, '每轮时间额度已用完。'); }, item.snapshot.action.budget.maxMillis); deadline.unref();
    let status: ScheduleActionResult['status'] = 'failed'; let summary = '';
    try {
      // 先保存独立会话意图，再解析配置、分配目录和创建运行时。
      patch({ sessionId });
      const prepared = await Promise.race([this.ports.prepare(item, sessionId), new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('本次执行已停止。')), { once: true }))]);
      controller.signal.throwIfAborted();
      const snapshot: ScheduleExecutionSnapshot = { ...prepared, startedAt: item.startedAt ?? this.now().toISOString(), outputBytes: 0, toolCalls: 0, markers: {}, stopReason: null };
      patch({ executionSnapshot: snapshot as unknown as Record<string, unknown> });
      this.ports.createSession({ ...item, sessionId }, snapshot);
      const runtime = this.ports.runtime(sessionId);
      timer = setInterval(() => {
        if (this.remainingMillis(sessionId) <= 0) { void this.stop(item, '每轮时间额度已用完。'); return; }
        const current = this.repository.occurrence(item.occurrenceId);
        if (current && ['running', 'waiting'].includes(current.status)) {
          const waiting = this.ports.waiting(sessionId);
          if ((current.status === 'waiting') !== waiting) patch({ status: waiting ? 'waiting' : 'running', reason: waiting ? '等待 Inbox 人工授权或回应，额度仍在计时。' : null });
        }
      }, 250); timer.unref();
      const receipt = await runtime.commands.send({ commandId: `schedule-send:${item.occurrenceId}`, assistantSessionId: sessionId,
        text: item.snapshot.action.instruction, agentId: item.snapshot.action.agentId, contextRefs: [] }, { signal: controller.signal });
      const stopReason = this.snapshot(sessionId)?.stopReason;
      await this.ports.stopTools(sessionId, `schedule-send:${item.occurrenceId}`);
      if (!this.ports.stopped(sessionId)) { status = 'reconcile'; summary = '模型已返回，但关联工具或进程停止尚未确认。'; }
      else if (stopReason) { status = 'stopped'; summary = stopReason; }
      else { status = receipt.terminalOutcome === 'succeeded' ? 'succeeded' : receipt.terminalOutcome === 'cancelled' ? 'stopped' : 'failed'; summary = receipt.error?.message ?? this.ports.summary(sessionId) ?? '执行未提供摘要。'; }
    } catch (error) {
      const current = this.repository.occurrence(item.occurrenceId)!;
      try { await this.ports.stopTools(sessionId, `schedule-send:${item.occurrenceId}`); } catch { /* 停止证明由下方统一核对。 */ }
      status = current.sessionId && current.executionSnapshot && !this.ports.stopped(sessionId) ? 'reconcile' : this.snapshot(sessionId)?.stopReason || current.status === 'stopping' ? 'stopped' : 'failed';
      summary = this.snapshot(sessionId)?.stopReason ?? (current.status === 'stopping' ? current.reason : null) ?? (error instanceof Error ? error.message : '定时执行失败，原因未提供。');
    } finally { clearTimeout(deadline); if (timer) clearInterval(timer); this.active.delete(item.occurrenceId); }
    const current = this.repository.occurrence(item.occurrenceId)!;
    if (current.status === 'reconcile') status = 'reconcile';
    const notificationId = this.ports.notify(current, `${item.snapshot.name} · ${status}\n${summary.slice(0, 12000)}`);
    return { status, summary: summary.slice(0, 16000), notificationId };
  }
  async stop(item: ScheduleOccurrence, reason = '用户停止本次执行。'): Promise<boolean> {
    const active = this.active.get(item.occurrenceId);
    if (!active) return item.sessionId ? this.ports.stopped(item.sessionId) : true;
    if (active.stopping) return active.stopping;
    active.stopping = (async () => {
      const current = this.repository.occurrence(item.occurrenceId)!;
      const sessionId = current.sessionId;
      if (!current.executionSnapshot) this.repository.transaction(() => this.repository.saveOccurrence({ ...current, status: 'stopping', reason }));
      if (current.executionSnapshot) {
        const snapshot = current.executionSnapshot as unknown as ScheduleExecutionSnapshot;
        this.repository.transaction(() => this.repository.saveOccurrence({ ...current, status: 'stopping', executionSnapshot: { ...snapshot, stopReason: reason } as unknown as Record<string, unknown> }));
      }
      active.controller.abort();
      if (!sessionId || !current.executionSnapshot) return true;
      await Promise.allSettled([this.ports.runtime(sessionId).commands.cancel({ commandId: `schedule-stop:${item.occurrenceId}`, assistantSessionId: sessionId }), this.ports.stopTools(sessionId, `schedule-send:${item.occurrenceId}`)]);
      for (let attempt = 0; attempt < 20; attempt++) {
        if (this.ports.stopped(sessionId)) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return false;
    })();
    return active.stopping;
  }
}
