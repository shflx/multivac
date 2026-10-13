import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve, sep } from 'node:path';
import type { CoordinatorSessionBinding, UsageSource } from '@multivac/contracts';
import type { SqliteUsageRepository } from '../storage/sqlite-usage-repository.js';
import { isObject, measuredUsage, USAGE_RESPONSE_MARKER, type UsageRecord } from '../modules/usage/model-usage.js';

const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const nullableText = (value: unknown): value is string | null => value === null || typeof value === 'string';

/** 只接受实时采集器的稳定快照形状，绑定会话/Pi身份；不从旧正文或当前项目猜历史归属。 */
function liveMarker(value: unknown, binding: CoordinatorSessionBinding): value is UsageRecord {
  return isObject(value) && typeof value.requestId === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.requestId)
    && value.sessionId === binding.assistantSessionId && value.piSessionId === binding.piSessionId
    && value.origin === 'live' && validDate(value.startedAt) && typeof value.sessionTitle === 'string'
    && nullableText(value.provider) && nullableText(value.modelId) && nullableText(value.projectId)
    && nullableText(value.projectName) && typeof value.projectKnown === 'boolean'
    && ['multivac', 'session', 'task', 'unknown'].includes(String(value.source));
}

export class UsageHistoryBackfill {
  private cancelled = false;
  constructor(private readonly repository: SqliteUsageRepository, private readonly sessionRoot: string) {}
  cancel(): void { this.cancelled = true; }

  async scan(bindings: readonly CoordinatorSessionBinding[], oldIdentity: (sessionId: string) => { title: string; source: UsageSource; projectId: string | null; projectKnown: boolean; projectName: string | null }): Promise<void> {
    const reasons = new Set<string>();
    let unplaced = 0;
    try {
      const root = await realpath(this.sessionRoot);
      const cutoff = this.repository.meta('collectionStartedAt')!;
      for (const binding of bindings) {
        if (this.cancelled) return;
        try {
          const path = await realpath(binding.piSessionPath);
          if (!path.startsWith(resolve(root) + sep)) { reasons.add('部分历史绑定不在受控 Pi 目录，未读取'); continue; }
          const info = await stat(path);
          if (!info.isFile() || info.size > 128 * 1024 * 1024) { reasons.add('部分历史超出128MiB扫描上限或不是普通文件'); continue; }
          const input = createReadStream(path);
          const reader = createInterface({ input, crlfDelay: Infinity });
          let header = false;
          try {
            for await (const line of reader) {
              if (this.cancelled) return;
              if (!line.trim()) continue;
              if (line.length > 8 * 1024 * 1024) { reasons.add('部分历史条目超出8MiB扫描上限'); continue; }
              let entry: unknown;
              try { entry = JSON.parse(line); } catch { reasons.add('历史存在损坏或未完整写入的条目，已跳过'); continue; }
              if (!header) {
                if (!isObject(entry) || entry.type !== 'session' || entry.id !== binding.piSessionId) { reasons.add('部分历史文件头与Pi绑定不符，未回补'); break; }
                header = true; continue;
              }
              if (!isObject(entry) || entry.type !== 'message' || !isObject(entry.message) || entry.message.role !== 'assistant') continue;
              const message = entry.message;
              const marker = message[USAGE_RESPONSE_MARKER];
              if (liveMarker(marker, binding)) {
                this.repository.put({ ...marker, ...measuredUsage(message), origin: 'history' });
                continue;
              }
              if (typeof entry.id !== 'string' || !entry.id.trim()) { reasons.add('部分历史响应没有稳定entry身份'); continue; }
              const timestamp = typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) ? new Date(message.timestamp) : null;
              if (!timestamp || !Number.isFinite(timestamp.getTime())) { unplaced++; reasons.add('部分历史响应缺少可信时间，未放入日期统计'); continue; }
              const startedAt = timestamp.toISOString();
              if (startedAt >= cutoff) { reasons.add('采集启用后部分历史无稳定调用标记，保守跳过以避免重计'); continue; }
              const identity = oldIdentity(binding.assistantSessionId);
              this.repository.put({ requestId: `pi:${JSON.stringify([binding.piSessionId, entry.id])}`,
                sessionId: binding.assistantSessionId, sessionTitle: identity.title, piSessionId: binding.piSessionId,
                provider: typeof message.provider === 'string' ? message.provider : null,
                modelId: typeof message.model === 'string' ? message.model : null,
                projectId: identity.projectId, projectKnown: identity.projectKnown, projectName: identity.projectName,
                source: identity.source, startedAt, origin: 'history', ...measuredUsage(message) });
            }
          } finally { reader.close(); input.destroy(); }
        } catch { reasons.add('部分历史文件读取或写入失败，可在下次启动幂等重试'); }
      }
      if (this.cancelled) return;
      // 即使文件全部可读，旧压缩请求和没有响应的失败调用仍无法证明完整覆盖。
      reasons.add('历史仅恢复可验证的响应；旧压缩请求和无响应失败调用可能无法恢复');
      this.repository.setMeta('history', reasons.size > 1 ? 'partial' : 'scanned');
      this.repository.setMeta('historyReasons', JSON.stringify([...reasons]));
      this.repository.setMeta('historyUnplaced', String(unplaced));
    } catch {
      if (!this.cancelled) {
        this.repository.setMeta('history', 'partial');
        this.repository.setMeta('historyReasons', JSON.stringify(['历史扫描尚未成功，可在下次启动幂等重试']));
      }
    }
  }
}
