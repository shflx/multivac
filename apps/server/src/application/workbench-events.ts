import type { WorkbenchChangeEvent, WorkbenchEvent } from '@multivac/contracts';

/** 发布时不带序号的变更事件；序号由事件流统一编排。 */
export type WorkbenchChange = WorkbenchChangeEvent extends infer Event
  ? Event extends WorkbenchChangeEvent ? Omit<Event, 'seq'> : never
  : never;

/** 事件的投递范围：缺省推给所有窗口；给出窗口 id 时只推给这个窗口（例如只作用于发起对话的窗口的导航）。 */
export interface WorkbenchDelivery {
  targetWindowId?: string;
}

export type WorkbenchEventListener = (event: WorkbenchEvent, delivery: WorkbenchDelivery) => void;

/** 服务层发布变更的端口：各服务只依赖它，不关心推送通道。 */
export interface WorkbenchEventPublisher {
  publish(change: WorkbenchChange, delivery?: WorkbenchDelivery): void;
}

/**
 * 工作台变更事件流（进程内）：服务在变更成功后发布，推送通道（WebSocket 连接）订阅后按投递范围转给各窗口。
 * 事件不持久化、不重放：窗口断线重连后整体重读一次，因此这里只需要保证进程内的顺序与序号。
 * 监听器失败不影响发布方与其他订阅者，与会话公共事件流一致。
 */
export class WorkbenchEvents implements WorkbenchEventPublisher {
  private readonly listeners = new Set<WorkbenchEventListener>();
  private seq = 0;

  /** 取下一个序号；连接建立时的第一条消息也占用序号，与变更事件同在一个序列里。 */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  publish(change: WorkbenchChange, delivery: WorkbenchDelivery = {}): void {
    const event = { ...change, seq: this.nextSeq() } as WorkbenchEvent;
    for (const listener of [...this.listeners]) {
      try {
        listener(event, delivery);
      } catch {
        // 单个连接或测试监听器不能阻断其它订阅者。
      }
    }
  }

  subscribe(listener: WorkbenchEventListener): () => void {
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
