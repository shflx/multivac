import { randomUUID } from 'node:crypto';
import { constants, mkdirSync, openSync, closeSync, fstatSync, fchmodSync, writeSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export interface DiagnosticSource {
  sessionId: string; executionId?: string | null; taskId?: string | null; runId?: string | null;
  kind?: 'task' | 'work' | 'global' | 'reading';
}
export interface DiagnosticModel { provider?: string; id?: string; api?: string }
interface Clock { wall(): number; monotonic(): number }
interface RequestState {
  requestId: string; source: DiagnosticSource; provider: string | undefined; modelId: string | undefined; api: string | undefined;
  startedAt: number; startedMono: number; lastEventAt: number | null; firstEventAt: number | null;
  lastBodyReadAt: number | null; firstBodyReadAt: number | null; firstOutputAt: number | null; lastOutputAt: number | null;
  lastStage: string; bodyBytes: number; bodyChunks: number;
  textChars: number; thinkingChars: number; toolArgumentChars: number; events: number; fetches: number;
}

/** 只提取错误分类，不持久化可能夹带提示词、端点凭据或响应正文的 message。 */
export function diagnosticError(error: unknown): Record<string, unknown> {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const text = typeof value.errorMessage === 'string' ? value.errorMessage : typeof value.message === 'string' ? value.message : '';
  const names = ['AbortError', 'TimeoutError', 'APIConnectionError', 'APIConnectionTimeoutError', 'Error', 'TypeError'];
  const code = text.match(/\b(upstream_[a-z0-9_]+|rate_limit_exceeded|insufficient_quota|context_length_exceeded)\b/i)?.[1];
  const cause = value.cause && typeof value.cause === 'object' ? value.cause as Record<string, unknown> : {};
  const transport = [value.code, cause.code].find(code => typeof code === 'string' && /^(E[A-Z0-9_]+|ERR_HTTP2_[A-Z_]+|UND_ERR_[A-Z_]+)$/.test(code));
  return { errorType: names.includes(String(value.name)) ? value.name : 'OtherError',
    ...(code ? { errorCode: code.toLowerCase() } : {}), ...(transport ? { transportCode: transport } : {}),
    ...(typeof value.status === 'number' ? { httpStatus: value.status } : {}),
    category: /http.?2/i.test(text) ? 'http2' : /timeout|timed out/i.test(text) ? 'timeout' : /connection|network|fetch failed/i.test(text) ? 'connection' : value.name === 'AbortError' ? 'abort' : 'other' };
}

/** 内部诊断文件固定容量；记录失败不影响模型、任务和退出流程，不推送到对话或 Inbox。 */
export class ExecutionDiagnostics {
  readonly bootId = randomUUID();
  readonly path: string;
  private fd: number | undefined;
  private bytes = 0;
  private closed = false;
  private warned = false;
  private readonly requests = new Map<string, RequestState>();
  private readonly executions = new Map<string, DiagnosticSource>();
  private readonly timer: ReturnType<typeof setInterval> | undefined;
  private readonly histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
  private readonly clock: Clock;
  private previousWall: number;
  private previousMono: number;
  private previousCpu = process.cpuUsage();
  private readonly maxBytes: number;
  private readonly interval: number;
  constructor(private readonly directory: string, private readonly source: (sessionId: string) => DiagnosticSource,
    options: { maxBytes?: number; heartbeatMs?: number; clock?: Clock } = {}) {
    this.path = join(directory, 'execution.jsonl');
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    this.interval = options.heartbeatMs ?? 15000;
    this.clock = options.clock ?? { wall: Date.now, monotonic: () => performance.now() };
    this.previousWall = this.clock.wall(); this.previousMono = this.clock.monotonic();
    this.record('service.started', { pid: process.pid, nodeVersion: process.version, schemaVersion: 1 });
    if (this.interval > 0) {
      this.histogram = monitorEventLoopDelay({ resolution: 20 }); this.histogram.enable();
      this.timer = setInterval(() => this.sample(), this.interval); this.timer.unref();
    }
  }
  resolve(sessionId: string): DiagnosticSource {
    try { return this.source(sessionId); } catch { return { sessionId }; }
  }
  record(event: string, fields: Record<string, unknown> = {}): void {
    if (this.closed) return;
    try {
      const line = JSON.stringify({ ...fields, event, bootId: this.bootId, at: new Date(this.clock.wall()).toISOString(), monoMs: Math.round(this.clock.monotonic()) }) + '\n';
      // 单条也有上限；调用方只传身份、枚举、计数和经过提取的错误分类。
      if (Buffer.byteLength(line) > Math.min(16384, this.maxBytes)) return;
      if (this.fd === undefined) {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        this.fd = openSync(this.path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        fchmodSync(this.fd, 0o600);
        this.bytes = fstatSync(this.fd).size;
      }
      if (this.bytes + Buffer.byteLength(line) > this.maxBytes) {
        closeSync(this.fd); this.fd = undefined;
        try { unlinkSync(this.path + '.1'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        renameSync(this.path, this.path + '.1');
        this.fd = openSync(this.path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); fchmodSync(this.fd, 0o600); this.bytes = 0;
      }
      const buffer = Buffer.from(line); let written = 0;
      while (written < buffer.length) written += writeSync(this.fd, buffer, written, buffer.length - written);
      this.bytes += written;
    } catch {
      if (this.fd !== undefined) { try { closeSync(this.fd); } catch { /* 诊断不能影响主流程。 */ } this.fd = undefined; }
      if (!this.warned) { this.warned = true; console.warn('执行诊断日志暂不可写，执行流程保持原策略。'); }
    }
  }
  sample(): void {
    const wall = this.clock.wall(), mono = this.clock.monotonic();
    const wallGapMs = wall - this.previousWall, monoGapMs = mono - this.previousMono;
    const cpu = process.cpuUsage(this.previousCpu); this.previousCpu = process.cpuUsage();
    const heartbeat = { wallGapMs, monoGapMs, clockDifferenceMs: wallGapMs - monoGapMs,
      scheduledDelayMs: Math.max(0, monoGapMs - this.interval), cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
      eventLoopMeanMs: this.histogram ? this.histogram.mean / 1e6 : null,
      eventLoopMaxMs: this.histogram ? this.histogram.max / 1e6 : null,
      eventLoopP99Ms: this.histogram ? this.histogram.percentile(99) / 1e6 : null,
      activeExecutions: this.executions.size, activeRequests: this.requests.size };
    this.record('service.heartbeat', heartbeat);
    if (Math.abs(heartbeat.clockDifferenceMs) > 5000 || heartbeat.scheduledDelayMs > 5000) this.record('service.clock_gap', heartbeat);
    for (const state of this.requests.values()) this.record('model.request.progress', this.requestFields(state));
    for (const source of this.executions.values()) this.record('execution.heartbeat', { ...source });
    this.previousWall = wall; this.previousMono = mono; this.histogram?.reset();
  }
  private requestFields(state: RequestState) {
    return { ...state.source, requestId: state.requestId, provider: state.provider, modelId: state.modelId, api: state.api,
      wallElapsedMs: this.clock.wall() - state.startedAt, monoElapsedMs: this.clock.monotonic() - state.startedMono,
      firstEventAt: state.firstEventAt, lastEventAt: state.lastEventAt, firstBodyReadAt: state.firstBodyReadAt, lastBodyReadAt: state.lastBodyReadAt,
      firstOutputAt: state.firstOutputAt, lastOutputAt: state.lastOutputAt, lastStage: state.lastStage,
      bodyBytes: state.bodyBytes, bodyChunks: state.bodyChunks, textChars: state.textChars, thinkingChars: state.thinkingChars,
      toolArgumentChars: state.toolArgumentChars, modelEvents: state.events, fetches: state.fetches };
  }
  beginRequest(sessionId: string, model: DiagnosticModel, httpObserved: boolean) {
    const state: RequestState = { requestId: randomUUID(), source: this.resolve(sessionId), provider: model.provider, modelId: model.id, api: model.api,
      startedAt: this.clock.wall(), startedMono: this.clock.monotonic(), firstEventAt: null, lastEventAt: null,
      firstBodyReadAt: null, lastBodyReadAt: null, firstOutputAt: null, lastOutputAt: null, lastStage: 'preparing', bodyBytes: 0, bodyChunks: 0, textChars: 0, thinkingChars: 0, toolArgumentChars: 0, events: 0, fetches: 0 };
    this.requests.set(state.requestId, state); this.record('model.request.started', { ...this.requestFields(state), httpObserved });
    let finished = false;
    const record = (event: string, fields: Record<string, unknown> = {}) => this.record(event, { ...this.requestFields(state), ...fields });
    return {
      record,
      payloadReady: () => { state.lastStage = 'payload-ready'; record('model.payload.ready'); },
      fetchStarted: (host: string) => { state.lastStage = 'awaiting-headers'; state.fetches += 1; record('model.http.started', { host, attempt: state.fetches }); return state.fetches; },
      headers: (attempt: number, status: number, ids: Record<string, string>) => { state.lastStage = 'response-headers'; record('model.http.headers', { attempt, httpStatus: status, responseIds: ids }); },
      body: (bytes: number) => { state.lastStage = 'reading-body'; state.bodyBytes += bytes; state.bodyChunks += 1; state.lastBodyReadAt = this.clock.wall(); if (state.firstBodyReadAt === null) { state.firstBodyReadAt = state.lastBodyReadAt; record('model.http.first_body'); } },
      event: (event: { type: string; delta?: string }) => {
        state.events += 1; state.lastEventAt = this.clock.wall();
        if (event.type === 'text_delta') state.textChars += event.delta?.length ?? 0;
        if (event.type === 'thinking_delta') state.thinkingChars += event.delta?.length ?? 0;
        if (event.type === 'toolcall_delta') state.toolArgumentChars += event.delta?.length ?? 0;
        if (['text_delta', 'thinking_delta', 'toolcall_delta'].includes(event.type) && event.delta?.length) {
          state.lastStage = event.type; state.lastOutputAt = state.lastEventAt;
          if (state.firstOutputAt === null) { state.firstOutputAt = state.lastEventAt; record('model.first_output', { outputKind: event.type }); }
        }
        if (state.firstEventAt === null) { state.firstEventAt = state.lastEventAt; record('model.first_event', { eventType: event.type }); }
      },
      finish: (message?: { stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number; totalTokens?: number } }, error?: unknown) => {
        if (finished) return; finished = true;
        record('model.request.ended', { stopReason: message?.stopReason ?? (error ? 'exception' : 'unknown'),
          ...(error || message?.stopReason === 'error' ? diagnosticError(error ?? message) : {}),
          inputTokens: message?.usage?.input, outputTokens: message?.usage?.output, totalTokens: message?.usage?.totalTokens });
        this.requests.delete(state.requestId);
      },
    };
  }
  agentEvent(sessionId: string, event: { type: string; [key: string]: unknown }): void {
    const types = ['agent_start', 'agent_end', 'turn_start', 'turn_end', 'tool_execution_start', 'tool_execution_end', 'auto_retry_start', 'auto_retry_end', 'auto_compaction_start', 'auto_compaction_end', 'summarization_retry_scheduled', 'summarization_retry_finished'];
    if (!types.includes(event.type)) return;
    const source = this.executions.get(sessionId) ?? this.resolve(sessionId);
    if (event.type === 'agent_start') this.executions.set(sessionId, source);
    this.record('execution.' + event.type, { ...source, toolName: event.toolName, toolCallId: event.toolCallId,
      isError: event.isError, attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, success: event.success,
      ...(typeof event.errorMessage === 'string' ? diagnosticError({ errorMessage: event.errorMessage }) : {}) });
    if (event.type === 'agent_end') this.executions.delete(sessionId);
  }
  close(): void {
    if (this.closed) return;
    if (this.timer) clearInterval(this.timer); this.histogram?.disable();
    this.record('service.closed', { activeRequests: this.requests.size, activeExecutions: this.executions.size });
    this.closed = true;
    if (this.fd !== undefined) { try { closeSync(this.fd); } catch { /* 诊断不能阻断应用退出。 */ } this.fd = undefined; }
    this.requests.clear(); this.executions.clear();
  }
}
export type ModelRequestObservation = ReturnType<ExecutionDiagnostics['beginRequest']>;
