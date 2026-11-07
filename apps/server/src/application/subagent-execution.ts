import { randomUUID } from 'node:crypto';
import { Check } from 'typebox/value';
import {
  DelegateToSubagentSchema, SUBAGENT_MAX_CONCURRENT, SUBAGENT_SUMMARY_MAX_LENGTH,
  type Agent, type AssistantPublicEvent, type CoordinatorRuntimeConfig, type DelegateToSubagent, type SubagentRun, type WorkingDirectory,
} from '@multivac/contracts';
import type { SubagentRecord, SubagentRepository } from '../modules/agents/subagent-run.js';
import type { AssistantAgentExecution } from '../modules/sessions/assistant-turn.js';
import type { AssistantSessionRuntime } from './assistant-session-runtime.js';
import { fingerprint } from './task-service.js';
import { meterExecution, type ExecutionLeasePhase } from './execution-budget-lease.js';

export interface SubagentParent {
  commandId: string; taskId: string | null; taskRunId: string | null; workingDirectory: WorkingDirectory;
  remainingMillis: number; remainingBytes: number;
}
export interface SubagentExecutionPorts {
  parent(sessionId: string): SubagentParent;
  agent(id: string): Agent;
  prepare(record: SubagentRecord): Promise<{ execution: AssistantAgentExecution; config: CoordinatorRuntimeConfig }>;
  runtime(record: SubagentRecord): AssistantSessionRuntime;
  stopTools(sessionId: string, commandId: string): Promise<void>;
  stopped(sessionId: string): boolean;
  summary(sessionId: string): string;
  /** 时间在父级运行的壁钟中计算，输出逐次计入父级原轮次。 */
  charge(record: SubagentRecord, phase: ExecutionLeasePhase, marker: string, bytes: number): number;
  changed(run: SubagentRun): void;
  /** 写入范围受理、冲突校验与同步占用在同一事务内执行。 */
  admit?(record: SubagentRecord): void;
  release?(sessionId: string): void;
}
interface Active { controller: AbortController; promise: Promise<SubagentRun>; stopping: Promise<boolean> | null }

