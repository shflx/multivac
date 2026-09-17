import type {
  ConfigureModelApiKey, ModelAccessCommand, ModelAccessReceipt, ModelAccessSnapshot, ModelAvailability, ModelConnectionCheck, ModelProfileInput,
} from '@multivac/contracts';
import { MODEL_CHECK_TIMEOUT_MS, MODEL_CHECK_TTL_MS } from '@multivac/contracts';
import {
  ModelAccessError, type ModelAccessBackend, type ModelAccessState, type ModelAccessStore,
  type StoredAccessCommand, type StoredConnectionCheck,
} from '../modules/model-settings/model-access.js';
import type { ModelSettingsService } from './model-settings-service.js';

interface RunningCheck { controller: AbortController; task: Promise<void>; configRevision: number; committed?: boolean }
export interface ModelAccessReadVersion {
  credentialVersion: string;
  credentialRevision: number;
  environmentPresence: string;
}

function environmentPresence(): string {
  // 只观察存在性，不读取/比较/散列环境凭据值；实际认证仍由 Pi 复核。
  return JSON.stringify(Object.keys(process.env).filter((key) => Boolean(process.env[key]?.trim())).sort());
}
export interface ModelAccessServiceOptions {
  settings: ModelSettingsService;
  backend: ModelAccessBackend;
  store: ModelAccessStore;
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => number;
}

function publicReceipt(record: StoredAccessCommand, replayed = false): ModelAccessReceipt {
  return { replayed, commandId: record.commandId, profileId: record.profileId, action: record.action,
    state: record.state, revision: record.revision, accessRevision: record.accessRevision, errorCode: record.errorCode };
}
function safeCommand(command: ModelAccessCommand): ModelAccessCommand {
  return { commandId: command.commandId, profileId: command.profileId,
    revision: command.revision, accessRevision: command.accessRevision };
}

/** 账本只描述一次尝试，不比较/保存 Key 或 hash；已消费 ID 永远不能再次写入凭据。 */
export class ModelAccessService {
  private state: ModelAccessState | undefined;
  private tail: Promise<void> = Promise.resolve();
  private readonly running = new Map<string, RunningCheck>();
  private readonly consumed = new Map<string, StoredAccessCommand>();
  private credentialVersion: string | undefined;
  private observedAuthentication: { revision: number; credentialRevision: number; signature: string } | undefined;
  private credentialController: AbortController | undefined;
  private closed = false;
  private checkTimeoutMs: number;
  private readonly now: () => number;
  constructor(private readonly options: ModelAccessServiceOptions) {
    this.now = options.now ?? Date.now;
    this.checkTimeoutMs = options.timeoutMs ?? MODEL_CHECK_TIMEOUT_MS;
  }

