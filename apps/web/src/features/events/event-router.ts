import type { AssistantPublicEvent } from '@multivac/contracts';

/**
 * 全局事件流上的会话事件分发与打开会话时的衔接（与网络、界面无关，便于单独测试）。
 *
 * 每个窗口只有一条全局事件流，承载所有会话的公共事件，cursor 全局递增。流按 cursor 升序送达，
 * 窗口记下“全局已处理游标”，断线后从它续传。事件按 `assistantSessionId` 交给已打开的会话，没有打开的会话的事件直接丢弃。
 *
 * 打开会话（读取页面快照）与事件流是并行的，衔接规则：
 * - 会话从打开的那一刻起接入（`open`），读取快照期间先缓存它的事件。缓存从接入时的全局游标之后是完整的
 *   （全局流尚未起流时，从起流的游标之后）。
 * - 快照到位（`ready(快照游标)`）后，丢弃游标 ≤ 快照游标的事件，按序交付之后的；快照游标早于缓存覆盖的起点时，
 *   中间的空档用补漏读取按 (快照游标, 起点] 分页补齐，补齐后再交付缓存。补漏期间新到的事件继续缓存。
 * - 之后到达的事件直接交付。每个会话交付的游标只增不减，保证不漏、不重、顺序正确。
 *
 * 全局流没有起点时（首次打开，或游标过期之后），第一个到位的快照游标就是起点：它是服务端当时的最新游标，
 * 从它起流不会回放无关的历史。游标过期时，已交付过快照的会话都要重读快照（`expired`），再以新快照调用 `ready`。
 */

/** 补漏读取的一页：会话在 (after, until] 中的事件，按 cursor 升序。 */
export interface EventRangePage {
  events: readonly AssistantPublicEvent[];
  hasMore: boolean;
}

export interface SessionFeedHandlers {
  /** 交付一条事件：按 cursor 升序，每条最多一次。 */
  deliver(event: AssistantPublicEvent): void;
  /**
   * 游标过期（全局流或补漏读取返回 409）：会话需要重读快照，再以新快照的游标调用 `ready`。
   * 只通知已调用过 `ready` 的会话；仍在读取快照的会话读完后照常调用 `ready` 即可。
   */
  expired(): void;
}

export interface EventRouterOptions {
  /** 补漏读取：会话在 (after, until] 中的事件，一页最多若干条，`hasMore` 时以本页最后一条续读。 */
  readRange(sessionId: string, after: number, until: number): Promise<EventRangePage>;
  /** 补漏读取的错误是否表示游标过期。 */
  isCursorExpired(error: unknown): boolean;
  /** 全局流有了起点（首次，或游标过期后的第一个快照），应从这个游标起流。 */
  onStart(cursor: number): void;
  /** 补漏读取失败（游标过期以外）后的重试间隔，缺省从 250ms 起翻倍、最长 3 秒。 */
  retryDelayMs?(attempt: number): number;
}

