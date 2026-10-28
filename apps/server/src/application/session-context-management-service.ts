import { createHash } from 'node:crypto';
import type { CompactSessionContext, ContextCompactionOperation, ContextSnapshot, SessionContextResponse, SessionContextState } from '@multivac/contracts';
import type { CoordinatorAdapter } from '../modules/sessions/coordinator-adapter.js';
import type { AssistantSessionBindingRepository } from '../modules/sessions/assistant-session.js';
import { compactionPending, type ContextCompactionRepository, type StoredContextCompaction } from '../modules/sessions/context-compaction.js';
import { AssistantSessionServiceError } from './assistant-session-service.js';
import type { AssistantOperationLock } from './assistant-operation-lock.js';

const modelIdentityFields = ['provider', 'modelId', 'source', 'profileId', 'protocol'] as const;

/** 查询不调用 initialize；压缩意图与发送、选模、归入项目使用同一会话锁。 */
export class SessionContextManagementService {
  private executing: string | null = null;
  private uncertain: ContextCompactionOperation | null = null;
  constructor(private readonly options: {
    sessionId: string; adapter: CoordinatorAdapter; repository: ContextCompactionRepository;
    bindings: AssistantSessionBindingRepository; lock: AssistantOperationLock;
    supported: () => boolean; isRunning: () => boolean; onChanged: () => void;
    now?: () => string;
  }) {}

  blocksExecution(): boolean {
    if (this.executing !== null) return true;
    const record = this.options.repository.pending(this.options.sessionId);
    return record ? compactionPending(this.inspect(record)) : this.uncertain !== null;
  }

  /** 仅业务写操作调用；先封存只读核对的结果，后续 Pi 追加不能改变原操作的归属。 */
  settleRecoveredOperation(): void {
    if (this.executing !== null) return;
    const pending = this.options.repository.pending(this.options.sessionId);
    if (!pending) return;
    const result = this.inspect(pending);
    if (!compactionPending(result)) {
      this.options.repository.finish({ ...pending, operation: result });
      this.uncertain = null;
    }
  }

  private state(): SessionContextState {
    const { sessionId, adapter } = this.options;
    const snapshot = adapter.capabilities.contextSnapshot ? adapter.contextManagement?.readContext(sessionId) : null;
    let state: SessionContextState;
    if (snapshot?.ok && snapshot.value.sessionId === sessionId) state = snapshot.value;
    else {
      const reason = snapshot ? '会话运行时尚未打开或统计暂不可读取；查询不会初始化会话。' : '当前执行器不支持上下文统计。';
      const current: ContextSnapshot = { sessionId, revision: 'unavailable', model: null, contextWindow: null,
        observedAt: this.now(), measuredAt: null, stale: false, staleReason: null,
        coverage: { systemPrompt: { status: 'unknown', explanation: reason }, toolDefinitions: { status: 'unknown', explanation: reason },
          summary: { status: 'unknown', explanation: reason }, toolResults: { status: 'unknown', explanation: reason }, attachments: { status: 'unknown', explanation: reason } },
        source: 'unavailable', tokens: null, basis: null, unavailableReason: reason };
      state = { sessionId, revision: current.revision, current, lastRequest: null, compaction: { available: false, model: null, reason } };
    }
    const reason = !this.options.supported() ? '此宿主不支持主动压缩。'
      : this.blocksExecution() ? '上次压缩正在执行或等待核对，禁止冲突操作。'
      : this.options.isRunning() ? '会话运行中，暂不能主动压缩。'
      : !adapter.capabilities.nativeCompaction || !adapter.contextManagement ? state.compaction.reason ?? '原生压缩尚不可用。' : null;
    return reason ? { ...state, compaction: { available: false, model: state.compaction.model, reason } } : state;
  }

  get(): SessionContextResponse {
    const state = this.state();
    const stored = this.options.repository.pending(this.options.sessionId) ?? this.options.repository.latest(this.options.sessionId);
    return { state, operation: stored ? this.inspect(stored) : this.uncertain };
  }

  getOperation(operationId: string): ContextCompactionOperation | null {
    const record = this.options.repository.get(this.options.sessionId, operationId);
    return record ? this.inspect(record) : this.uncertain?.operationId === operationId ? this.uncertain : null;
  }

  private inspect(record: StoredContextCompaction): ContextCompactionOperation {
    if (!compactionPending(record.operation) || this.executing === record.operation.operationId) return record.operation;
    const binding = this.options.bindings.get(this.options.sessionId);
    if (record.identity && binding && record.identity.harness === binding.harness &&
      record.identity.runtimeSessionId === binding.runtimeSessionId && record.identity.runtimeSessionRef === binding.runtimeSessionRef) {
      try {
        const result = this.options.adapter.contextManagement?.reconcileCompaction({ identity: record.identity, operation: record.operation });
        if (result?.ok && result.value.operationId === record.operation.operationId && result.value.sessionId === record.operation.sessionId &&
          modelIdentityFields.every(key => result.value.model?.[key] === record.operation.model?.[key]) &&
          !compactionPending(result.value) && (result.value.status !== 'succeeded' || result.value.commitState === 'committed')) return result.value;
      } catch { /* 核对异常不释放原占用。 */ }
    }
    // GET 只读证据，不改账本、不初始化或修复运行时；新命令准入时才保存已核对结果。
    return { ...record.operation, status: 'reconciliation-required', commitState: 'unknown', finishedAt: null,
      error: { code: 'COMPACTION_RESULT_UNKNOWN', message: '上次压缩执行结果待核对；不会自动重发，也不能确认已停止。' } };
  }