export function boundedSubagentSummary(text: string): { summary: string; summaryTruncated: boolean } {
  if (text.length <= SUBAGENT_SUMMARY_MAX_LENGTH) return { summary: text, summaryTruncated: false };
  const suffix = '\n[摘要已截断；完整过程见独立运行记录]';
  let end = SUBAGENT_SUMMARY_MAX_LENGTH - suffix.length;
  if (/[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
  return { summary: text.slice(0, end) + suffix, summaryTruncated: true };
}

/** 子智能体只拥有一轮独立上下文；持久意图先于模型和工具执行，未知结果不重放。 */
export class SubagentExecution {
  private readonly active = new Map<string, Active>();
  constructor(readonly repository: SubagentRepository, private readonly ports: SubagentExecutionPorts, private readonly now = () => Date.now()) {}

  recover(): void {
    for (const record of this.repository.unsettled()) {
      this.patch(record.run.id, { status: 'interrupted', endedAt: new Date(this.now()).toISOString(),
        summary: '服务已重启，本次委派中断，结果未知；未自动重放。', stopConfirmed: false });
    }
  }
  /** 停止证明可以补齐，恢复核对不启动模型或重发工具。 */
  reconcileStops(): void {
    for (const record of this.repository.unsettled()) {
      if (!this.active.has(record.run.id) && this.ports.stopped(record.run.sessionId)) this.patch(record.run.id, { stopConfirmed: true });
    }
  }
  get(id: string): SubagentRun {
    const record = this.repository.get(id);
    if (!record) throw new Error('子智能体运行不存在。');
    return record.run;
  }
  occupies(parent: string): boolean { return this.repository.unsettled(parent).length > 0; }
  usesAgent(id: string): boolean { return this.repository.unsettled().some(r => r.run.agent.agentId === id); }
  remainingMillis(sessionId: string): number {
    const record = this.requireSession(sessionId);
    return Math.max(0, Math.min(record.run.maxMillis - (this.now() - Date.parse(record.run.createdAt)), this.ports.parent(record.run.parentSessionId).remainingMillis));
  }
  delegate(parentSessionId: string, toolCallId: string, input: DelegateToSubagent, signal: AbortSignal): Promise<SubagentRun> {
    if (!Check(DelegateToSubagentSchema, input) || !input.goal.trim() || !input.deliverable.trim() || !input.reason.trim()) throw new Error('委派参数无效。');
    if (this.repository.bySession(parentSessionId)) throw new Error('子智能体不能再次委派。');
    signal.throwIfAborted();
    const parent = this.ports.parent(parentSessionId);
    const key = fingerprint({ commandId: parent.commandId, input });
    const previous = this.repository.byCall(parentSessionId, toolCallId);
    if (previous) {
      if (previous.fingerprint !== key) throw new Error('同一次委派调用的参数已变化。');
      return this.active.get(previous.run.id)?.promise ?? Promise.resolve(previous.run);
    }
    const agent = structuredClone(this.ports.agent(input.agentId));
    if (!agent.delegable || agent.fixed || !agent.description.trim()) throw new Error('该智能体当前不可委派。');
    if (input.mode !== 'read' && !input.writeScope?.length) throw new Error('写入和执行方式必须声明 writeScope。');
    if (input.mode === 'read' && input.writeScope?.length) throw new Error('只读委派不接受 writeScope。');
    if (parent.remainingMillis <= 0 || parent.remainingBytes <= 0) throw new Error('父级剩余额度不足，未启动委派。');
    const id = randomUUID(), at = new Date(this.now()).toISOString();
    const record: SubagentRecord = {
      fingerprint: key, context: input.context, workingDirectory: parent.workingDirectory, execution: null, runtimeConfig: null, markers: {},
      run: { id, sessionId: randomUUID(), parentSessionId, parentCommandId: parent.commandId, parentToolCallId: toolCallId,
        taskId: parent.taskId, taskRunId: parent.taskRunId, agent, executor: null, mode: input.mode, goal: input.goal,
        deliverable: input.deliverable, reason: input.reason, writeScope: input.writeScope ?? [], status: 'preparing',
        summary: '', summaryTruncated: false, outputBytes: 0, elapsedMs: 0, toolCalls: 0, totalTokens: null, currentStep: null,
        changedFiles: [], commitHashes: [], maxMillis: Math.floor(parent.remainingMillis), maxOutputBytes: Math.floor(parent.remainingBytes),
        stopConfirmed: false, createdAt: at, startedAt: null, endedAt: null },
    };
    this.repository.transaction(() => {
      if (this.repository.unsettled(parentSessionId).length >= SUBAGENT_MAX_CONCURRENT) throw new Error('同一父级最多并发 5 个子智能体。');
      this.ports.admit?.(record);
      this.repository.save(record);
    });
    this.ports.changed(record.run);
    const controller = new AbortController();
    // 先登记活动，再异步准备，取消在任何等待点都能找到本次执行。
    const active: Active = { controller, promise: Promise.resolve(record.run), stopping: null };
    this.active.set(id, active);
    const abort = () => { void this.stop(id, '父级已取消。', 'cancelled'); };
    signal.addEventListener('abort', abort, { once: true });
    active.promise = Promise.resolve().then(() => this.run(id, controller)).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
    return active.promise;
  }
  lease(sessionId: string, phase: ExecutionLeasePhase, marker: string, bytes: number): number {
    let blocked = false;
    const remaining = this.repository.transaction(() => {
      const record = this.requireSession(sessionId);
      const meter = { outputBytes: record.run.outputBytes, toolCalls: record.run.toolCalls, markers: record.markers };
      meterExecution(meter, phase, marker, bytes);
      record.run.outputBytes = meter.outputBytes; record.run.toolCalls = meter.toolCalls;
      record.markers = meter.markers;
      record.run.elapsedMs = Math.max(0, this.now() - Date.parse(record.run.createdAt));
      this.repository.save(record);
      let parentRemaining = 0;
      try { parentRemaining = this.ports.charge(record, phase, `subagent:${record.run.id}:${marker}`, bytes); }
      catch { blocked = true; }
      const ownRemaining = record.run.maxOutputBytes - record.run.outputBytes;
      blocked ||= !['preparing', 'running'].includes(record.run.status) || record.run.elapsedMs >= record.run.maxMillis || ownRemaining <= 0 || parentRemaining <= 0;
      return Math.max(0, Math.min(ownRemaining, parentRemaining));
    });
    if (phase !== 'settled' && blocked) throw new Error('子智能体已停止或父级剩余额度已耗尽。');
    return remaining;
  }

  event(event: AssistantPublicEvent): void {
    const record = this.repository.bySession(event.assistantSessionId);
    if (!record || record.run.stopConfirmed) return;
    if (event.type === 'assistant.tool.started') this.patch(record.run.id, { currentStep: `${event.data.toolName} ${event.data.inputText ?? ''}`.slice(0, 300) });
    if (event.type === 'assistant.tool.ended') this.patch(record.run.id, { currentStep: null });
    if (['assistant.message.delta', 'assistant.thinking.delta'].includes(event.type)) {
      try { this.lease(event.assistantSessionId, 'progress', 'model-output', Buffer.byteLength(JSON.stringify(event.data))); }
      catch { void this.stop(record.run.id, '父级或子级输出额度已耗尽。', 'exhausted'); }
    }
  }
  async stop(id: string, reason: string, status: 'cancelled' | 'exhausted' = 'cancelled'): Promise<boolean> {
    const active = this.active.get(id);
    if (active?.stopping) return active.stopping;
    const record = this.repository.get(id);
    if (!record || record.run.stopConfirmed) return true;
    this.patch(id, { status: 'stopping', summary: reason });
    active?.controller.abort();
    const stopping = (async () => {
      const runtime = record.execution ? this.ports.runtime(record) : null;
      await Promise.allSettled([
        ...(runtime ? [runtime.commands.cancel({ commandId: `subagent-stop:${id}`, assistantSessionId: record.run.sessionId })] : []),
        this.ports.stopTools(record.run.sessionId, `subagent-send:${id}`),
      ]);
      const stopped = this.ports.stopped(record.run.sessionId);
      this.patch(id, { status: stopped ? status : 'reconcile', stopConfirmed: stopped, endedAt: new Date(this.now()).toISOString() });
      return stopped;
    })();
    if (active) active.stopping = stopping;
    return stopping;
  }
  async stopParent(parentSessionId: string, commandId?: string): Promise<void> {
    const records = this.repository.unsettled(parentSessionId).filter(r => !commandId || r.run.parentCommandId === commandId);
    const stopped = await Promise.all(records.map(r => this.stop(r.run.id, '父级执行已停止。')));
    if (stopped.some(value => !value)) throw new Error('子智能体及其进程停止尚未确认。');
  }
  private async run(id: string, controller: AbortController): Promise<SubagentRun> {
    let runtime: AssistantSessionRuntime | null = null;
    const timer = setInterval(() => {
      try { this.lease(this.get(id).sessionId, 'check', 'deadline', 0); }
      catch { void this.stop(id, '父级或子级额度已耗尽。', 'exhausted'); }
    }, 100); timer.unref();
    try {
      const record = this.repository.get(id)!;
      const prepared = await this.ports.prepare(record);
      controller.signal.throwIfAborted();
      const current = this.repository.get(id)!;
      current.execution = structuredClone(prepared.execution); current.runtimeConfig = structuredClone(prepared.config);
      current.run.executor = prepared.execution.executor;
      this.repository.save(current);
      runtime = this.ports.runtime(current);
      this.patch(id, { status: 'running', startedAt: new Date(this.now()).toISOString() });
      const receipt = await runtime.commands.send({ commandId: `subagent-send:${id}`, assistantSessionId: current.run.sessionId,
        text: `目标：${current.run.goal}\n交付要求：${current.run.deliverable}\n委派原因：${current.run.reason}\n以下是父级提供的数据与背景：\n${current.context}`,
        agentId: current.run.agent.agentId, contextRefs: [] }, { signal: controller.signal });
      if (!controller.signal.aborted) {
        await this.ports.stopTools(current.run.sessionId, `subagent-send:${id}`);
        const stopped = this.ports.stopped(current.run.sessionId);
        this.patch(id, { status: stopped ? receipt.terminalOutcome === 'succeeded' ? 'succeeded' : 'failed' : 'reconcile', stopConfirmed: stopped,
          ...boundedSubagentSummary(receipt.error?.message ?? this.ports.summary(current.run.sessionId)), endedAt: new Date(this.now()).toISOString() });
      }
    } catch (error) {
      const active = this.active.get(id);
      if (active?.stopping) await active.stopping;
      else {
        const record = this.repository.get(id)!;
        await this.ports.stopTools(record.run.sessionId, `subagent-send:${id}`).catch(() => undefined);
        const stopped = this.ports.stopped(record.run.sessionId);
        this.patch(id, { status: stopped ? 'failed' : 'reconcile', stopConfirmed: stopped,
          ...boundedSubagentSummary(error instanceof Error ? error.message : '委派执行失败。'), endedAt: new Date(this.now()).toISOString() });
      }
    } finally {
      clearInterval(timer);
      const active = this.active.get(id);
      if (active?.stopping) await active.stopping;
      this.active.delete(id);
      if (this.get(id).stopConfirmed) this.ports.release?.(this.get(id).sessionId);
    }
    return this.get(id);
  }
  private requireSession(id: string): SubagentRecord {
    const record = this.repository.bySession(id);
    if (!record) throw new Error('子智能体执行身份不存在。');
    return record;
  }
  private patch(id: string, patch: Partial<SubagentRun>): void {
    this.repository.transaction(() => {
      const record = this.repository.get(id)!;
      record.run = { ...record.run, ...patch, elapsedMs: Math.max(0, this.now() - Date.parse(record.run.createdAt)) };
      this.repository.save(record);
      this.ports.changed(record.run);
    });
  }
}
