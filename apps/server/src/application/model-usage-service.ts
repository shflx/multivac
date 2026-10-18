import { randomUUID } from 'node:crypto';
import type { UsageRepository } from '../modules/usage/model-usage.js';
import { isObject, measuredUsage, type ModelUsageRecorder, type UsageIdentity, type UsageRecord } from '../modules/usage/model-usage.js';

export class ModelUsageService implements ModelUsageRecorder {
  private broken = false;
  constructor(readonly repository: UsageRepository,
    private readonly identity: (sessionId: string) => Omit<UsageIdentity, 'runtimeSessionId' | 'provider' | 'modelId'>,
    private readonly now = () => new Date().toISOString(), readonly enabled = true) {
    if (enabled) this.protect(() => repository.startCollection(this.now()));
  }
  get warning(): string | null {
    if (!this.enabled) return '当前适配器没有接入模型用量采集。';
    return this.broken ? '用量记录发生错误，当前仅显示已记录的用量。' : null;
  }
  private protect(action: () => void): void {
    try { action(); }
    catch {
      this.broken = true;
      console.warn('模型用量账本写入失败，当前仅显示已记录用量。');
    }
  }
  begin(sessionId: string, runtimeSessionId: string, model: unknown): (message?: unknown, error?: unknown) => void {
    if (!this.enabled) return () => {};
    let identity: Omit<UsageIdentity, 'runtimeSessionId' | 'provider' | 'modelId'> = { sessionId, sessionTitle: '未知会话', projectId: null,
      projectKnown: false, projectName: null, source: 'unknown' };
    this.protect(() => { identity = this.identity(sessionId); });
    const record: UsageRecord = { ...identity, runtimeSessionId,
      provider: isObject(model) && typeof model.provider === 'string' ? model.provider : null,
      modelId: isObject(model) && typeof model.id === 'string' ? model.id : null,
      requestId: randomUUID(), startedAt: this.now(), outcome: 'pending', tokens: null, raw: null,
      missingReason: '调用尚未返回用量' };
    this.protect(() => this.repository.put(record));
    let finished = false;
    return (message, error) => {
      if (finished) return;
      finished = true;
      const measured = measuredUsage(message);
      if (!isObject(message) && isObject(error) && error.name === 'AbortError') measured.outcome = 'cancelled';
      this.protect(() => this.repository.put({ ...record, ...measured }));
    };
  }
}
