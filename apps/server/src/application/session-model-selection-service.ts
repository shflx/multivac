import { createHash } from 'node:crypto';
import {
  GLOBAL_ASSISTANT_SESSION_ID,
  type CoordinatorModelConfig, type SessionModelSelection, type SessionModelOptions,
  type SessionModelCommandResult, type SetSessionModel, type SetSessionThinkingLevel,
} from '@multivac/contracts';
import type { CoordinatorAdapter, CoordinatorSelectionSnapshot } from '../runtime/executors/coordinator-adapter.js';
import type { SessionSelectionRepository, StoredSessionSelection, StoredSelectionCommand } from '../modules/sessions/session-model-selection.js';
import { sameSessionModelConfig as sameConfig } from '../modules/sessions/session-model-selection.js';
import { AssistantSessionServiceError, type AssistantSessionService } from './assistant-session-service.js';
import type { ModelSettingsService, ModelSettingsReadVersion } from './model-settings-service.js';
import type { ModelAccessService, ModelAccessReadVersion } from './model-access-service.js';
import type { AssistantOperationLock } from './assistant-operation-lock.js';

interface Options {
  adapter: CoordinatorAdapter;
  sessionService: AssistantSessionService;
  repository: SessionSelectionRepository;
  settings: ModelSettingsService;
  access?: ModelAccessService;
  lock: AssistantOperationLock;
  isRunning: () => boolean;
  /** 选模所属会话；缺省为全局协调会话。 */
  sessionId?: string;
}
interface SelectionReadVersion { settings: ModelSettingsReadVersion; access?: ModelAccessReadVersion }

function sameSession(snapshot: CoordinatorSelectionSnapshot, record: StoredSessionSelection): boolean {
  return snapshot.piSessionId === record.piSessionId && snapshot.piSessionPath === record.piSessionPath;
}

/** 只保存选择引用与无秘密命令；所有模型执行、等级归一化和 transcript 仍交给 Pi。 */
export class SessionModelSelectionService {
  private readonly sessionId: string;

  constructor(private readonly options: Options) {
    this.sessionId = options.sessionId ?? GLOBAL_ASSISTANT_SESSION_ID;
  }

