import type { AssistantPublicEvent } from '@multivac/contracts';

export type AssistantPublicEventListener = (event: AssistantPublicEvent) => void;

/** 只广播已提交的 SQLite 公共投影；监听器失败不会影响命令或 Pi 事件处理。 */
export class AssistantEventStream {
  private readonly listeners = new Set<AssistantPublicEventListener>();

  publish(event: AssistantPublicEvent | null): void {
    if (!event) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // 单个 SSE 客户端或测试监听器不能阻断其它订阅者。
      }
    }
  }

  subscribe(listener: AssistantPublicEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
  }
}
