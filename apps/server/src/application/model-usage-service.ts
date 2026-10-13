import { randomUUID } from 'node:crypto';
import type { SqliteUsageRepository } from '../storage/sqlite-usage-repository.js';
import { isObject, measuredUsage, USAGE_RESPONSE_MARKER, type ModelUsageRecorder, type UsageIdentity, type UsageRecord } from '../modules/usage/model-usage.js';

export class ModelUsageService implements ModelUsageRecorder {
  private readonly intervalId = randomUUID();
  private readonly timer: ReturnType<typeof setInterval>;
  private broken = false;
  constructor(readonly repository: SqliteUsageRepository,
    private readonly identity: (sessionId: string) => Omit<UsageIdentity, 'piSessionId' | 'provider' | 'modelId'>,
    private readonly now = () => new Date().toISOString(), private readonly enabled = true) {
    if (enabled) repository.startInterval(this.intervalId, now());
    this.timer = setInterval(() => this.touch(), 30_000);
    this.timer.unref();
  }
  private protect(action: () => void): void {
    try { action(); }
    catch {
      this.broken = true;
      try { this.repository.setMeta('collectionFailure', '存在采集写入失败；覆盖不能视为完整'); } catch { /* 数据库失效时不影响模型执行。 */ }
      console.warn('模型用量账本写入失败，统计覆盖不完整。');
    }
  }
  touch(): void { if (this.enabled && !this.broken) this.protect(() => this.repository.touchInterval(this.intervalId, this.now())); }
  close(): void { clearInterval(this.timer); this.touch(); }
  begin(sessionId: string, piSessionId: string, model: unknown): (message?: unknown, error?: unknown) => void {
    let identity: Omit<UsageIdentity, 'piSessionId' | 'provider' | 'modelId'> = { sessionId, sessionTitle: '未知会话', projectId: null,
      projectKnown: false, projectName: null, source: 'unknown' };
    this.protect(() => { identity = this.identity(sessionId); });
    const record: UsageRecord = { ...identity, piSessionId,
      provider: isObject(model) && typeof model.provider === 'string' ? model.provider : null,
      modelId: isObject(model) && typeof model.id === 'string' ? model.id : null,
      requestId: randomUUID(), startedAt: this.now(), outcome: 'pending', tokens: null, raw: null,
      missingReason: '调用仍在运行或上次执行未收到响应终态', origin: 'live' };
    this.protect(() => this.repository.put(record));
    let finished = false;
    return (message, _error) => {
      if (finished) return;
      finished = true;
      const measured = measuredUsage(message);
      if (!isObject(message) && isObject(_error) && _error.name === 'AbortError') measured.outcome = 'cancelled';
      // 标记与真实响应一起由 Pi 保存；回补只读这个无秘密调用快照，不以当前归属反推。
      if (isObject(message)) {
        try { message[USAGE_RESPONSE_MARKER] = { ...record, tokens: null, raw: null }; }
        catch { this.protect(() => this.repository.setMeta('markerFailure', '部分响应无法保存稳定调用标记，历史回补可能不完整')); }
      }
      this.protect(() => this.repository.put({ ...record, ...measured }));
    };
  }
}