  async getOptions(): Promise<SessionModelOptions> {
    await this.initializeForRead();
    return this.options.lock.run(async () => {
      await this.reconcilePending();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const version = await this.readVersion();
          const selection = await this.selection();
          const { snapshot: settings } = await this.options.settings.getSessionSnapshot();
          const access = await this.options.access?.getSnapshot();
          await this.assertVersion(version);
          const running = this.options.isRunning();
          return {
            selection, running, disabledReason: running ? '会话运行中（包含消息接收、重试与压缩），暂不能切换模型或推理等级。'
              : selection.availability.reason === 'SELECTION_RECOVERY_UNAVAILABLE' ? selection.availability.message : null,
            options: settings.profiles.map((profile) => ({
              profileId: profile.profileId, displayName: profile.displayName, provider: profile.provider, modelId: profile.modelId,
              availability: access?.availability.find((item) => item.profileId === profile.profileId) ?? settings.availability.find((item) => item.profileId === profile.profileId)!,
              connection: access?.checks.find((item) => item.profileId === profile.profileId) ?? null,
            })),
          };
        } catch (error) { if (attempt === 2) throw error; }
      }
      throw new AssistantSessionServiceError('ASSISTANT_SESSION_UNAVAILABLE', '模型状态持续变化，无法读取一致快照。');
    });
  }

  async validateForSend(): Promise<void> {
    // 调用方已持共享 handoff 锁；这里不重复获取锁。
    await this.reconcilePending();
    const selection = await this.selection();
    if (!selection.availability.available) throw new AssistantSessionServiceError(
      'ASSISTANT_SESSION_UNAVAILABLE', selection.availability.message ?? '会话选择当前不可用。',
    );
  }

  async withSelectionForSend<T>(dispatch: () => T): Promise<{ value: T }> {
    const version = await this.readVersion();
    await this.validateForSend();
    const record = this.requireRecord();
    return this.withVersion(version, async (assertCurrent) => {
      // base 同样复核 Pi 真实认证；不会因没有 profileId 跳过认证准入。
      const valid = await this.options.adapter.validateModelSelection(record.sessionId);
      if (!valid.ok || !valid.value) throw new AssistantSessionServiceError('ASSISTANT_SESSION_UNAVAILABLE', 'handoff 前 Pi 模型认证或能力已失效。');
      assertCurrent();
      const actual = this.options.adapter.readModelSelection(record.sessionId);
      if (!actual.ok || !sameSession(actual.value, record) || !actual.value.durable ||
        !sameConfig(actual.value.model, record.model) || this.requireRecord().revision !== record.revision) {
        throw new AssistantSessionServiceError('ASSISTANT_SESSION_UNAVAILABLE', 'handoff 前会话选择已变化。');
      }
      // 包装 promise，不在配置/凭据队列中等待整个 Turn；无 await 隔开最终复核和 handoff。
      return { value: dispatch() };
    });
  }

  setModel(command: SetSessionModel) { return this.execute('model', command); }
  setThinkingLevel(command: SetSessionThinkingLevel) { return this.execute('thinking', command); }

  async getCommand(commandId: string): Promise<SessionModelCommandResult> {
    await this.initializeForRead();
    return this.options.lock.run(async () => {
      await this.reconcilePending();
      const record = this.options.repository.getSelectionCommand(commandId);
      return record?.result ? { ...record.result, replayed: true, selection: await this.selection() }
        : this.result(commandId, 'unknown', 'RESULT_UNKNOWN', true);
    });
  }

  private async execute(kind: 'model' | 'thinking', command: SetSessionModel | SetSessionThinkingLevel): Promise<SessionModelCommandResult> {
    await this.initializeForRead();
    if (command.sessionId !== this.sessionId) {
      throw new AssistantSessionServiceError('INVALID_REQUEST', '选模命令的 sessionId 与目标会话不一致。');
    }
    return this.options.lock.run(async () => {
      const fingerprint = createHash('sha256').update(JSON.stringify({
        kind, commandId: command.commandId, sessionId: command.sessionId, revision: command.revision,
        profileId: 'profileId' in command ? command.profileId : null,
        thinkingLevel: 'thinkingLevel' in command ? command.thinkingLevel : null,
      })).digest('hex');
      const existing = this.options.repository.getSelectionCommand(command.commandId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) return this.result(command.commandId, 'failed', 'COMMAND_ID_CONFLICT', true);
        await this.reconcilePending();
        const reconciled = this.options.repository.getSelectionCommand(command.commandId);
        return reconciled?.result ? { ...reconciled.result, replayed: true, selection: await this.selection() }
          : this.result(command.commandId, 'unknown', 'RESULT_UNKNOWN', true);
      }
      await this.reconcilePending();
      const current = this.requireRecord();
      const selection = await this.selection();
      let rejection: string | null = command.revision !== current.revision ? 'SELECTION_REVISION_CONFLICT'
        : this.options.isRunning() ? 'SESSION_RUNNING'
          : current.pending || current.recoveryError || selection.availability.reason === 'SELECTION_RECOVERY_UNAVAILABLE' ? 'SELECTION_RECOVERY_UNAVAILABLE' : null;
      let target = current.model;
      let targetVersion: SelectionReadVersion | undefined;
      if (!rejection) {
        try {
          targetVersion = await this.readVersion();
          if ('profileId' in command) {
            target = { ...await this.options.settings.getModelProfileRuntimeConfig(command.profileId, () => this.assertVersionNow(targetVersion!)), thinkingLevel: selection.thinkingLevel };
          } else {
            if (!selection.availability.available) rejection = 'MODEL_UNAVAILABLE';
            else if (!selection.availableThinkingLevels.includes(command.thinkingLevel)) rejection = 'THINKING_LEVEL_UNAVAILABLE';
            target = { ...current.model, thinkingLevel: command.thinkingLevel };
          }
          await this.assertVersion(targetVersion);
        } catch { rejection = 'MODEL_UNAVAILABLE'; }
      }
      const ledger: StoredSelectionCommand = { commandId: command.commandId, fingerprint, result: null };
      if (rejection || (selection.availability.available && sameConfig(target, current.model) && target.thinkingLevel === selection.thinkingLevel)) {
        const result = await this.result(command.commandId, rejection ? 'failed' : 'succeeded', rejection);
        const storageFailure = await this.begin(current, { ...ledger, result }, current);
        if (storageFailure) return storageFailure;
        return result;
      }
      const begun: StoredSessionSelection = { ...current, revision: current.revision + 1,
        pending: { commandId: command.commandId, previous: current.model, target }, recoveryError: null };
      // 提交失败时绝不调用 Pi；提交后的未知窗口只核对同一意图，不再派发 setter。
      const storageFailure = await this.begin(begun, ledger, current);
      if (storageFailure) return storageFailure;
      let failure: string | null = null;
      try {
        const changed = await this.withVersion(targetVersion!, async (assertCurrent) => {
          assertCurrent();
          return 'profileId' in command
            ? this.options.adapter.setModel(command.sessionId, target, assertCurrent)
            : this.options.adapter.setThinkingLevel(command.sessionId, command.thinkingLevel, assertCurrent);
        });
        if (!changed.ok) failure = 'PI_SELECTION_FAILED';
      } catch { failure = 'PI_SELECTION_FAILED'; }
      const actual = this.options.adapter.readModelSelection(command.sessionId);
      const matched = actual.ok && sameSession(actual.value, current) && actual.value.durable &&
        (sameConfig(actual.value.model, target) || sameConfig(actual.value.model, current.model));
      const finished: StoredSessionSelection = { ...begun,
        model: actual.ok && sameSession(actual.value, current) ? actual.value.model : current.model,
        pending: matched ? null : begun.pending,
        recoveryError: matched ? null : 'Pi 实际模型与持久化选择尚未安全对账，禁止发送。',
      };
      if (!matched || !actual.ok || !sameConfig(actual.value.model, target) ||
        (!('profileId' in command) && actual.value.model.thinkingLevel !== command.thinkingLevel)) failure ??= 'SELECTION_RECOVERY_UNAVAILABLE';
      const result = await this.result(command.commandId, failure ? 'failed' : 'succeeded', failure, false, finished);
      if (result.status === 'succeeded' && !result.selection.availability.available) {
        result.status = 'failed'; result.error = 'MODEL_UNAVAILABLE';
      }
      try { this.options.repository.finishSelection(finished, { ...ledger, result }); }
      catch {
        return this.result(command.commandId, 'unknown', 'SELECTION_STORAGE_FAILED', false, {
          ...finished, pending: begun.pending, recoveryError: 'Pi 可能已切换，但系统保存失败；只允许读取对账，禁止自动重发。',
        });
      }
      // 保存后再次检查当前 auth/config；不能因 setter 成功就伪造可用状态。
      return { ...result, selection: await this.selection() };
    });
  }

  private async reconcilePending(): Promise<void> {
    const record = this.requireRecord();
    if (!record.pending || this.options.isRunning()) return;
    const actual = this.options.adapter.readModelSelection(record.sessionId);
    if (!actual.ok || !sameSession(actual.value, record) || !actual.value.durable ||
      (!sameConfig(actual.value.model, record.pending.previous) && !sameConfig(actual.value.model, record.pending.target))) return;
    const command = this.options.repository.getSelectionCommand(record.pending.commandId);
    if (!command) return;
    const reconciled = { ...record, model: actual.value.model, pending: null, recoveryError: null };
    const result = await this.result(command.commandId, 'failed', 'SELECTION_INTERRUPTED', false, reconciled);
    // 仅账本对账：重启、重复 GET 和事件恢复不调用任何 Pi setter。
    this.options.repository.finishSelection(reconciled, { ...command, result });
  }

  private async begin(selection: StoredSessionSelection, command: StoredSelectionCommand, previous: StoredSessionSelection): Promise<SessionModelCommandResult | null> {
    try { this.options.repository.beginSelection(selection, command); return null; }
    catch {
      let unknown = true;
      try { unknown = Boolean(this.options.repository.getSelectionCommand(command.commandId)); } catch { /* 读取失败时保持未知，不派发 Pi。 */ }
      return this.result(command.commandId, unknown ? 'unknown' : 'failed', 'SELECTION_STORAGE_FAILED', false,
        unknown ? { ...selection, recoveryError: '模型选择意图的保存结果未知；禁止发送，只允许读取原命令对账。' } : previous);
    }
  }

  private async initializeForRead(): Promise<void> {
    try { await this.options.sessionService.initialize(); }
    catch (error) {
      // 恢复歧义或模型被移除时仍公开原引用与不可用状态，管理接口继续可用。
      if (!(error instanceof AssistantSessionServiceError) || !this.options.repository.getSelection(this.sessionId)) throw error;
    }
  }

  private requireRecord(): StoredSessionSelection {
    const record = this.options.repository.getSelection(this.sessionId);
    if (!record || record.sessionId !== this.sessionId) throw new AssistantSessionServiceError('ASSISTANT_SESSION_UNAVAILABLE', '模型选择账本尚未建立或会话身份不一致。');
    return record;
  }

  private async selection(record = this.requireRecord()): Promise<SessionModelSelection> {
    let version: SelectionReadVersion | undefined;
    try { version = await this.readVersion(); } catch { /* 不能读取版本时只公布不可用引用。 */ }
    const snapshot = this.options.adapter.readModelSelection(record.sessionId);
    const actual = snapshot.ok && sameSession(snapshot.value, record) ? snapshot.value.model : record.model;
    let reason: string | null = record.pending || record.recoveryError || !snapshot.ok || !sameSession(snapshot.value, record) || !snapshot.value.durable ||
      !sameConfig(actual, record.model) ? 'SELECTION_RECOVERY_UNAVAILABLE' : null;
    let message: string | null = reason ? record.recoveryError ?? 'Pi 实际选择与系统引用未安全对账，禁止发送。' : null;
    if (!reason) {
      const valid = await this.options.adapter.validateModelSelection(record.sessionId);
      if (!valid.ok || !valid.value) { reason = 'PI_MODEL_UNAVAILABLE'; message = '当前 Pi 模型的认证、能力或端点已变化，禁止发送；请明确重新选择或修复。'; }
    }
    if (!reason && record.model.profileId) {
      try {
        const configured = await this.options.settings.getModelProfileRuntimeConfig(record.model.profileId,
          version ? () => this.assertVersionNow(version) : undefined);
        if (!sameConfig({ ...configured, thinkingLevel: actual.thinkingLevel }, actual)) {
          reason = 'PROFILE_CONFIGURATION_CHANGED'; message = '选中配置已改变，与当前 Pi 模型快照不同；请明确重新选择模型。';
        }
      } catch { reason = 'MODEL_UNAVAILABLE'; message = '选中模型配置或认证已失效；引用已保留，请修复或明确选择其他模型。'; }
    }
    try {
      if (!version) throw new Error('version unavailable');
      await this.assertVersion(version);
    } catch {
      reason = 'MODEL_STATE_CHANGED'; message = '模型配置或认证在检查期间变化，当前结果不可用于发送，请重新读取。';
    }
    return {
      sessionId: this.sessionId, profileId: record.model.profileId ?? null,
      source: record.model.source ?? 'base', provider: actual.provider, modelId: actual.modelId,
      thinkingLevel: actual.thinkingLevel, revision: record.revision,
      availableThinkingLevels: snapshot.ok && sameSession(snapshot.value, record) ? snapshot.value.availableThinkingLevels : [],
      availability: { available: reason === null, reason, message },
    };
  }

  private async readVersion(): Promise<SelectionReadVersion> {
    await this.options.settings.getConfigurationForAccess();
    const settings = this.options.settings.readVersion();
    const access = await this.options.access?.readVersion();
    this.options.settings.assertReadVersion(settings);
    return { settings, ...(access ? { access } : {}) };
  }
  private assertVersionNow(version: SelectionReadVersion): void {
    this.options.settings.assertReadVersion(version.settings);
    if (version.access) this.options.access!.assertReadVersionNow(version.access);
  }
  private async assertVersion(version: SelectionReadVersion): Promise<void> {
    if (version.access) {
      const current = await this.options.access!.readVersion();
      if (current.credentialVersion !== version.access.credentialVersion || current.credentialRevision !== version.access.credentialRevision ||
        current.environmentPresence !== version.access.environmentPresence) throw new Error('authentication version changed');
    }
    this.assertVersionNow(version);
  }
  private withVersion<T>(version: SelectionReadVersion, operation: (assertCurrent: () => void) => Promise<T>): Promise<T> {
    return this.options.settings.withReadVersion(version.settings, async () => {
      if (version.access) return this.options.access!.withReadVersion(version.access, async (assertAuth) => {
        const assertCurrent = () => { assertAuth(); this.options.settings.assertReadVersion(version.settings); };
        assertCurrent(); return operation(assertCurrent);
      });
      return operation(() => this.assertVersionNow(version));
    });
  }

  private async result(commandId: string, status: SessionModelCommandResult['status'], error: string | null,
    replayed = false, record?: StoredSessionSelection): Promise<SessionModelCommandResult> {
    return { commandId, status, error, replayed, effectiveFrom: 'next-turn', selection: await this.selection(record) };
  }
}