function defaultRetryDelay(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 3_000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 会话接入的阶段：等快照（缓存）→ 衔接（补漏，缓存）→ 直接交付；关闭后不再交付。 */
type FeedPhase = 'awaiting-snapshot' | 'joining' | 'live' | 'closed';

/** 一个会话在全局事件流上的接入，由 `GlobalEventRouter.open` 创建。 */
export class SessionEventFeed {
  private phase: FeedPhase = 'awaiting-snapshot';
  private buffer: AssistantPublicEvent[] = [];
  /** 已交付（或已包含在快照中）的最大游标。 */
  private delivered = 0;
  /** 每次重新衔接或过期时递增，使在途的补漏结果失效。 */
  private generation = 0;

  constructor(
    private readonly router: GlobalEventRouter,
    readonly sessionId: string,
    private readonly handlers: SessionFeedHandlers,
    /** 缓存从这个游标之后是完整的；null 表示全局流尚未起流，起流时取起点。 */
    private coveredFrom: number | null,
  ) {}

  /** 快照到位：以快照游标为水位衔接缓存与之后的事件。尚未起流时，以它为全局流的起点。 */
  ready(snapshotCursor: number): void {
    if (this.phase === 'closed') return;
    this.generation += 1;
    this.phase = 'joining';
    this.delivered = snapshotCursor;
    this.router.offer(snapshotCursor);
    void this.join(this.generation);
  }

  /** 会话关闭（最后一个呈现实例离开、重新读取或卸载）：不再缓存和交付。 */
  close(): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.buffer = [];
    this.router.remove(this);
  }

  /** @internal 全局流送来这个会话的一条事件（已按全局游标去重）。 */
  receive(event: AssistantPublicEvent): void {
    if (this.phase === 'live') this.deliverOne(event);
    else if (this.phase !== 'closed') this.buffer.push(event);
  }

  /** @internal 全局流以 cursor 为起点起流。 */
  streamStarted(cursor: number): void {
    if (this.coveredFrom === null) this.coveredFrom = cursor;
  }

  /** @internal 全局游标过期：缓存作废，回到等快照；已交付过快照的会话需要重读。 */
  expire(): void {
    if (this.phase === 'closed') return;
    const notify = this.phase !== 'awaiting-snapshot';
    this.generation += 1;
    this.phase = 'awaiting-snapshot';
    this.buffer = [];
    this.coveredFrom = null;
    if (notify) this.handlers.expired();
  }

  private async join(generation: number): Promise<void> {
    const current = () => this.generation === generation && this.phase !== 'closed';
    const until = this.coveredFrom;
    let after = this.delivered;
    let attempt = 0;

    // 快照游标早于缓存覆盖的起点：(快照游标, 起点] 之间的事件既不在快照里也不在缓存里，按页补齐。
    while (until !== null && after < until) {
      try {
        const page = await this.router.readRange(this.sessionId, after, until);
        if (!current()) return;
        for (const event of page.events) this.deliverOne(event);
        const last = page.events.at(-1);
        if (!page.hasMore || !last) break;
        after = Number(last.cursor);
        attempt = 0;
      } catch (error) {
        if (!current()) return;
        if (this.router.isCursorExpired(error)) {
          // 快照游标已被裁剪：重读快照后再衔接。缓存与覆盖起点仍然有效，继续缓存。
          this.generation += 1;
          this.phase = 'awaiting-snapshot';
          this.handlers.expired();
          return;
        }
        await delay(this.router.retryDelay(attempt));
        attempt += 1;
        if (!current()) return;
      }
    }

    // 补齐后按序交付缓存（其中游标 ≤ 已交付水位的丢弃），之后到达的直接交付。
    const buffered = this.buffer;
    this.buffer = [];
    this.phase = 'live';
    for (const event of buffered) this.deliverOne(event);
  }

  private deliverOne(event: AssistantPublicEvent): void {
    if (this.phase === 'closed') return;
    const cursor = Number(event.cursor);
    if (cursor <= this.delivered) return;
    this.delivered = cursor;
    this.handlers.deliver(event);
  }
}

/** 全局事件流的会话分发器：记下全局已处理游标，按会话分发，并协调起流与游标过期。 */
export class GlobalEventRouter {
  private current: number | null = null;
  private readonly feeds = new Map<string, Set<SessionEventFeed>>();

  constructor(private readonly options: EventRouterOptions) {}

  /** 全局已处理游标（断线后从这里续传）；null 表示尚未起流：还没有快照到位，或游标过期后等待新的快照。 */
  get cursor(): number | null {
    return this.current;
  }

  /** 会话开始读取快照时接入；之后收到的该会话事件先缓存，`ready` 后衔接。 */
  open(sessionId: string, handlers: SessionFeedHandlers): SessionEventFeed {
    const feed = new SessionEventFeed(this, sessionId, handlers, this.current);
    const feeds = this.feeds.get(sessionId) ?? new Set();
    feeds.add(feed);
    this.feeds.set(sessionId, feeds);
    return feed;
  }

  /** 全局流送来一条会话事件：按全局游标去重后交给该会话；没有打开的会话丢弃。 */
  dispatch(event: AssistantPublicEvent): void {
    const cursor = Number(event.cursor);
    if (this.current === null || cursor <= this.current) return;
    this.current = cursor;
    for (const feed of [...(this.feeds.get(event.assistantSessionId) ?? [])]) feed.receive(event);
  }

  /** 全局流的游标过期：全局游标作废，所有会话的缓存作废，已交付过快照的会话重读快照。 */
  expire(): void {
    this.current = null;
    for (const feeds of [...this.feeds.values()]) {
      for (const feed of [...feeds]) feed.expire();
    }
  }

  /** @internal 快照到位；尚未起流时以它为起点起流。 */
  offer(cursor: number): void {
    if (this.current !== null) return;
    this.current = cursor;
    for (const feeds of this.feeds.values()) {
      for (const feed of feeds) feed.streamStarted(cursor);
    }
    this.options.onStart(cursor);
  }

  /** @internal */
  remove(feed: SessionEventFeed): void {
    const feeds = this.feeds.get(feed.sessionId);
    feeds?.delete(feed);
    if (feeds?.size === 0) this.feeds.delete(feed.sessionId);
  }

  /** @internal */
  readRange(sessionId: string, after: number, until: number): Promise<EventRangePage> {
    return this.options.readRange(sessionId, after, until);
  }

  /** @internal */
  isCursorExpired(error: unknown): boolean {
    return this.options.isCursorExpired(error);
  }

  /** @internal */
  retryDelay(attempt: number): number {
    return (this.options.retryDelayMs ?? defaultRetryDelay)(attempt);
  }
}