  async compact(command: CompactSessionContext): Promise<ContextCompactionOperation> {
    if (command.sessionId !== this.options.sessionId) throw new AssistantSessionServiceError('INVALID_REQUEST', '压缩命令与目标会话不一致。');
    // 锁只覆盖取得执行资格及启动；整个模型请求在锁外等待，其他窗口能及时读取／拒绝。
    const admission = await this.options.lock.run(async () => {
      const fingerprint = createHash('sha256').update(JSON.stringify({ operationId: command.operationId, sessionId: command.sessionId, revision: command.revision })).digest('hex');
      const existing = this.options.repository.get(command.sessionId, command.operationId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new AssistantSessionServiceError('COMMAND_ID_CONFLICT', '同一操作 ID 的参数不一致。');
        const result = this.inspect(existing);
        if (compactionPending(existing.operation) && !compactionPending(result)) {
          this.options.repository.finish({ ...existing, operation: result });
          this.uncertain = null;
        }
        return { result };
      }
      this.settleRecoveredOperation();
      const state = this.state();
      const now = this.now();
      let reason = command.revision !== state.revision ? '上下文已变化，请刷新后再操作。' : state.compaction.reason;
      let available = state.compaction.available && command.revision === state.revision;
      const binding = this.options.bindings.get(command.sessionId);
      if (available && binding) {
        const valid = await this.options.adapter.validateModelSelection(command.sessionId);
        const actual = this.options.adapter.readModelSelection(command.sessionId);
        const expected = state.compaction.model;
        if (!valid.ok || !valid.value || !actual.ok || !actual.value.durable ||
          actual.value.runtimeSessionId !== binding.runtimeSessionId || actual.value.runtimeSessionRef !== binding.runtimeSessionRef ||
          actual.value.model.provider !== expected?.provider || actual.value.model.modelId !== expected.modelId ||
          (actual.value.model.profileId ?? null) !== expected.profileId || (actual.value.model.protocol ?? null) !== expected.protocol ||
          (actual.value.model.source ?? 'base') !== expected.source || this.state().revision !== state.revision || this.options.isRunning()) {
          available = false;
          reason = '压缩前实际持久模型、会话身份或空闲状态无法核对，操作未执行。';
        }
      }
      const op: ContextCompactionOperation = { operationId: command.operationId, sessionId: command.sessionId,
        model: state.compaction.model, status: available && binding ? 'running' : 'unavailable',
        startedAt: now, updatedAt: now, finishedAt: available && binding ? null : now,
        commitState: available && binding ? 'unknown' : 'not-committed', runtimeCommitRef: null,
        before: state.current, after: null, error: available && binding ? null : { code: 'COMPACTION_UNAVAILABLE', message: reason ?? '会话持久身份不可核对。' } };
      const record: StoredContextCompaction = { fingerprint, operation: op, identity: binding ?? null };
      // 其他活动操作由锁及数据库唯一约束共同排斥；不为拒绝操作释放原占用。
      this.options.repository.insert(record);
      if (op.status !== 'running') return { result: op };
      const port = this.options.adapter.contextManagement!;
      this.executing = op.operationId;
      let execution: ReturnType<typeof port.compactContext>;
      try {
        execution = port.compactContext({ sessionId: op.sessionId, operationId: op.operationId,
          expectedRevision: state.revision, expectedModel: op.model! });
      } catch { execution = Promise.reject(new Error('原生压缩结果未知。')); }
      this.options.onChanged();
      return { execution, record };
    });
    if ('result' in admission) return admission.result!;
    const { record } = admission;
    let completed: ContextCompactionOperation;
    try {
      const result = await admission.execution;
      if (!result.ok || result.value.operationId !== command.operationId || result.value.sessionId !== command.sessionId ||
        modelIdentityFields.some(key => result.value.model?.[key] !== record.operation.model?.[key]) ||
        result.value.status === 'succeeded' && result.value.commitState !== 'committed') throw new Error('无法核对原生结果。');
      completed = { ...result.value, before: record.operation.before, startedAt: record.operation.startedAt };
    } catch {
      completed = { ...record.operation, status: 'reconciliation-required', commitState: 'unknown', updatedAt: this.now(),
        error: { code: 'COMPACTION_RESULT_UNKNOWN', message: '原生压缩结果未知；禁止冲突操作，请核对原操作，不会自动重发。' } };
    }
    try { this.options.repository.finish({ ...record, operation: completed }); }
    catch {
      completed = { ...record.operation, status: 'reconciliation-required', commitState: 'unknown',
        error: { code: 'COMPACTION_STORAGE_UNKNOWN', message: '压缩可能已提交，但结果保存失败；保持待核对，不会自动重发。' } };
      this.uncertain = completed;
    }
    this.executing = null;
    this.options.onChanged();
    return completed;
  }

  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }
}