  configure(command: ConfigureModelApiKey): Promise<ModelAccessReceipt> {
    let key = command.apiKey;
    const safe = safeCommand(command);
    return this.credentialCommand(safe, 'configure-key', (profile, signal, version) => this.options.backend.configure(profile, key, signal, version))
      .finally(() => { key = ''; });
  }
  revoke(command: ModelAccessCommand): Promise<ModelAccessReceipt> {
    return this.credentialCommand(safeCommand(command), 'revoke-key', (profile, signal, version) => this.options.backend.revoke(profile, signal, version));
  }
  readVersion(): Promise<ModelAccessReadVersion> {
    return this.serialize(async () => {
      if (this.closed) throw new ModelAccessError('ACCESS_UNAVAILABLE');
      await this.ensureState();
      await this.syncCredentialVersion();
      return { credentialVersion: this.credentialVersion!, credentialRevision: this.state!.credentialRevision,
        environmentPresence: environmentPresence() };
    });
  }
  assertReadVersionNow(version: ModelAccessReadVersion): void {
    const fileVersion = this.options.backend.credentialVersionNow?.() ?? this.credentialVersion;
    if (this.closed || !this.state || version.credentialVersion !== fileVersion ||
      version.credentialRevision !== this.state.credentialRevision || version.environmentPresence !== environmentPresence()) {
      throw new ModelAccessError('ACCESS_CONFLICT');
    }
  }
  /** 复用凭据命令队列，不增加凭据存储/锁层；operation 决定仅 handoff 或完整 setter 的锁期。 */
  withReadVersion<T>(version: ModelAccessReadVersion, operation: (assertCurrent: () => void) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      // 没有同步版本能力的注入 backend 只支持只读；不能用缓存版本冒充最终准入。
      if (!this.options.backend.credentialVersionNow) throw new ModelAccessError('ACCESS_UNAVAILABLE');
      if (await this.options.backend.credentialVersion() !== version.credentialVersion) throw new ModelAccessError('ACCESS_CONFLICT');
      this.assertReadVersionNow(version);
      return operation(() => this.assertReadVersionNow(version));
    });
  }
  async getReceipt(commandId: string): Promise<ModelAccessReceipt> {
    return this.serialize(async () => {
      if (this.closed) throw new ModelAccessError('ACCESS_UNAVAILABLE');
      await this.ensureState();
      const found = this.state!.commands.find((entry) => entry.commandId === commandId) ?? this.consumed.get(commandId);
      if (!found) throw new ModelAccessError('NOT_FOUND');
      return publicReceipt(found);
    });
  }
  async getSnapshot(): Promise<ModelAccessSnapshot> {
    return this.serialize(async () => {
      if (this.closed) throw new ModelAccessError('ACCESS_UNAVAILABLE');
      await this.ensureState();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await this.syncCredentialVersion();
        const version = this.credentialVersion;
        const config = await this.configuration();
        this.cancelObsolete(config.revision);
        const signal = AbortSignal.timeout(this.options.timeoutMs ?? MODEL_CHECK_TIMEOUT_MS);
        const credentials = await Promise.all(config.profiles.map(async (profile) => ({
          profileId: profile.profileId, provider: profile.provider,
          ...await this.options.backend.credentialInfo(profile, signal),
          lastCommand: (() => {
            const entry = [...this.state!.commands].reverse().find((command) => command.provider === profile.provider && command.action !== 'check');
            return entry ? publicReceipt(entry) : null;
          })(),
        })));
        const models = await this.options.settings.getSnapshot();
        await this.syncCredentialVersion();
        if (version !== this.credentialVersion || models.revision !== config.revision) continue;
        await this.syncObservedAuthentication(models.availability, config.revision);
        return { revision: config.revision, accessRevision: this.state!.accessRevision,
          credentialRevision: this.state!.credentialRevision, availability: models.availability, credentials,
          checks: this.state!.checks.map((check) => this.publicCheck(check, config.revision)) };
      }
      throw new ModelAccessError('ACCESS_UNAVAILABLE');
    });
  }
  startCheck(command: ModelAccessCommand): Promise<ModelAccessReceipt> {
    return this.serialize(async () => {
      if (this.closed) throw new ModelAccessError('ACCESS_UNAVAILABLE');
      await this.ensureState();
      const replay = this.replay(command, 'check');
      if (replay) return replay;
      if (this.running.size > 0) throw new ModelAccessError('CHECK_BUSY');
      let finish!: () => void;
      const job: RunningCheck = { controller: new AbortController(),
        task: new Promise<void>((resolve) => { finish = resolve; }), configRevision: command.revision };
      // 准备阶段也占用检查槽；配置失效必须覆盖同步凭据及落盘等待。
      this.running.set(command.commandId, job);
      let dispatched = false;
      try {
        const config = await this.configuration();
        await this.syncCredentialVersion();
        this.assertRevision(command, config.revision);
        const profile = this.profile(config.profiles, command.profileId);
        const next = structuredClone(this.state!);
        const receipt = this.addCommand(next, command, profile.provider, 'check', 'committed');
        next.checks = next.checks.filter((check) => check.profileId !== profile.profileId);
        next.checks.push({ profileId: profile.profileId, provider: profile.provider, checkId: command.commandId,
          configRevision: config.revision, credentialRevision: next.credentialRevision,
          status: 'checking', checkedAt: null, expiresAt: null, errorCode: null });
        await this.persist(next);
        try {
          if ((await this.configuration()).revision !== command.revision) {
            job.controller.abort(new ModelAccessError('CHECK_INVALIDATED'));
          }
        } catch {
          // 已落盘的尝试仍须结算；无法复核配置时绝不派发上游请求。
          job.controller.abort(new ModelAccessError('CHECK_INVALIDATED'));
        }
        dispatched = true;
        void this.runCheck(profile, command.commandId, job).finally(finish);
        return publicReceipt(receipt);
      } finally {
        if (!dispatched) { this.running.delete(command.commandId); finish(); }
      }
    });
  }
  async cancelCheck(checkId: string): Promise<ModelAccessSnapshot> {
    const job = this.running.get(checkId);
    if (job) { if (!job.committed) job.controller.abort(new ModelAccessError('CHECK_CANCELLED')); await job.task; }
    else {
      await this.serialize(async () => {
        await this.ensureState();
        if (!this.state!.checks.some((check) => check.checkId === checkId)) throw new ModelAccessError('NOT_FOUND');
      });
    }
    return this.getSnapshot();
  }
  configurationChanged(): void {
    this.credentialController?.abort(new ModelAccessError('ACCESS_CONFLICT'));
    this.cancelRunningChecks();
  }
  private cancelRunningChecks(): void {
    for (const job of this.running.values()) if (!job.committed) job.controller.abort(new ModelAccessError('CHECK_INVALIDATED'));
  }
  async close(): Promise<void> {
    this.closed = true;
    this.credentialController?.abort();
    for (const job of this.running.values()) job.controller.abort(new ModelAccessError('CHECK_CANCELLED'));
    await Promise.all([...this.running.values()].map((job) => job.task));
    await this.tail;
  }

  private credentialCommand(command: ModelAccessCommand, action: 'configure-key' | 'revoke-key',
    operation: (profile: ModelProfileInput, signal: AbortSignal, version: string | undefined) => Promise<void>): Promise<ModelAccessReceipt> {
    return this.serialize(async () => {
      if (this.closed) throw new ModelAccessError('ACCESS_UNAVAILABLE');
      await this.ensureState();
      const replay = this.replay(command, action);
      if (replay) return replay;
      const config = await this.configuration();
      await this.syncCredentialVersion();
      this.assertRevision(command, config.revision);
      const profile = this.profile(config.profiles, command.profileId);
      const controller = new AbortController();
      this.credentialController = controller;
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? MODEL_CHECK_TIMEOUT_MS);
      try {
        const info = await this.options.backend.credentialInfo(profile, controller.signal);
        if (action === 'configure-key' ? !info.configurable : !info.storedApiKey && !info.configurable) {
          throw new ModelAccessError('CREDENTIAL_UNSUPPORTED');
        }
        if ((await this.configuration()).revision !== command.revision) throw new ModelAccessError('ACCESS_CONFLICT');
        const next = structuredClone(this.state!);
        next.credentialRevision += 1;
        this.invalidateChecks(next);
        const begun = this.addCommand(next, command, profile.provider, action, 'begun');
        this.consumed.set(command.commandId, { ...begun });
        try { await this.persist(next); }
        catch {
          this.consumed.set(command.commandId, { ...begun, state: 'unconfirmed', errorCode: 'CREDENTIAL_RESULT_UNKNOWN' });
          throw new ModelAccessError('CREDENTIAL_RESULT_UNKNOWN');
        }
        let errorCode: ModelAccessReceipt['errorCode'] = null;
        let status: ModelAccessReceipt['state'] = 'committed';
        try {
          await operation(profile, controller.signal, this.credentialVersion);
          if (controller.signal.aborted) throw new ModelAccessError('CREDENTIAL_RESULT_UNKNOWN');
        }
        catch (error) {
          errorCode = error instanceof ModelAccessError && ['CREDENTIAL_UNSUPPORTED', 'ACCESS_CONFLICT'].includes(error.code)
            ? error.code : 'CREDENTIAL_RESULT_UNKNOWN';
          status = errorCode === 'CREDENTIAL_RESULT_UNKNOWN' ? 'unconfirmed' : 'failed';
        }
        try {
          this.credentialVersion = await this.options.backend.credentialVersion();
          const finished = structuredClone(this.state!);
          const record = finished.commands.find((entry) => entry.commandId === begun.commandId)!;
          record.state = status; record.errorCode = errorCode;
          await this.persist(finished);
          this.consumed.delete(command.commandId);
          return publicReceipt(record);
        } catch {
          this.state = undefined;
          this.consumed.set(command.commandId, { ...begun, state: 'unconfirmed', errorCode: 'CREDENTIAL_RESULT_UNKNOWN' });
          throw new ModelAccessError('CREDENTIAL_RESULT_UNKNOWN');
        }
      } finally { clearTimeout(timer); this.credentialController = undefined; }
    });
  }
  private async runCheck(profile: ModelProfileInput, checkId: string, job: RunningCheck): Promise<void> {
    const timer = setTimeout(() => job.controller.abort(new ModelAccessError('CHECK_TIMEOUT')),
      this.checkTimeoutMs);
    let code: ModelConnectionCheck['errorCode'] = null;
    try {
      job.controller.signal.throwIfAborted();
      await this.options.backend.check(profile, job.controller.signal);
    }
    catch (error) {
      const reason = job.controller.signal.aborted ? job.controller.signal.reason : error;
      code = reason instanceof ModelAccessError ? reason.code : 'CHECK_FAILED';
      if (!['CHECK_AUTH_MISSING', 'CHECK_MODEL_UNAVAILABLE', 'CHECK_TIMEOUT', 'CHECK_CANCELLED', 'CHECK_INVALIDATED'].includes(code)) {
        code = 'CHECK_FAILED';
      }
    }
    try {
      await this.serialize(async () => {
        try {
          await this.syncCredentialVersion();
          const config = await this.configuration();
          for (;;) {
            const next = structuredClone(this.state!);
            const record = next.checks.find((check) => check.checkId === checkId);
            if (!record) return;
            const observedAbort = job.controller.signal.reason;
            code = this.abortCode(job) ?? code;
            if (record.credentialRevision !== next.credentialRevision || record.configRevision !== config.revision ||
              record.status === 'invalidated' || job.controller.signal.reason?.code === 'CHECK_INVALIDATED') code = 'CHECK_INVALIDATED';
            record.status = code === 'CHECK_TIMEOUT' ? 'timed-out' : code === 'CHECK_CANCELLED' ? 'cancelled'
              : code === 'CHECK_INVALIDATED' ? 'invalidated' : code ? 'failed' : 'passed';
            record.checkedAt = new Date(this.now()).toISOString();
            record.expiresAt = code === 'CHECK_INVALIDATED' ? null
              : new Date(this.now() + (this.options.ttlMs ?? MODEL_CHECK_TTL_MS)).toISOString();
            record.errorCode = code;
            next.accessRevision += 1;
            try {
              await this.options.store.save(next, () => {
                if (job.controller.signal.aborted && job.controller.signal.reason !== observedAbort) throw job.controller.signal.reason;
                job.committed = true;
                clearTimeout(timer);
              });
              job.committed = true;
              this.state = next;
              return;
            } catch (error) {
              if (!job.committed && error === job.controller.signal.reason && this.abortCode(job)) continue;
              this.state = undefined;
              throw error;
            }
          }
        } catch {
          await this.commitInvalidatedCheck(checkId, job);
        }
      });
    } catch {
      // 持久化失败不能发布内存终态；下一次读取必须先持久化恢复，否则返回安全 503。
      job.controller.abort(new ModelAccessError('CHECK_INVALIDATED'));
    } finally { clearTimeout(timer); this.running.delete(checkId); }
  }
  private async commitInvalidatedCheck(checkId: string, job: RunningCheck): Promise<void> {
    if (!this.state) throw new ModelAccessError('ACCESS_UNAVAILABLE');
    const next = structuredClone(this.state);
    const record = next.checks.find((entry) => entry.checkId === checkId);
    if (!record) return;
    record.status = 'invalidated';
    record.errorCode = 'CHECK_INVALIDATED';
    record.expiresAt = null;
    next.accessRevision += 1;
    await this.persist(next);
    job.committed = true;
  }
  private abortCode(job: RunningCheck): ModelConnectionCheck['errorCode'] {
    if (!job.controller.signal.aborted) return null;
    const code = job.controller.signal.reason instanceof ModelAccessError ? job.controller.signal.reason.code : 'CHECK_CANCELLED';
    return ['CHECK_CANCELLED', 'CHECK_TIMEOUT', 'CHECK_INVALIDATED'].includes(code) ? code : 'CHECK_FAILED';
  }
  async resetForTest(): Promise<void> {
    this.cancelRunningChecks();
    await Promise.all([...this.running.values()].map((job) => job.task));
    await this.serialize(async () => {
      await this.persist({ version: 1, accessRevision: 0, credentialRevision: 0, commands: [], checks: [] });
      this.consumed.clear();
      this.observedAuthentication = undefined;
      this.checkTimeoutMs = this.options.timeoutMs ?? MODEL_CHECK_TIMEOUT_MS;
      this.credentialVersion = await this.options.backend.credentialVersion();
    });
  }
  setCheckTimeoutForTest(timeoutMs: number): void {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 25 || timeoutMs > MODEL_CHECK_TIMEOUT_MS || this.running.size > 0) {
      throw new ModelAccessError('INVALID_REQUEST');
    }
    this.checkTimeoutMs = timeoutMs;
  }
  private publicCheck(record: StoredConnectionCheck, revision: number): ModelConnectionCheck {
    const invalid = record.configRevision !== revision || record.credentialRevision !== this.state!.credentialRevision;
    const expired = record.expiresAt !== null && Date.parse(record.expiresAt) <= this.now();
    return { profileId: record.profileId, checkId: record.checkId,
      status: invalid ? 'invalidated' : expired ? 'expired' : record.status,
      checkedAt: record.checkedAt, expiresAt: invalid ? null : record.expiresAt,
      errorCode: invalid ? 'CHECK_INVALIDATED' : record.errorCode };
  }
  private invalidateChecks(state: ModelAccessState): void {
    this.cancelRunningChecks();
    for (const check of state.checks) { check.status = 'invalidated'; check.errorCode = 'CHECK_INVALIDATED'; check.expiresAt = null; }
  }
  private cancelObsolete(revision: number): void {
    for (const job of this.running.values()) if (job.configRevision !== revision) job.controller.abort(new ModelAccessError('CHECK_INVALIDATED'));
  }
  private async syncCredentialVersion(): Promise<void> {
    const current = await this.options.backend.credentialVersion();
    if (this.credentialVersion !== undefined && current !== this.credentialVersion) {
      const next = structuredClone(this.state!);
      next.credentialRevision += 1;
      next.accessRevision += 1;
      this.invalidateChecks(next);
      await this.persist(next);
    }
    this.credentialVersion = current;
  }
  private async syncObservedAuthentication(availability: ModelAvailability[], revision: number): Promise<void> {
    // 只比较 Pi 的公开状态，不读取/比较/hash 环境 Key。文件未变也可能失去 ambient auth。
    const signature = JSON.stringify(availability.map(({ profileId, authenticated, available, authenticationType, reason }) =>
      ({ profileId, authenticated, available, authenticationType, reason })));
    const previous = this.observedAuthentication;
    if (previous?.revision === revision && previous.credentialRevision === this.state!.credentialRevision && previous.signature !== signature) {
      const next = structuredClone(this.state!);
      next.credentialRevision += 1;
      next.accessRevision += 1;
      this.invalidateChecks(next);
      await this.persist(next);
    }
    this.observedAuthentication = { revision, credentialRevision: this.state!.credentialRevision, signature };
  }
  private addCommand(state: ModelAccessState, command: ModelAccessCommand, provider: string,
    action: ModelAccessReceipt['action'], status: ModelAccessReceipt['state']): StoredAccessCommand {
    if (state.commands.length >= 10_000) throw new ModelAccessError('ACCESS_UNAVAILABLE');
    state.accessRevision += 1;
    const record: StoredAccessCommand = { replayed: false, commandId: command.commandId, profileId: command.profileId, provider, action,
      revision: command.revision, baselineAccessRevision: command.accessRevision,
      accessRevision: state.accessRevision, state: status, errorCode: null };
    state.commands.push(record);
    return record;
  }
  private replay(command: ModelAccessCommand, action: ModelAccessReceipt['action']): ModelAccessReceipt | undefined {
    const existing = this.state!.commands.find((entry) => entry.commandId === command.commandId) ?? this.consumed.get(command.commandId);
    if (!existing) return undefined;
    if (existing.profileId !== command.profileId || existing.action !== action || existing.revision !== command.revision ||
      existing.baselineAccessRevision !== command.accessRevision) throw new ModelAccessError('COMMAND_ID_CONFLICT');
    return publicReceipt(existing, true);
  }
  private assertRevision(command: ModelAccessCommand, revision: number): void {
    if (command.revision !== revision || command.accessRevision !== this.state!.accessRevision) throw new ModelAccessError('ACCESS_CONFLICT');
  }
  private profile(profiles: ModelProfileInput[], profileId: string): ModelProfileInput {
    const found = profiles.find((profile) => profile.profileId === profileId);
    if (!found) throw new ModelAccessError('INVALID_REQUEST');
    return found;
  }
  private async configuration() {
    try { return await this.options.settings.getConfigurationForAccess(); }
    catch { throw new ModelAccessError('ACCESS_UNAVAILABLE'); }
  }
  private async ensureState(): Promise<void> {
    if (this.state) return;
    try {
      const loaded = await this.options.store.load();
      loaded.accessRevision += 1;
      loaded.credentialRevision += 1;
      for (const command of loaded.commands) if (command.state === 'begun') {
        command.state = 'unconfirmed'; command.errorCode = 'CREDENTIAL_RESULT_UNKNOWN';
      }
      for (const check of loaded.checks) { check.status = 'invalidated'; check.expiresAt = null; check.errorCode = 'CHECK_INVALIDATED'; }
      const version = await this.options.backend.credentialVersion();
      await this.options.store.save(loaded);
      this.credentialVersion = version;
      this.state = loaded;
    } catch { this.state = undefined; throw new ModelAccessError('ACCESS_UNAVAILABLE'); }
  }
  private async persist(state: ModelAccessState): Promise<void> {
    try { await this.options.store.save(state); this.state = state; }
    catch { this.state = undefined; throw new ModelAccessError('ACCESS_UNAVAILABLE'); }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result.catch((error: unknown) => { throw error instanceof ModelAccessError ? error : new ModelAccessError('ACCESS_UNAVAILABLE'); });
  }
}
